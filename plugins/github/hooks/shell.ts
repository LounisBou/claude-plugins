// The calls a command line makes to the plugin's own engine (engine/gh.py), read over the
// simple commands core's shell reader gives. Pure functions only.

// The interpreter a script runs under, and the engine's script itself.
const PYTHON = /^(.*\/)?python(3(\.\d+)*)?$/
const ENGINE_SCRIPT = /(^|\/)gh\.py$/
// A script given by a shell variable (`python3 "$GH" …`, as the github-curl
// skill writes it) is the engine when the word after it is one of its
// subcommands, which all share this shape.
const SCRIPT_VARIABLE = /^\$(\{\w+\}|\w+)$/
const ENGINE_SUBCOMMAND = /^(pr|label|labels|thread|comment|comments|review|reviewer|assignee|issue|image|auth|file|repo)-[a-z-]+$/
// The interpreter's options that take the next word as their value.
const PYTHON_VALUED = new Set(['-W', '-X'])
// The engine's global options, which come before its subcommand and take a value.
const ENGINE_GLOBAL_VALUED = new Set(['--repo', '-R', '--format'])
// The engine's options that take a value, its global --repo and --format included.
const ENGINE_VALUED = new Set([
  '-R', '--repo', '--format', '--title', '--body-file', '--comments-file', '--base', '--head', '--method', '--sha',
  '--state', '--branch', '--pr', '--event', '--review-id', '--path', '--line', '--start-line', '--author',
  '--limit',
])

// One run of engine/gh.py: its subcommand, the repository its --repo names,
// its positionals and its options. `--stdin-json` reads its request from
// stdin, which the command line does not show: it is no call read here.
export type EngineCall = {
  command: string
  repo?: string
  positionals: string[]
  opts: Array<[string, string | undefined]>
}

// Where the engine's words start in a simple command's argv, past the
// interpreter, its options and the script, or undefined when it runs no engine.
export function engineStart(argv: string[]): number | undefined {
  let k = 0
  if (PYTHON.test(argv[0] ?? '')) {
    k = 1
    while (k < argv.length && argv[k].startsWith('-')) k += PYTHON_VALUED.has(argv[k]) ? 2 : 1
  }
  const script = argv[k] ?? ''
  if (ENGINE_SCRIPT.test(script)) return k + 1
  let first: string | undefined
  for (let j = k + 1; j < argv.length && first === undefined; j++) {
    if (ENGINE_GLOBAL_VALUED.has(argv[j])) j++
    else if (!argv[j].startsWith('-')) first = argv[j]
  }
  if (k > 0 && SCRIPT_VARIABLE.test(script) && first !== undefined && ENGINE_SUBCOMMAND.test(first)) return k + 1
  return undefined
}

// The call the engine's words make, or undefined for none read here.
export function engineWords(words: string[]): EngineCall | undefined {
  // The engine reads its request from stdin only when that is its one argument: anywhere
  // else, or after `--`, the word is an ordinary one.
  if (words.length === 1 && words[0] === '--stdin-json') return undefined
  const call: EngineCall = { command: '', positionals: [], opts: [] }
  let optionsEnded = false
  for (let j = 0; j < words.length; j++) {
    const word = words[j]
    if (word === '--' && !optionsEnded) {
      optionsEnded = true
      continue
    }
    let flag: string | undefined
    let value: string | undefined
    if (optionsEnded) {
      flag = undefined
    } else if (word.startsWith('--') && word.includes('=')) {
      flag = word.slice(0, word.indexOf('='))
      value = word.slice(word.indexOf('=') + 1)
    } else if (word.startsWith('-') && word !== '-') {
      flag = word
      if (ENGINE_VALUED.has(word)) value = words[++j]
    }
    if (flag === undefined) {
      if (call.command === '') call.command = word
      else call.positionals.push(word)
    } else if (flag === '--repo' || flag === '-R') {
      call.repo = value
    } else {
      call.opts.push([flag, value])
    }
  }
  return call.command === '' ? undefined : call
}

export function engineCall(argv: string[]): EngineCall | undefined {
  const at = engineStart(argv)
  return at === undefined ? undefined : engineWords(argv.slice(at))
}

// The value the last setting of an engine option gives, or undefined.
export function engineOption(call: EngineCall, flag: string): string | undefined {
  const set = call.opts.filter(([f]) => f === flag)
  return set.length > 0 ? set[set.length - 1][1] : undefined
}

export function engineFlag(call: EngineCall, flag: string): boolean {
  return call.opts.some(([f]) => f === flag)
}
