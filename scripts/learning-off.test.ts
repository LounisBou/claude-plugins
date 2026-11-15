// The learning plugin is a kill switch (docs/specs/learning-design.md, goal 16): with it disabled,
// every other plugin behaves the same. Held here by what « disabled » removes: no plugin declares it
// as a dependency, its hooks module answers its own command and sits in no other chain, and its
// readers leave the writers' journals as the writers wrote them, so a writer's files are the same
// whether the plugin ever ran or not.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { parseLearningEvent } from '../packages/core/src/learning.ts'
import { register as registerLearning } from '../plugins/learning/hooks/register.ts'
import { run as distil } from '../plugins/learning/skills/learning/scripts/distil.ts'
import { run as health } from '../plugins/learning/skills/learning/scripts/health.ts'
import { noteSubject as noteNorms, observed as observedByNorms, type JournalHost } from '../plugins/norms/hooks/observe.ts'
import { noteSubject as noteReview, observed as observedByReview } from '../plugins/pr-review/hooks/observe.ts'
import { manifestPath, readPlugins } from './lib/plugins.ts'

const NOW = new Date('2026-11-14T10:00:00Z')

// A host whose files and commands are the machine's, under `home`.
function hostOn(home: string, logged: string[]): JournalHost {
  return {
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    fs: {
      write: async (path, text) => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text)
      },
      read: async path => readFileSync(path, 'utf8'),
      list: async path => readdirSync(path).map(name => ({ name })),
      exists: async path => existsSync(path),
      stat: async path => ({ kind: statSync(path).isDirectory() ? 'dir' : 'file', mtimeMs: statSync(path).mtimeMs }),
    },
    process: {
      run: async argv => {
        const ran = spawnSync(String(argv[0]), argv.slice(1), { encoding: 'utf8' })
        return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr }
      },
    },
    session: { id: async () => 'sess-1', root: async () => home },
    clock: { sleep: async () => undefined },
    ui: { log: line => logged.push(line), invalidate: () => undefined, ask: async () => '', resolve: () => ({}) },
  }
}

// Every journal file under a configuration directory, by its path, with its bytes.
function journals(config: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const plugin of existsSync(config) ? readdirSync(config) : []) {
    const dir = join(config, plugin, 'journal')
    for (const name of existsSync(dir) ? readdirSync(dir) : []) files[`${plugin}/${name}`] = readFileSync(join(dir, name), 'utf8')
  }
  return files
}

// What a writer's files hold once the parts no two runs share (the random part of an id) are set aside.
const shapes = (files: Record<string, string>): unknown[] =>
  Object.entries(files).map(([path, text]) => {
    const event = parseLearningEvent(JSON.parse(text))
    assert.ok(event, path)
    return { plugin: path.slice(0, path.indexOf('/')), ...event, id: event.id.slice(0, -8) }
  })

async function write(home: string, logged: string[]): Promise<void> {
  const $ = hostOn(home, logged)
  noteNorms({ repo: 'Acme/App', pr: 1, head: 'a'.repeat(40) })
  noteReview({ repo: 'Acme/App', pr: 2, head: 'b'.repeat(40) })
  await observedByNorms($, 'norms.edit.ungranted', () => NOW)
  await observedByReview($, 'pr-review.stop.loop-open', () => NOW)
}

describe('the learning plugin disabled', () => {
  it('is a dependency of no plugin', () => {
    for (const plugin of readPlugins('.')) {
      const manifest = JSON.parse(readFileSync(manifestPath('.', plugin.dir), 'utf8')) as { dependencies?: { name?: unknown }[] }
      assert.deepEqual((manifest.dependencies ?? []).filter(dependency => dependency.name === 'learning'), [], plugin.dir)
    }
  })

  it('takes one hook with it, its own command\'s: it sits in no chain of another plugin', () => {
    const hooks: string[] = []
    registerLearning((event, matcher) => hooks.push(`${event} ${JSON.stringify(matcher)}`))
    assert.deepEqual(hooks, ['command.run {"command":"learning:health"}'])
  })

  it('changes nothing of what the writers write: the same journals with its readers run and never run', async () => {
    const never = mkdtempSync(join(tmpdir(), 'learning-off-'))
    const read = mkdtempSync(join(tmpdir(), 'learning-on-'))
    const logged: string[] = []
    try {
      await write(never, logged)
      await write(read, logged)
      const before = journals(join(read, '.claude'))
      assert.equal(Object.keys(before).length, 2)
      // The plugin enabled: its report and its distiller read the journals.
      const out: string[] = []
      const deps = { out: (line: string) => out.push(line), err: (line: string) => out.push(line), now: () => NOW.getTime() }
      assert.equal(health(['--config', join(read, '.claude')], deps), 0)
      assert.equal(distil(['--config', join(read, '.claude')], deps), 0)
      assert.match(out.join('\n'), /2 events from 2 journals/)
      assert.deepEqual(journals(join(read, '.claude')), before)
      // The writers go on, read or not, and both configurations hold the same events.
      await write(never, logged)
      await write(read, logged)
      assert.deepEqual(shapes(journals(join(read, '.claude'))), shapes(journals(join(never, '.claude'))))
      assert.equal(Object.keys(journals(join(never, '.claude'))).length, 4)
      assert.deepEqual(logged, [])
    } finally {
      rmSync(never, { recursive: true, force: true })
      rmSync(read, { recursive: true, force: true })
    }
  })
})
