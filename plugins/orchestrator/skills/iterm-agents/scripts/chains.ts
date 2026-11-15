// chains — the launcher's chain writes, through core's store (core/chains.ts): the adapter
// (iterm_agent.py) runs it for every change of a chain file, so the lock, the atomic replace and
// the line format are core's alone. One change per run, one JSON object on stdout:
// `{"written": [<tty>...], "count": <n>}`, the ttys whose chain was rewritten and, for `transfer`
// and `repoint-tab`, how many entries moved.
//
//   chains.ts append <state> <tty> <tab id> <agent tty> <owner> [resident]
//   chains.ts drop <state> <tty> <tab id>...
//   chains.ts drop-tab <state> <tab id>
//   chains.ts repoint-tab <state> <old tab id> <new tab id> <new tty>
//   chains.ts transfer <state> <old tty> <old owner> <new tty> <new owner> [merge]
//
// A malformed line: one line on stderr, exit 2. A lock held past its wait: the store's error on
// stderr, exit 1, and the chain is as it was.
import { appendChain, dropFromChain, dropTabEverywhere, repointTab, transferChain } from '../../../core/chains.ts'
import { isEntry } from '../../orchestrator/scripts/lib/process.ts'

export interface Changed {
  readonly written: readonly string[]
  readonly count: number
}

export class Usage extends Error {}

const flag = (word: string | undefined, name: string): boolean => {
  if (word === undefined || word === '') return false
  if (word === name) return true
  throw new Usage(`unexpected argument ${word}`)
}

/** The change a line asks, made. */
export function change(argv: readonly string[]): Changed {
  const [command, state = '', ...rest] = argv
  // `n` words, `max` with the optional mark; those at `filled` must not be empty (an owner may be).
  const need = (n: number, max: number, filled: readonly number[]): void => {
    if (state === '' || rest.length < n || rest.length > max || filled.some(i => (rest[i] ?? '') === '')) {
      throw new Usage(`${command}: wrong arguments`)
    }
  }
  switch (command) {
    case 'append': {
      need(4, 5, [0, 1, 2])
      const [tty = '', tab = '', agent = '', owner = ''] = rest
      appendChain(state, tty, { tab_id: tab, tty: agent, owner, resident: flag(rest[4], 'resident') })
      return { written: [tty], count: 1 }
    }
    case 'drop': {
      if (state === '' || rest.length < 2 || rest.some(word => word === '')) throw new Usage('drop: wrong arguments')
      const [tty = '', ...tabs] = rest
      return { written: dropFromChain(state, tty, tabs) ? [tty] : [], count: 0 }
    }
    case 'drop-tab': {
      need(1, 1, [0])
      return { written: dropTabEverywhere(state, rest[0] ?? ''), count: 0 }
    }
    case 'repoint-tab': {
      need(3, 3, [0, 1, 2])
      const [oldTab = '', newTab = '', newTty = ''] = rest
      return repointTab(state, oldTab, newTab, newTty)
    }
    case 'transfer': {
      need(4, 5, [0, 2])
      const [oldTty = '', oldOwner = '', newTty = '', newOwner = ''] = rest
      return { written: [newTty], count: transferChain(state, oldTty, oldOwner, newTty, newOwner, flag(rest[4], 'merge')) }
    }
    default:
      throw new Usage(`unknown command ${command ?? '(none)'}`)
  }
}

/** The command's run: its output and its exit code. */
export function main(argv: readonly string[], out: (text: string) => void, err: (text: string) => void): number {
  try {
    out(`${JSON.stringify(change(argv))}\n`)
    return 0
  } catch (error) {
    err(`chains: ${error instanceof Error ? error.message : String(error)}\n`)
    return error instanceof Usage ? 2 : 1
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), text => process.stdout.write(text), text => process.stderr.write(text))
}
