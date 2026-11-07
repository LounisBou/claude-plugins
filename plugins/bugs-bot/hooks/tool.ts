// hooks/tool.ts
// The `bugs` tool: the bugs-bot CLI with its arguments as a JSON list, so no
// shell reads a tester-facing text and no quote or apostrophe can cut it. The
// copy of the CLI that runs is this plugin's own, from `$.plugin.root`: no
// launcher on the PATH is needed for it.
//
// `wait` stays a background Bash call: it blocks for up to 55 minutes.
//
// `gate --measure` is measured here, from the session's own figures, and the CLI
// is handed `--tokens` and `--window`: the orchestrator's measure file is read
// only where the session has no figure yet, or where the module does not load.
import {
  READS, TOOL, TOOL_COMMANDS, TOOL_NAME, TOOL_TIMEOUT_MS, argsOf, chosenPython, measuredGateArgs, pythonFile, toolArgv,
  toolText,
} from './core.ts'

/*
 * A tool.call hook that answers in place of next(e) skips the engine's own
 * permission check, so the hook asks for the verdict itself. A rule on this
 * tool decides first. Without one, the operator's grant of the shell form,
 * `Bash(bugs-bot:*)`, is the same grant and is honoured. With neither, a read
 * passes and a write is put to the person; where nobody can answer (a -p run)
 * the write is refused.
 */
async function permit($: any, command: string, args: readonly string[]): Promise<string | undefined> {
  const own = await $.tool.check({ tool: TOOL, input: { command, args } })
  if (own.decision === 'allow') return undefined
  if (own.decision === 'deny') return own.reason || 'refused by a permission rule'
  if (!own.rule) {
    const shell = await $.tool.check({ tool: 'Bash', input: { command: `bugs-bot ${command}` } })
    if (shell.decision === 'allow') return undefined
    if (shell.decision === 'deny') return shell.reason || 'refused by a permission rule'
    if (READS.has(command)) return undefined
  }
  const shown = JSON.stringify(args)
  const question = `Run bugs-bot ${command} ${shown.length > 200 ? shown.slice(0, 199) + '…' : shown}?`
  try {
    if ((await $.ui.ask(question, ['Allow', 'Deny'])) === 'Allow') return undefined
  } catch {
    return `bugs-bot ${command} needs permission and nobody could be asked`
  }
  return `the user refused bugs-bot ${command}`
}

async function measured($: any, args: string[]): Promise<string[]> {
  try {
    const { context } = await $.session.usage()
    return measuredGateArgs(args, context?.tokens, context?.window) ?? args
  } catch {
    return args
  }
}

// The interpreter that runs this plugin's CLI, chosen as the fixed launcher chooses it: BUGS_BOT_PYTHON
// when set, else the one bin/setup remembered in the bugs home, else python3 from the PATH.
async function python($: any): Promise<string> {
  const chosen = await $.env.get('BUGS_BOT_PYTHON')
  if (chosen) return chosen
  const file = pythonFile(await $.env.get('BUGS_BOT_HOME'), await $.env.get('HOME'))
  try {
    return chosenPython((await $.fs.exists(file)) ? String(await $.fs.read(file)) : null)
  } catch {
    return chosenPython(null)
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    await $.tool.register({
      name: TOOL_NAME,
      // Listed with its schema from the start: behind ToolSearch the model would
      // reach for the shell form first.
      isDeferred: false,
      description:
        'The bugs-bot command line, without a shell: `command` is the bugs-bot command, `args` its '
        + 'arguments as a list of strings, each one word as the shell would have passed it — '
        + '{"command": "reply", "args": ["<id>", "<text>", "--mention", "--awaits"]}. Same commands, '
        + 'options, output and exit codes as `bugs-bot <command>` (an exit other than 0 ends the result '
        + 'with `exit=<code>`). `wait` is not here: it stays `bugs-bot wait` in the background. '
        + 'Prefer this tool to the shell form: no quoting can cut a text.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: TOOL_COMMANDS },
          args: { type: 'array', items: { type: 'string' }, description: 'the arguments, one word each' },
        },
        required: ['command'],
      },
    })
    return next(e)
  }).catch(async (_$: any, e: any, next: any) => next(e))

  on('tool.call', { tool: 'mcp__bugs-bot__bugs' }, async ($: any, e: any) => {
    const command = String(e.command ?? '')
    const raw = argsOf(e.args)
    if (!TOOL_COMMANDS.includes(command)) return { result: `not a command of this tool: ${command || '(none)'}`, isError: true }
    if (raw === null) return { result: '`args` must be a list of strings', isError: true }
    const refused = await permit($, command, raw)
    if (refused) return { deny: refused }
    const args = command === 'gate' ? await measured($, raw) : raw
    const interpreter = await python($)
    try {
      const r = await $.process.run(toolArgv(interpreter, $.plugin.root, command, args), { timeoutMs: TOOL_TIMEOUT_MS })
      return { result: toolText(r.stdout, r.stderr, r.exitCode), isError: r.exitCode !== 0 }
    } catch (err: any) {
      return { result: `bugs-bot ${command} could not run: ${String(err?.message ?? err)}`, isError: true }
    }
  }).catch(async () => ({ deny: 'bugs-bot: the tool itself failed; run the same command as `bugs-bot <command>` in Bash' }))
}
