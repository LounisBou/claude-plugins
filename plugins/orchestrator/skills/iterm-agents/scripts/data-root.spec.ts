// The launcher on the two roots of the orchestrator's state: with the protected root's data-root
// file placing the data elsewhere, what any session writes (the chains, close.log, the module's
// store) lands in the data root, and what runs (the venv, the server catalogue, the tier map, the
// launch files) is read on the protected root alone, whatever the data root holds.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DATA_ROOT_FILE, DATA_ROOT_VERSION } from '../../../core/orchestration.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(HERE, 'iterm-agent.sh')
const rootFile = (dir: string): string => JSON.stringify({ version: DATA_ROOT_VERSION, dir })

/** A bench: a protected root whose data-root file names a data root, each holding what the test plants. */
function bench(): { work: string; protectedRoot: string; data: string; env: NodeJS.ProcessEnv } {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'data-root-')))
  const protectedRoot = join(work, 'protected')
  const data = join(work, 'data')
  const config = join(work, 'config')
  for (const dir of [join(protectedRoot, 'venv', 'bin'), join(data, 'chains'), join(config, 'claude-orchestrator'), join(work, 'bin'), join(work, 'projects')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(protectedRoot, DATA_ROOT_FILE), rootFile(data))
  writeFileSync(join(config, 'claude-orchestrator', DATA_ROOT_FILE), rootFile(join(work, 'module')))
  writeFileSync(join(work, 'bin', 'host-cli'), '#!/bin/sh\n')
  chmodSync(join(work, 'bin', 'host-cli'), 0o755)
  writeFileSync(join(work, 'trust.json'), JSON.stringify({ projects: { [work]: { hasTrustDialogAccepted: true } } }))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: work, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: 's-dry',
    ORCHESTRATOR_STATE_DIR: protectedRoot, ORCHESTRATOR_HOST_CLI: join(work, 'bin', 'host-cli'),
    ORCHESTRATOR_TRUST_FILE: join(work, 'trust.json'), ORCHESTRATOR_PROJECTS_DIR: join(work, 'projects'),
    ORCHESTRATOR_LOGIN_SHELL: '/bin/sh', ORCHESTRATOR_DRY_RUN: '1', ORCHESTRATOR_SELF_TTY: '/dev/ttys900', ORCHESTRATOR_SELF_ID: 'S-ME',
  }
  return { work, protectedRoot, data, env }
}

/** An executable file at `path`. */
function script(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

describe('the launcher on a data root placed apart', () => {
  it('runs the protected venv, reads the protected catalogue and tier map, and the chain of the data root', () => {
    const b = bench()
    const ran = join(b.work, 'ran')
    // The protected venv: a stand-in that says it ran, then runs the interpreter of the machine.
    script(join(b.protectedRoot, 'venv', 'bin', 'python'), `#!/bin/sh\necho protected >> '${ran}'\nexec python3 "$@"\n`)
    writeFileSync(join(b.protectedRoot, 'mcp.json'), JSON.stringify({ servers: { a: { command: 'a-cmd' } }, default: ['a'] }))
    writeFileSync(join(b.protectedRoot, 'models.json'), JSON.stringify({ deep: '', standard: '', light: 'a-model/low' }))
    // What a session could plant in the data root, under the names of what the spawn runs or reads.
    script(join(b.data, 'venv', 'bin', 'python'), `#!/bin/sh\necho planted >> '${ran}'\nexit 1\n`)
    writeFileSync(join(b.data, 'mcp.json'), JSON.stringify({ servers: { evil: { command: 'evil-cmd' } }, default: ['evil'] }))
    writeFileSync(join(b.data, 'models.json'), JSON.stringify({ deep: '', standard: '', light: 'evil-model/max' }))
    // The chains are data: the anchor is read from the data root's, never from one left on the protected root.
    writeFileSync(join(b.data, 'chains', 'ttys900.jsonl'), '{"tab_id":"t-1","tty":"/dev/ttys901","owner":"S-ME"}\n{"tab_id":"t-2","tty":"/dev/ttys902","owner":"S-ME"}\n')
    mkdirSync(join(b.protectedRoot, 'chains'))
    writeFileSync(join(b.protectedRoot, 'chains', 'ttys900.jsonl'), '{"tab_id":"t-7","tty":"/dev/ttys907","owner":"S-ME"}\n')
    const spawn = spawnSync('bash', [LAUNCHER, 'spawn', '--dir', b.work, '--tier', 'light', '--title', 'Agent: a', '--prompt', 'p', '--right-of', 'self'], { env: b.env, encoding: 'utf8' })
    assert.equal(spawn.status, 0, spawn.stderr)
    const said = new Map(spawn.stdout.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    assert.equal(readFileSync(ran, 'utf8'), 'protected\n')
    assert.equal(said.get('mcp'), 'a')
    assert.match(said.get('launch') ?? '', /--model a-model --effort low /)
    assert.doesNotMatch(spawn.stdout, /evil/)
    assert.equal(said.get('anchor'), '/dev/ttys902')
    assert.ok(said.get('prompt_file')?.startsWith(join(b.protectedRoot, 'prompts', 'prompt-Agent--a-')), said.get('prompt_file'))
    assert.ok(said.get('mcp_file')?.startsWith(join(b.protectedRoot, 'prompts', 'mcp-Agent--a-')), said.get('mcp_file'))
  })

  it('writes the chains and close.log under the data root, and places the module\'s store under the config dir\'s', () => {
    const b = bench()
    const probe = [
      'import json, iterm_agent as m',
      'm.chain_store("append", "/dev/ttys900", "t-9", "/dev/ttys909", "S-ME")',
      'm.close_log("probe", "a line", echo=False)',
      'm.auditor_record_write("/dev/ttys901", "s-a", "L")',
      // The usage readings a spawn's configuration is read from: listed on the protected root.
      'listed, listdir = [], m.os.listdir',
      'm.os.listdir = lambda d: (listed.append(d), listdir(d))[1]',
      'm.quota_room()',
      'm.os.listdir = listdir',
      'print(json.dumps({"data": m.DATA_DIR, "module": m.module_dir(), "prompts": m.PROMPTS_DIR, "catalogue": m.MCP_CATALOGUE, "ended": m.home_end_marker("sock"), "quota": listed}))',
    ].join('\n')
    const run = spawnSync('python3', ['-c', probe], { env: { ...b.env, PYTHONPATH: HERE, ORCHESTRATOR_ADAPTER_NODE: process.execPath }, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1) ?? ''), {
      data: b.data, module: join(b.work, 'module'), prompts: join(b.protectedRoot, 'prompts'), catalogue: join(b.protectedRoot, 'mcp.json'),
      ended: join(b.data, 'home-ended', 'sock'), quota: [join(b.protectedRoot, 'quota')],
    })
    assert.ok(existsSync(join(b.data, 'auditors', 'ttys901.json')))
    assert.match(readFileSync(join(b.data, 'chains', 'ttys900.jsonl'), 'utf8'), /"tty": ?"\/dev\/ttys909"/)
    assert.match(readFileSync(join(b.data, 'close.log'), 'utf8'), /probe: a line\n$/)
    assert.deepEqual(['chains', 'close.log', 'auditors'].map(name => existsSync(join(b.protectedRoot, name))), [false, false, false])
  })

  it('keeps the data on the protected root when its data-root file names no absolute directory', () => {
    const b = bench()
    const texts = ['{', '[]', JSON.stringify({ version: 2, dir: b.data }), rootFile('relative'), rootFile('/'), rootFile('/x\ny'), JSON.stringify({ version: true, dir: b.data }), rootFile(`${b.data}//`)]
    const roots = texts.map((text, i) => {
      const root = join(b.work, `root-${i}`)
      mkdirSync(root)
      writeFileSync(join(root, DATA_ROOT_FILE), text)
      return root
    })
    const run = spawnSync('python3', ['-c', 'import json, sys, iterm_agent as m; print(json.dumps([m.data_root_of(r) for r in sys.argv[1:]]))', ...roots], { env: { ...b.env, PYTHONPATH: HERE }, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), [...roots.slice(0, -1), b.data])
  })
})

/** `python3 -c <probe>` in the launcher's directory, under a bench's environment. */
function python(b: { env: NodeJS.ProcessEnv }, probe: string): ReturnType<typeof spawnSync> {
  return spawnSync('python3', ['-c', probe], { env: { ...b.env, PYTHONPATH: HERE, ORCHESTRATOR_ADAPTER_NODE: process.execPath }, encoding: 'utf8' })
}

describe('the launcher with files planted in the data root', () => {
  it('reads the tier map, the sleepers\' record and the coordinator\'s on the protected root: the same names planted in the data root change nothing', () => {
    const b = bench()
    const record = (name: string, config: string): string => JSON.stringify([{ name, config }])
    writeFileSync(join(b.protectedRoot, 'sleeping.json'), record('Orch: slept', '/protected/config'))
    writeFileSync(join(b.data, 'sleeping.json'), record('Orch: slept', '/planted/config'))
    writeFileSync(join(b.protectedRoot, 'coordinator.json'), JSON.stringify({ name: 'Coord: real', tty: '/dev/ttys900' }))
    writeFileSync(join(b.data, 'coordinator.json'), JSON.stringify({ name: 'Coord: planted', tty: '/dev/ttys901' }))
    const run = python(b, [
      'import json, iterm_agent as m',
      'print(json.dumps([m.sleeper_config("Orch: slept"), m.registered_coord_on("/dev/ttys900"), m.registered_coord_on("/dev/ttys901")]))',
    ].join('\n'))
    assert.equal(run.status, 0, String(run.stderr))
    assert.deepEqual(JSON.parse(String(run.stdout).trim().split('\n').at(-1) ?? ''), ['/protected/config', 'Coord: real', null])
  })

  it('chooses a spawn\'s plan from the quota files of the protected root alone', () => {
    const b = bench()
    const quota = (account: string, config: string, used: number): string => JSON.stringify({
      version: 1, account, config, at: `${new Date().toISOString().slice(0, 19)}Z`,
      five_hour: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    })
    const home = b.env['HOME'] ?? ''
    // Plan 2's directory under the home, as the launcher names it.
    const plan2 = String(python(b, 'import iterm_agent as m\nprint(m.PLAN2_DIRNAME)').stdout).trim()
    mkdirSync(join(b.protectedRoot, 'quota'))
    mkdirSync(join(b.data, 'quota'))
    writeFileSync(join(b.protectedRoot, 'quota', 'a.json'), quota('a', join(home, '.claude'), 90))
    writeFileSync(join(b.protectedRoot, 'quota', 'b.json'), quota('b', join(home, plan2), 10))
    // Planted: plan 1 full of room, newer than the real reading.
    writeFileSync(join(b.data, 'quota', 'c.json'), quota('c', join(home, '.claude'), 0))
    const run = python(b, 'import json, iterm_agent as m\nprint(json.dumps(m.quota_room()))')
    assert.equal(run.status, 0, String(run.stderr))
    assert.deepEqual(JSON.parse(String(run.stdout).trim().split('\n').at(-1) ?? ''), { '1': 10, '2': 90 })
  })

  it('refuses a link planted at a file or a directory it writes in the data root, and leaves what the link points at untouched', () => {
    const b = bench()
    const target = join(b.work, 'protected-file')
    writeFileSync(target, 'protected\n')
    symlinkSync(target, join(b.data, 'close.log'))
    mkdirSync(join(b.work, 'elsewhere'))
    symlinkSync(join(b.work, 'elsewhere'), join(b.data, 'home-ended'))
    const run = python(b, [
      'import json, os, iterm_agent as m',
      'm.close_log("probe", "a line", echo=False)',
      'refused = []',
      'for path in (os.path.join(m.DATA_DIR, "close.log"), m.home_end_marker("sock")):',
      '    try:',
      '        os.close(m.open_data_file(path, os.O_WRONLY | os.O_CREAT))',
      '        refused.append(False)',
      '    except OSError:',
      '        refused.append(True)',
      'print(json.dumps(refused))',
    ].join('\n'))
    assert.equal(run.status, 0, String(run.stderr))
    assert.deepEqual(JSON.parse(String(run.stdout).trim().split('\n').at(-1) ?? ''), [true, true])
    assert.equal(readFileSync(target, 'utf8'), 'protected\n')
    assert.equal(existsSync(join(b.work, 'elsewhere', 'sock')), false)
  })

  it('still writes close.log and the end marker where no link was planted, the data root itself being a link', () => {
    const b = bench()
    const linked = join(b.work, 'data-link')
    symlinkSync(b.data, linked)
    writeFileSync(join(b.protectedRoot, DATA_ROOT_FILE), rootFile(linked))
    const run = python(b, [
      'import os, iterm_agent as m',
      'm.close_log("probe", "kept", echo=False)',
      'os.makedirs(os.path.dirname(m.home_end_marker("sock")), exist_ok=True)',
      'os.close(m.open_data_file(m.home_end_marker("sock"), os.O_WRONLY | os.O_CREAT))',
    ].join('\n'))
    assert.equal(run.status, 0, String(run.stderr))
    assert.match(readFileSync(join(b.data, 'close.log'), 'utf8'), /probe: kept\n$/)
    assert.ok(existsSync(join(b.data, 'home-ended', 'sock')))
  })
})
