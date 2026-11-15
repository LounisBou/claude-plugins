// tests/deck-e2e.ts - the deck built once from this machine's real state, read-only.
//
//   node tests/deck-e2e.ts [--hooks <dir>] [--keep]
//
// NOT part of `run-tests.sh`: it reads the operator's real store, transcripts and prices,
// which a suite must never depend on. It runs the supervision (from `--hooks`, this
// checkout's hooks by default) over a $ spelled on node: every read reaches the real files,
// every write lands in memory, the deck's rename lands in a temporary file, and no removal
// runs. It prints how long a hook waits on the deck (one write, cold and once warm), then
// plays each listed session's own usage read in turn, as that session's process does, and
// prints the bytes the largest of them read cold. It checks every usage field's type, the
// periods' starts, the totals' sums, and one session's week against routing.py's cost.
import { execFile, execFileSync, type ExecFileException } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hostOf } from '../core/capture.ts'
import { fieldsOf } from '../core/host.ts'
import type { Deck, DeckPeriod, DeckSession, DeckUsage } from '../core/deck.ts'

const args = process.argv.slice(2)
const hooks = resolve((args.includes('--hooks') ? args[args.indexOf('--hooks') + 1] : undefined) ?? join(import.meta.dirname, '..', 'hooks'))
const keep = args.includes('--keep')
const out = mkdtempSync(join(process.env['TMPDIR'] || tmpdir(), 'deck-e2e-'))
const deckPath = join(out, 'deck.json')

const memory = new Map<string, string>()
let bytesRead = 0
const run = (argv: readonly string[], options?: { timeoutMs?: number }) => new Promise<{ exitCode: number; stdout: string; stderr: string }>(done => {
  const [cmd = '', ...rest] = argv
  if (cmd === 'sh' && String(argv[2]).includes('awk')) bytesRead += Number(argv[6])
  if (cmd === 'rm' || argv.some(a => a.endsWith('log-append.sh'))) return done({ exitCode: 0, stdout: '', stderr: '' })
  if (cmd === 'mv') {
    const [from = '', to = ''] = [argv[2], argv[3]]
    const text = memory.get(from)
    if (text === undefined) return done({ exitCode: 1, stdout: '', stderr: 'nothing to move' })
    memory.delete(from)
    if (to.endsWith('/deck.json')) writeFileSync(deckPath, text)
    else memory.set(to, text)
    return done({ exitCode: 0, stdout: '', stderr: '' })
  }
  execFile(cmd, rest, { encoding: 'utf8', maxBuffer: 1 << 30, timeout: options?.timeoutMs ?? 0 }, (err: ExecFileException | null, stdout: string, stderr: string) => {
    done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
  })
})

let sessionId = 'deck-e2e'
const $ = hostOf({
  session: { id: async () => sessionId, send: async () => ({ isDelivered: false as const, reason: 'read-only run' }) },
  env: { get: async (name: string) => process.env[name] },
  plugin: { root: resolve(hooks, '..') },
  fs: {
    read: async (p: string) => (memory.has(p) ? memory.get(p)! : readFileSync(p, 'utf8')),
    write: async (p: string, text: string) => { memory.set(p, text) },
    exists: async (p: string) => memory.has(p) || existsSync(p),
    list: async (dir: string) => readdirSync(dir, { withFileTypes: true }).map(e => {
      const stat = statSync(join(dir, e.name), { throwIfNoEntry: false })
      return { name: e.name, kind: e.isDirectory() ? 'dir' as const : 'file' as const, size: stat?.size ?? 0, isLink: e.isSymbolicLink(), mtimeMs: stat?.mtimeMs ?? 0 }
    }),
    stat: async (p: string, options?: { resolve: boolean }) => {
      const stat = statSync(p)
      return { kind: stat.isDirectory() ? 'dir' as const : 'file' as const, size: stat.size, mtimeMs: stat.mtimeMs, ...(options?.resolve ? { realPath: realpathSync(p) } : {}) }
    },
  },
  process: { run },
})

// The supervision under test, from `--hooks`: the same module as this checkout's, at another place.
const { writeDeck, refreshUsage, readSessions }: typeof import('../hooks/supervision.ts') = await import(join(hooks, 'supervision.ts'))
const timed = async () => {
  const start = performance.now()
  await writeDeck($)
  return Math.round(performance.now() - start)
}
const cold = await timed()
const warm = await timed()
process.stdout.write(`a hook waits on the deck: ${cold} ms cold, ${warm} ms warm (${hooks})\n`)

// Each listed session's process books its own transcripts: played here one after the other,
// each from a cold book, its row written in memory.
const rows = await readSessions($)
let largest = { bytes: 0, id: '' }
for (const [key, row] of Object.entries(rows)) {
  if (!['coordinator', 'orchestrator', 'agent'].includes(String(row.role))) continue
  sessionId = key.slice('sessions/'.length)
  bytesRead = 0
  await refreshUsage($)
  if (bytesRead > largest.bytes) largest = { bytes: bytesRead, id: sessionId }
}
sessionId = 'deck-e2e'
await writeDeck($)
process.stdout.write(`one process reads cold at most ${largest.bytes} bytes (session ${largest.id})\n`)

let failures = 0
const check = (name: string, ok: boolean) => {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n`)
  if (!ok) failures++
}
// The deck as written: its fields' types are what the checks below hold it to.
const deck: Deck = JSON.parse(readFileSync(deckPath, 'utf8'))
const iso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v
const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
const period = (value: unknown): boolean => {
  const p = fieldsOf(value)
  const tokens = fieldsOf(p?.['tokens'])
  const cost = p?.['cost_usd']
  return Boolean(p) && iso(p?.['from']) && ['input', 'output', 'cache_read', 'cache_write'].every(k => count(tokens?.[k]))
    && Object.keys(tokens ?? {}).length === 4 && (cost === null || (typeof cost === 'number' && cost >= 0))
}
const usage = (value: unknown): boolean => { const u = fieldsOf(value); return Boolean(u) && period(u?.['day']) && period(u?.['week']) && iso(u?.['at']) }
// A remote session's machine: only an orchestrator's row carries one.
const machineOf = (s: DeckSession) => ('machine' in s ? s.machine : null)
type Read = DeckSession & { usage: DeckUsage }
const hasUsage = (s: DeckSession): s is Read => s.usage !== null

if (deck.version >= 2) {
  const sessions: DeckSession[] = [
    ...(deck.coordinator ? [deck.coordinator] : []),
    ...deck.orchestrators.flatMap(o => [o, ...o.agents]),
    ...deck.unattached_agents,
  ]
  const local = sessions.filter(s => !machineOf(s))
  check(`${sessions.length} sessions, each usage null or well typed`, sessions.every(s => s.usage === null || usage(s.usage)))
  check('a remote session carries null', sessions.filter(s => machineOf(s)).every(s => s.usage === null))
  check(`${local.filter(s => s.usage).length} local sessions read from their transcripts`, local.some(s => s.usage))
  check('the totals are well typed', usage(deck.usage_totals))
  check('the basis is the contract\'s', JSON.stringify(deck.usage_basis) === '{"currency":"USD","prices":"api-list-equivalent","timezone":"Europe/Paris"}')
  for (const name of ['day', 'week'] as const) {
    const read: DeckPeriod[] = local.filter(hasUsage).map(s => s.usage[name])
    const total = deck.usage_totals[name]
    const kinds = ['input', 'output', 'cache_read', 'cache_write'] as const
    check(`the ${name}'s tokens are the sessions' sum`, kinds.every(k => total.tokens[k] === read.reduce((a, p) => a + p.tokens[k], 0)))
    const cost = read.some(p => p.cost_usd === null) ? null : read.reduce((a, p) => a + (p.cost_usd ?? 0), 0)
    check(`the ${name}'s cost is the sessions' sum (${total.cost_usd === null ? 'null' : total.cost_usd.toFixed(2)} USD)`,
      cost === null ? total.cost_usd === null : total.cost_usd !== null && Math.abs(total.cost_usd - cost) < 1e-9)
    check(`every ${name} starts where the totals' does`, read.length === 0 || read.every(p => p.from === total.from))
  }
  const starts = parisStarts(Date.parse(deck.generated_at))
  check(`the day starts at Paris midnight today (${starts.day})`, deck.usage_totals.day.from === starts.day)
  check(`the week starts at Paris midnight this Monday (${starts.week})`, deck.usage_totals.week.from === starts.week)
  const read = local.filter(hasUsage)
  check('each session\'s day is within its week, token by token',
    read.every(s => (['input', 'output', 'cache_read', 'cache_write'] as const).every(k => s.usage.day.tokens[k] <= s.usage.week.tokens[k])))
  againstRouting(read, Date.parse(starts.week))
} else {
  process.stdout.write(`  deck version ${deck.version}: no usage to check\n`)
}

// Paris midnight of the deck's day and of its ISO week's Monday, found without usage.ts: the
// offset that puts the wall clock at 00:00 on that calendar date.
function parisStarts(now: number): { day: string; week: string } {
  const wall = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
  const parts = Object.fromEntries(wall.formatToParts(new Date(now)).map(p => [p.type, p.value]))
  const back = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts['weekday'] ?? '')
  const midnight = (y: number, m: number, d: number) => {
    const date = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
    for (const offset of ['+01:00', '+02:00']) {
      const at = Date.parse(`${date}T00:00:00${offset}`)
      const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(at))
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(at))
      if (hour === '00' && day === date) return new Date(at).toISOString()
    }
    return 'none'
  }
  const [y, m, d] = [Number(parts['year']), Number(parts['month']), Number(parts['day'])]
  return { day: midnight(y, m, d), week: midnight(y, m, d - back) }
}

// One listed session whose every message falls in this week, its files quiet: its week cost
// is routing.py's cost of its whole transcripts. Skipped, with the reason, when none is.
function againstRouting(sessions: Read[], weekStart: number) {
  const projects = join(process.env['CLAUDE_CONFIG_DIR'] || join(process.env['HOME'] || '', '.claude'), 'projects')
  const filesOf = (id: string) => {
    for (const dir of readdirSync(projects)) {
      const main = join(projects, dir, `${id}.jsonl`)
      if (!existsSync(main)) continue
      const sub = join(projects, dir, id, 'subagents')
      return [main, ...(existsSync(sub) ? readdirSync(sub).filter(n => n.endsWith('.jsonl')).map(n => join(sub, n)) : [])]
    }
    return []
  }
  const inWeek = (files: string[]) => files.every(f => readFileSync(f, 'utf8').split('\n').every(line => {
    if (!line.includes('"usage"')) return true
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== 'assistant' || !entry.message?.usage) return true
      return Date.parse(entry.timestamp) >= weekStart
    } catch {
      return true
    }
  }))
  const sizes = (files: string[]) => files.map(f => statSync(f).size).join(',')
  const candidates = sessions.map(s => ({ s, files: filesOf(s.key.slice('sessions/'.length)) }))
    .filter(c => c.files.length > 0)
    .sort((a, b) => Math.max(...a.files.map(f => statSync(f).mtimeMs)) - Math.max(...b.files.map(f => statSync(f).mtimeMs)))
  const chosen = candidates.find(c => inWeek(c.files))
  if (!chosen) {
    process.stdout.write('  skip routing.py: no listed session has its whole transcript in this week\n')
    return
  }
  const before = sizes(chosen.files)
  const routing = join(hooks, '..', 'skills', 'model-routing', 'scripts', 'routing.py')
  const id = chosen.s.key.slice('sessions/'.length)
  const answer: { cost_usd: number | null } = JSON.parse(execFileSync('python3', [routing, 'cost', '--json', '--session', id], { encoding: 'utf8' }))
  if (sizes(chosen.files) !== before) {
    process.stdout.write(`  skip routing.py: session ${id} wrote to its transcript meanwhile\n`)
    return
  }
  const week = chosen.s.usage.week
  const same = week.cost_usd === null ? answer.cost_usd === null
    : answer.cost_usd !== null && Math.abs(week.cost_usd - answer.cost_usd) < 1e-6
  check(`session ${chosen.s.name}'s week costs routing.py's (${week.cost_usd} vs ${answer.cost_usd})`, same)
}

if (keep) process.stdout.write(`kept: ${deckPath}\n`)
else rmSync(out, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
