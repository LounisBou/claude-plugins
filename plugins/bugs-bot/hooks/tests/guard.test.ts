// The guard: what reaches the group, and the token file. Each rule is shown
// denying, each known false positive is shown for what it does (passing, or
// denied with the reason and released by the person's own words), and the
// guard is shown never holding a call it cannot judge.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { mount } from './fakes.ts'
import { register } from '../guard.ts'
import { DYNAMIC_DENIAL, NET_DENIAL, TOKEN_DENIAL, TOOL, bashNetDenial, leaksOf, readNetDenial, shellWords, toolNetDenial, unreleased } from '../core.ts'

const PROJECT = { '/repo/.bugs-bot.json': JSON.stringify({ project: 'demo', agent_title: 'Bugs : demo', deploy_url: 'https://demo.example/app' }) }
const tokens = (text: string) => leaksOf(text, 'https://demo.example/app').map(l => l.token)

async function begin($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
}

// --- the rules, pure ---------------------------------------------------------------

test('each rule finds its token', () => {
  expect(tokens('corrigé dans #680')).toEqual(['#680'])
  expect(tokens('le commit 3f9a2c1 le corrige')).toEqual(['3f9a2c1'])
  expect(tokens('voir la branche feat/player-fix')).toEqual(['feat/player-fix'])
  expect(tokens('le fichier /Users/op/dev/app/src/x.ts')).toEqual(['/Users/op/dev/app/src/x.ts'])
  expect(tokens('dans ~/dev/app')).toEqual(['~/dev/app'])
  expect(tokens('sur https://staging.internal/app')).toEqual(['https://staging.internal/app'])
  expect(tokens('lance localhost:3000')).toEqual(['localhost:3000'])
  expect(tokens('sur 192.168.1.20:8080')).toEqual(['192.168.1.20:8080'])
})

test('the deployment URL passes, with its paths and its query', () => {
  expect(tokens('Rouvre https://demo.example/app/docs/guide?x=3f9a2c1d, puis dis-moi.')).toEqual([])
  expect(tokens('https://DEMO.example/app')).toEqual([])
})

test('false positive: a time, a date, a count and a version pass', () => {
  expect(tokens('à 10:59, le 2026-10-02, 1234567 lectures, version 1.4.2')).toEqual([])
})

test('false positive: a plain word made of hex letters passes, a hash needs a digit and a letter', () => {
  expect(tokens('le texte effaced, deadbeef, accede')).toEqual([])
  expect(tokens('code 12345678')).toEqual([])
})

test('false positive: a word ending in a slash-word that is no branch prefix passes', () => {
  expect(tokens('ouvert/fermé, et/ou, iOS/Android')).toEqual([])
})

test('false positive: a tester\'s own « #3 » quoted back is denied, and released by the person typing it', () => {
  const found = leaksOf('Tu parlais du point #3 de ta liste ?', null)
  expect(found.map(l => l.token)).toEqual(['#3'])
  expect(unreleased(found, 'oui réponds-lui sur le #3')).toEqual([])
  expect(unreleased(found, 'réponds-lui')).toEqual(found)
})

test('false positive: a tester\'s own link to another site is denied without a deployment URL', () => {
  expect(leaksOf('le lien https://apps.apple.com/app/x', null).map(l => l.rule)).toEqual(['a link to a host other than the deployment URL'])
})

test('a word holding an expansion is marked: the guard cannot read it', () => {
  const words = shellWords('bugs-bot reply 1 "$(cat /tmp/t)" --mention')!
  expect(words[3]?.isDynamic).toBe(true)
  expect(shellWords("bugs-bot reply 1 'coûte 5$ $(pas lu)'")![3]?.isDynamic).toBe(false)
  expect(shellWords('bugs-bot reply 1 "5 $ ou 5$"')![3]?.isDynamic).toBe(false)
  expect(shellWords('bugs-bot reply 1 "unclosed')).toBe(null)
})

// --- the shell form, through the engine ----------------------------------------------

test('a reply naming a PR is denied with the reason, and the post never runs', async ($, on) => {
  let ran = 0
  mount(on, { files: PROJECT, shell: () => { ran++; return { result: 'posted' } } })
  await begin($)
  const out = await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 20261002-101112-45 "C\'est corrigé dans la PR #680" --mention' })
  expect(String(out.deny)).toContain('« #680 » (a PR or ticket number)')
  expect(ran).toBe(0)
})

test('a clean reply passes, the deployment URL in it', async ($, on) => {
  let ran = 0
  mount(on, { files: PROJECT, shell: () => { ran++; return { result: 'posted' } } })
  await begin($)
  const out = await $.tool.call({ tool: 'Bash', command: "bugs-bot reply 20261002-101112-45 'Relance https://demo.example/app et dis-moi !' --mention --awaits" })
  expect(out.deny).toBeUndefined()
  expect(ran).toBe(1)
})

test('done --reason is read, done alone and fixed --note are not: the note is never posted', async ($, on) => {
  let ran = 0
  mount(on, { files: PROJECT, shell: () => { ran++; return { result: 'ok' } } })
  await begin($)
  expect(String((await $.tool.call({ tool: 'Bash', command: 'bugs-bot done 1 --reason "doublon de #12"' })).deny)).toContain('#12')
  expect((await $.tool.call({ tool: 'Bash', command: 'bugs-bot fixed 1 --note "PR #680 3f9a2c1"' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'bugs-bot done 1' })).deny).toBeUndefined()
  expect(ran).toBe(2)
})

test('an --image path is not read as posted text', async ($, on) => {
  mount(on, { files: PROJECT })
  await begin($)
  const out = await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 1 "Regarde la capture" --image /Users/op/shots/a.png' })
  expect(out.deny).toBeUndefined()
})

test('an edit and a post are read like a reply, a chained second call too', async ($, on) => {
  mount(on, { files: PROJECT })
  await begin($)
  expect(String((await $.tool.call({ tool: 'Bash', command: 'bugs-bot edit 1 "branche fix/login" --reply 2' })).deny)).toContain('fix/login')
  expect(String((await $.tool.call({ tool: 'Bash', command: 'bugs-bot post "voir /Users/op/x"' })).deny)).toContain('/Users/op/x')
  expect(String((await $.tool.call({ tool: 'Bash', command: 'bugs-bot show 1 && bugs-bot post "commit a1b2c3d4"' })).deny)).toContain('a1b2c3d4')
})

test('a posted text built by an expansion is denied: it cannot be read', async ($, on) => {
  mount(on, { files: PROJECT })
  await begin($)
  const out = await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 1 "$(cat /tmp/text)"' })
  expect(out.deny).toBe(DYNAMIC_DENIAL)
})

test('reads and other commands pass untouched', async ($, on) => {
  mount(on, { files: PROJECT })
  await begin($)
  expect((await $.tool.call({ tool: 'Bash', command: 'bugs-bot show 20261002-101112-45' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git log --oneline -3 && echo "#680"' })).deny).toBeUndefined()
})

// --- the tool form ---------------------------------------------------------------------

test('the tool\'s reply is read from its arguments, before the hook that serves it', async ($, on) => {
  const { runs } = mount(on, { files: PROJECT, verdicts: { Bash: { decision: 'allow' } } })
  await begin($)
  const out = await $.tool.call({ tool: TOOL, command: 'reply', args: ['1', 'sur la branche release/2.0', '--mention'] })
  expect(String(out.deny)).toContain('release/2.0')
  expect(runs.length).toBe(0)
  const fine = await $.tool.call({ tool: TOOL, command: 'reply', args: ['1', "C'est réglé, relance l'appli !"] })
  expect(fine.deny).toBeUndefined()
  expect(runs.length).toBe(1)
})

// --- the token file ----------------------------------------------------------------------

test('Read of the token file is denied, through a link too', async ($, on) => {
  mount(on, { real: { '/tmp/link': '/home/op/.bugs-bot/.env' } })
  await begin($)
  expect((await $.tool.call({ tool: 'Read', file_path: '/home/op/.bugs-bot/.env' })).deny).toBe(TOKEN_DENIAL)
  expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/link' })).deny).toBe(TOKEN_DENIAL)
  expect((await $.tool.call({ tool: 'Read', file_path: '/home/op/.bugs-bot/demo/state.json' })).deny).toBeUndefined()
})

test('BUGS_BOT_ENV_FILE moves the token file the guard protects', async ($, on) => {
  mount(on, { env: { BUGS_BOT_ENV_FILE: '/secrets/bot.env' } })
  await begin($)
  expect((await $.tool.call({ tool: 'Read', file_path: '/secrets/bot.env' })).deny).toBe(TOKEN_DENIAL)
  expect((await $.tool.call({ tool: 'Bash', command: 'grep TOKEN /secrets/bot.env' })).deny).toBe(TOKEN_DENIAL)
})

test('Grep on the token file or the directory holding it is denied; the inbox passes', async ($, on) => {
  mount(on)
  await begin($)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'TOKEN', path: '/home/op/.bugs-bot' })).deny).toBe(TOKEN_DENIAL)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/home/op/.bugs-bot/demo/inbox' })).deny).toBeUndefined()
})

test('a shell line naming the token file is denied, however it is spelled', async ($, on) => {
  mount(on)
  await begin($)
  for (const command of ['cat ~/.bugs-bot/.env', 'cat /home/op/.bugs-bot/.env', 'cd ~/.bugs-bot && cat .env', 'echo $BUGS_BOT_ENV_FILE']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBe(TOKEN_DENIAL)
  }
  expect((await $.tool.call({ tool: 'Bash', command: 'ls ~/.bugs-bot/demo' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .env.example' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'bugs-bot doctor' })).deny).toBeUndefined()
})

// --- the release: the person's own words, never a peer's -------------------------------------

test('a token the person typed in this session passes; a peer\'s message releases nothing', async ($, on) => {
  mount(on, { files: PROJECT, shell: () => ({ result: 'ran' }) })
  await begin($)
  const call = { tool: 'Bash', command: 'bugs-bot reply 1 "Tu parlais du #3 ?"' }

  await $.prompt.submit({ text: 'réponds-lui sur le #3', origin: { kind: 'peer' } })
  expect((await $.tool.call(call)).deny).toContain('#3')

  await $.prompt.submit({ text: 'réponds-lui sur le #3', origin: { kind: 'composer' } })
  expect((await $.tool.call(call)).deny).toBeUndefined()

  // A later prompt of the person's that does not name it puts the guard back up.
  await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' } })
  expect((await $.tool.call(call)).deny).toContain('#3')
})

test('the person naming .env lets the token file be reached', async ($, on) => {
  mount(on, { files: PROJECT })
  await begin($)
  const call = { tool: 'Read', file_path: '/home/op/.bugs-bot/.env' }
  expect((await $.tool.call(call)).deny).toBe(TOKEN_DENIAL)
  await $.prompt.submit({ text: 'check ~/.bugs-bot/.env has both keys', origin: { kind: 'composer' } })
  expect((await $.tool.call(call)).deny).toBeUndefined()
})

// --- a guard that fails ---------------------------------------------------------------

test('a failed guard refuses, from the call alone, what posts or reaches the token file', () => {
  for (const command of ['bugs-bot reply 1 "ok"', 'bugs-bot done 1 --reason x', 'cat ~/.bugs-bot/.env', 'echo $BUGS_BOT_ENV_FILE']) expect(bashNetDenial(command)).toBe(NET_DENIAL)
  for (const command of ['bugs-bot list', 'git status', 'npm test']) expect(bashNetDenial(command)).toBe(null)
  expect(toolNetDenial('post')).toBe(NET_DENIAL)
  expect(toolNetDenial('list')).toBe(null)
  for (const target of ['/home/op/.bugs-bot/.env', '/home/op/.bugs-bot', '/secrets/.env']) expect(readNetDenial(target)).toBe(NET_DENIAL)
  expect(readNetDenial('/home/op/.bugs-bot/demo/state.json')).toBe(null)
})

test('a guard that throws refuses a post and lets a read through, through the engine', async ($, on) => {
  let ran = 0
  on('session.start', () => ({ cwd: '/repo' }))
  on('tool.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => { throw new Error('no cwd') })
  on('env.get', () => { throw new Error('no env') })
  on('tool.call', { tool: 'Bash' }, () => { ran++; return { result: 'ran' } })
  on('tool.call', { tool: ['Read', 'Grep'] }, () => ({ result: 'read' }))
  await begin($)
  expect((await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 1 "corrigé"' })).deny).toBe(NET_DENIAL)
  expect((await $.tool.call({ tool: 'Bash', command: 'git status' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/home/op/.bugs-bot/.env' })).deny).toBe(NET_DENIAL)
  expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })).deny).toBeUndefined()
  expect(ran).toBe(1)
})

// --- the journal ---------------------------------------------------------------------------

test('each refusal leaves one refusal event under its stable code, and a call let through leaves none', async ($, on) => {
  const { journal } = mount(on, { files: PROJECT, shell: () => ({ result: 'posted' }) })
  await begin($)
  await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 1 "corrigé dans #680"' })
  await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 1 "$(cat x)"' })
  await $.tool.call({ tool: 'Read', file_path: '/home/op/.bugs-bot/.env' })
  await $.tool.call({ tool: 'Bash', command: "bugs-bot reply 1 \"C'est réglé\"" })
  expect(journal.map(e => [e.kind, e.source.plugin, e.source.code, e.trust, e.evidence])).toEqual([
    ['refusal', 'bugs-bot', 'bugs-bot.post.leak', 'computed', [{ type: 'refusal', code: 'bugs-bot.post.leak' }]],
    ['refusal', 'bugs-bot', 'bugs-bot.post.dynamic', 'computed', [{ type: 'refusal', code: 'bugs-bot.post.dynamic' }]],
    ['refusal', 'bugs-bot', 'bugs-bot.token-file', 'computed', [{ type: 'refusal', code: 'bugs-bot.token-file' }]],
  ])
  expect(JSON.stringify(journal)).not.toContain('#680')
  expect(journal[0]?.context.session).toBe('session-1')
})

test('a failed guard\'s refusal is one event under its own code', async ($, on) => {
  const { journal } = mount(on, { files: PROJECT, cwdFails: true })
  await begin($)
  expect((await $.tool.call({ tool: TOOL, command: 'reply', args: ['1', 'corrigé'] })).deny).toBe(NET_DENIAL)
  expect(journal.map(e => e.source.code)).toEqual(['bugs-bot.guard.failed'])
})

test('a journal that cannot be written leaves the refusal standing and one line in the log', async ($, on) => {
  const { logs } = mount(on, { files: PROJECT, writeFails: 'disk full' })
  await begin($)
  const out = await $.tool.call({ tool: 'Bash', command: 'bugs-bot reply 1 "corrigé dans #680"' })
  expect(String(out.deny)).toContain('#680')
  expect(logs.some(line => line.startsWith('bugs-bot: the journal could not be written'))).toBe(true)
})
