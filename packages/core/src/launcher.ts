// The launcher's command lines (`iterm-agent.sh spawn`, `bench-open`, `close`, …) as a versioned
// argument set, owned here once. The launcher's TypeScript entry parses a command line by it into a
// typed request; its Python adapter reads the same set (`launcher.json` in the plugin's copy) to
// check the request's version and fill each option's default. A reader of the command lines (the
// telemetry's, implement's) reads the flags here.

export const LAUNCHER_ARGS_VERSION = 1

/**
 * How an option takes its words: `value` one word (`--title x` or `--title=x`), `int` one integral
 * word, `list` one word each time it is given, `flag` none (true when given), `off` none (false
 * when given: `--no-verify` sets `verify` false).
 */
export type OptionKind = 'value' | 'int' | 'list' | 'flag' | 'off'

export type OptionValue = string | number | boolean | null | readonly string[]

export interface LauncherOption {
  readonly flag: string
  /** The request's key, the adapter's attribute. */
  readonly dest: string
  readonly kind: OptionKind
  /** For `value` and `int`, when absent: `''` unless given here. */
  readonly default?: string | number | null
}

/**
 * What a command does with a word that is none of its options: `refuse` it (`refusal`, or
 * `<command>: unknown option <word>`), `ignore` it, or keep it as `rest`, read as another command's
 * line (a rotation's words are the spawn's).
 */
export type Unknown = 'refuse' | 'ignore' | { readonly rest: string }

export interface LauncherCommand {
  readonly options: readonly LauncherOption[]
  /** Named positional words, filled in order; a word past them is unknown. */
  readonly positionals?: readonly string[]
  /** The command takes exactly this many words as they are, no option read (`resolve-tier <tier>`). */
  readonly raw?: number
  readonly unknown: Unknown
  /** The line said when a word is refused, or when `raw` is not met. */
  readonly refusal?: string
}

const value = (flag: string, dest: string, def?: string | number | null): LauncherOption =>
  def === undefined ? { flag, dest, kind: 'value' } : { flag, dest, kind: 'value', default: def }
const flag = (name: string, dest: string): LauncherOption => ({ flag: name, dest, kind: 'flag' })
const off = (name: string, dest: string): LauncherOption => ({ flag: name, dest, kind: 'off' })
const list = (name: string, dest: string): LauncherOption => ({ flag: name, dest, kind: 'list' })

const SPAWN: readonly LauncherOption[] = [
  value('--dir', 'dir'), value('--model', 'model'), value('--tier', 'tier'), value('--effort', 'effort'),
  flag('--inherit-model', 'inherit'), value('--permission-mode', 'mode', 'auto'), value('--title', 'title'),
  flag('--title-free', 'title_free'), off('--no-remote-control', 'remote_control'), value('--prompt', 'prompt'),
  value('--prompt-file', 'prompt_file'), value('--brief', 'brief'), value('--orchestrator', 'orchestrator'),
  value('--left-of', 'left_of'), value('--right-of', 'right_of'), off('--no-verify', 'verify'), flag('--trust', 'trust'),
  flag('--successor', 'successor'), flag('--auditor', 'auditor'), value('--of', 'of'),
  flag('--coordinator-successor', 'coordinator_successor'), flag('--resident', 'resident'), flag('--wake', 'wake'),
  flag('--open', 'open_'), value('--resume', 'resume'), list('--mcp', 'mcp'),
  flag('--account-connectors', 'account_connectors'), value('--gate-tokens', 'gate_tokens', null),
  list('--keep-tool', 'keep_tool'), list('--drop-tool', 'drop_tool'), flag('--keep-synced-skills', 'keep_synced_skills'),
]

export const LAUNCHER_COMMANDS = {
  'list': { options: [], unknown: 'ignore' },
  'spawn': { options: SPAWN, unknown: 'refuse' },
  'rotate': {
    options: [value('--old-tty', 'old_tty'), value('--expect-title', 'expect'), flag('--force', 'force')],
    unknown: { rest: 'spawn' },
  },
  'close': {
    options: [value('--tty', 'tty'), value('--expect-title', 'expect', null), flag('--keep-checkout', 'keep_checkout'),
      value('--bench', 'bench'), value('--socket', 'socket')],
    unknown: 'ignore',
  },
  'move': {
    options: [value('--tty', 'tty'), value('--left-of', 'left_of'), value('--right-of', 'right_of'),
      flag('--leftmost', 'leftmost'), flag('--force', 'force')],
    unknown: 'ignore',
  },
  'verify': { options: [value('--tty', 'tty'), { flag: '--pid', dest: 'pid', kind: 'int', default: null }], unknown: 'ignore' },
  'screen': { options: [value('--tty', 'tty'), { flag: '--lines', dest: 'lines', kind: 'int', default: 40 }], unknown: 'ignore' },
  'resolve-tier': { options: [], raw: 1, unknown: 'refuse', refusal: 'resolve-tier: exactly one tier is required (deep, standard or light)' },
  'pair': { options: [], raw: 0, unknown: 'refuse', refusal: "pair: takes no argument; it reads the calling session's own transcript" },
  'trust': { options: [flag('--apply', 'apply')], positionals: ['action'], unknown: 'refuse', refusal: 'trust: usage: trust prune [--apply]' },
  'tools': { options: [value('--transcript', 'transcript')], unknown: 'refuse' },
  'home': { options: [value('--session', 'session'), value('--name', 'name'), value('--prompt', 'prompt')], unknown: 'refuse' },
  'home-release': {
    options: [value('--tty', 'tty'), value('--session-id', 'session_id'), value('--pane-tty', 'pane_tty'), value('--resumed', 'resumed')],
    unknown: 'ignore',
  },
  'home-watch': { options: [value('--socket', 'socket'), value('--tty', 'tty')], unknown: 'ignore' },
  'takeover': { options: [value('--tty', 'tty'), value('--expect-title', 'expect')], unknown: 'refuse' },
  'bench-open': {
    options: [value('--bench', 'bench'), value('--dir', 'dir'), value('--title', 'title'), list('--plugin-dir', 'plugin_dir'),
      value('--settings', 'settings'), value('--prompt', 'prompt'), value('--prompt-file', 'prompt_file'),
      value('--model', 'model'), value('--effort', 'effort'), value('--permission-mode', 'mode', 'auto'), list('--mcp', 'mcp'),
      flag('--trust', 'trust'), off('--no-verify', 'verify')],
    unknown: 'refuse',
  },
} as const satisfies Readonly<Record<string, LauncherCommand>>

export type CommandName = keyof typeof LAUNCHER_COMMANDS

export const LAUNCHER_USAGE =
  'usage: iterm-agent.sh {list|spawn|verify|screen|resolve-tier|pair|close|move|rotate|trust|tools|home|home-release|takeover|bench-open} [options] (see header)'

/** A command line read: its options by `dest`, its named positionals, and a rotation's spawn. */
export interface LauncherRequest {
  readonly version: typeof LAUNCHER_ARGS_VERSION
  readonly command: CommandName
  readonly options: Readonly<Record<string, OptionValue>>
  /** The words of a `raw` command, as given. */
  readonly words?: readonly string[]
  /** The request the `rest` words make, for a command whose unknown words are another's. */
  readonly rest?: LauncherRequest
  /** A rest request's words its command would refuse, refused by that command when it runs. */
  readonly unknown?: readonly string[]
}

/** A command line that cannot be read: the line to say, and the exit code (argparse's 2 for a malformed one). */
export class LauncherArgsError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

export function isCommand(name: string): name is CommandName {
  return Object.hasOwn(LAUNCHER_COMMANDS, name)
}

function commandOf(name: CommandName): LauncherCommand {
  return LAUNCHER_COMMANDS[name]
}

/** Each option's value when the line does not give it. */
export function defaultsOf(name: CommandName): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {}
  for (const option of commandOf(name).options) {
    if (option.kind === 'flag') out[option.dest] = false
    else if (option.kind === 'off') out[option.dest] = true
    else if (option.kind === 'list') out[option.dest] = []
    else out[option.dest] = option.default === undefined ? '' : option.default
  }
  for (const positional of commandOf(name).positionals ?? []) out[positional] = ''
  return out
}

/** A word another option would take as its own: a dash, then anything but a negative number. */
const looksLikeOption = (word: string): boolean => word.startsWith('-') && word !== '-' && !/^-\d+$|^-\d*\.\d+$/.test(word)

/*
 * The option a word names: its exact flag, else the one flag it is a prefix of (the spawn takes
 * `--no-ver` for `--no-verify`, as its parser always did). Several is ambiguous; none is unknown.
 */
function optionOf(prog: string, options: readonly LauncherOption[], word: string): LauncherOption | null {
  const exact = options.find(option => option.flag === word)
  if (exact !== undefined) return exact
  if (!word.startsWith('--') || word.length < 3) return null
  const prefixed = options.filter(option => option.flag.startsWith(word))
  if (prefixed.length > 1) {
    throw new LauncherArgsError(`${prog}: error: ambiguous option: ${word} could match ${prefixed.map(o => o.flag).join(', ')}`, 2)
  }
  return prefixed[0] ?? null
}

/** The words split into this command's options and the rest, in the order given. */
function split(prog: string, spec: LauncherCommand, words: readonly string[]): { options: Record<string, OptionValue>; extra: string[] } {
  const options: Record<string, OptionValue> = {}
  const extra: string[] = []
  const positionals = [...(spec.positionals ?? [])]
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--') {
      extra.push(...words.slice(i + 1))
      break
    }
    if (!looksLikeOption(word)) {
      const positional = positionals.shift()
      if (positional === undefined) extra.push(word)
      else options[positional] = word
      continue
    }
    const eq = word.indexOf('=')
    const name = word.startsWith('--') && eq > 0 ? word.slice(0, eq) : word
    const option = optionOf(prog, spec.options, name)
    if (option === null) {
      extra.push(word)
      continue
    }
    if (option.kind === 'flag' || option.kind === 'off') {
      if (name !== word) throw new LauncherArgsError(`${prog}: error: argument ${option.flag}: ignored explicit argument '${word.slice(eq + 1)}'`, 2)
      options[option.dest] = option.kind === 'flag'
      continue
    }
    let given: string
    if (name !== word) given = word.slice(eq + 1)
    else {
      const next = words[i + 1]
      if (next === undefined || looksLikeOption(next) || next === '--') {
        throw new LauncherArgsError(`${prog}: error: argument ${option.flag}: expected one argument`, 2)
      }
      given = next
      i++
    }
    if (option.kind === 'int') {
      if (!/^\s*[-+]?\d+\s*$/.test(given)) throw new LauncherArgsError(`${prog}: error: argument ${option.flag}: invalid int value: '${given}'`, 2)
      options[option.dest] = Number.parseInt(given, 10)
    } else if (option.kind === 'list') {
      const before = options[option.dest]
      options[option.dest] = [...(Array.isArray(before) ? before : []), given]
    } else options[option.dest] = given
  }
  return { options, extra }
}

/** The request `words` make for `command`, or a LauncherArgsError saying why none. */
export function parseLauncherArgs(command: string, words: readonly string[], asRest = false): LauncherRequest {
  if (!isCommand(command)) throw new LauncherArgsError(LAUNCHER_USAGE, 1)
  const spec = commandOf(command)
  if (spec.raw !== undefined) {
    if (words.length !== spec.raw) throw new LauncherArgsError(spec.refusal ?? `${command}: takes ${spec.raw} words`, 1)
    return { version: LAUNCHER_ARGS_VERSION, command, options: {}, words: [...words] }
  }
  const { options, extra } = split(command, spec, words)
  const request = { version: LAUNCHER_ARGS_VERSION, command, options: { ...defaultsOf(command), ...options } } as const
  if (typeof spec.unknown === 'object') return { ...request, rest: parseLauncherArgs(spec.unknown.rest, extra, true) }
  if (asRest && spec.unknown === 'refuse' && extra.length > 0) return { ...request, unknown: extra }
  const word = extra[0]
  if (word !== undefined && spec.unknown === 'refuse') throw new LauncherArgsError(spec.refusal ?? `${command}: unknown option ${word}`, 1)
  return request
}

/** The data half, for the adapter in another language. */
export const LAUNCHER_CONTRACT = { version: LAUNCHER_ARGS_VERSION, usage: LAUNCHER_USAGE, commands: LAUNCHER_COMMANDS } as const
