// tests/row-rule.ts - the module's row writer (hooks/supervision.ts, writeSession) run outside
// the host, for the suite to hold the launcher's row_write (iterm_agent.py) to the same line,
// the same key and the same temporary file.
//
//   node tests/row-rule.ts write <session id> <patch JSON>
//   node tests/row-rule.ts key <session id>
//
// `write` merges the patch into the session's row under ORCHESTRATOR_MODULE_DIR's store, as a
// measure does, through a $ over this machine's files and processes, then prints the temporary
// file the write renamed into place. `key` prints the row's key.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionKey, writeSession } from '../hooks/supervision.ts'

const [mode, id, patch] = process.argv.slice(2)
if (mode === 'key' && id !== undefined) {
  process.stdout.write(sessionKey(id) + '\n')
  process.exit(0)
}
if (mode !== 'write' || id === undefined || patch === undefined) {
  process.stderr.write('usage: row-rule.ts write <session id> <patch JSON> | key <session id>\n')
  process.exit(2)
}

const moved: string[] = []
const $ = {
  env: { get: async (name: string) => process.env[name] },
  fs: {
    read: async (path: string) => readFileSync(path, 'utf8'),
    write: async (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
  },
  process: {
    run: async (argv: readonly string[], opts: { timeoutMs?: number } = {}) => {
      if (argv[0] === 'mv') moved.push(argv[2])
      const done = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: opts.timeoutMs })
      return { exitCode: done.status, stdout: done.stdout, stderr: done.stderr }
    },
  },
}
await writeSession($, id, JSON.parse(patch))
process.stdout.write(moved.join('\n') + '\n')
