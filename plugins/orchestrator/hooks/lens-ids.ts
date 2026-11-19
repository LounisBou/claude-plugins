// hooks/lens-ids.ts
// A review reader's finding ids: an `orchestrator:lens` agent whose description names its lens
// (core's lens.ts, `lens <lens> <owner/name>#<pr> <base>..<head>`, as the review brief gives it)
// answers finding lines, and each reaches its review session with ` — id <lens>:<hash>` at its end,
// the id the review index carries and the review's decision names. A reader run in the foreground
// is marked in its answer; one run in the background in its hand-back, its only delivery. Any other
// agent, and every other line, passes as it came; a failure here passes the answer unmarked.
// The launch is passed as it came, or refused: the host's auto mode refuses a call a hook changed, so
// a toolkit reader whose prompt names no method file is refused with that file named, and the session
// relaunches it with a prompt it wrote. A reader whose toolkit is not found launches generic, journaled.
import { parseLensDescription, withFindingIds } from '../core/lens.ts'
import { configDir, logLine } from './module-io.ts'
import { observed } from './observe.ts'
import { agentPaths, lensMethod, methodAgent, TOOLKIT, type LensMethod } from './lens-method.ts'
import { messageOf, type Host, type On } from './host.ts'

type Held = Host<'fs' | 'process' | 'plugin' | 'env' | 'session' | 'clock'>

export const LENS_AGENT = 'orchestrator:lens'
export const LENS_GENERIC_CODE = 'orchestrator.lens.generic'
const HANDBACK_TOOL = 'SubagentHandback'

// The lens of each reader run in the background, by agent id, until its hand-back. Module memory: a
// restart loses it, and that reader's hand-back passes unmarked.
const background = new Map<string, string>()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` with every string in it marked: the answer's text, wherever the host puts it. */
function marked(value: unknown, lens: string): unknown {
  if (typeof value === 'string') return withFindingIds(value, lens)
  if (Array.isArray(value)) return value.map(item => marked(item, lens))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, marked(item, lens)]))
  return value
}

/** The lens's method as this machine gives it; undefined for a lens with no toolkit agent. */
async function methodOf($: Held, lens: string): Promise<LensMethod | undefined> {
  const agent = methodAgent(lens)
  if (agent === undefined) return undefined
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return await $.fs.read(path)
    } catch {
      return undefined
    }
  }
  const record = await read(`${await configDir($)}/plugins/installed_plugins.json`)
  const texts = new Map<string, string | undefined>()
  for (const path of agentPaths(record, agent)) texts.set(path, await read(path))
  return lensMethod(lens, record, path => texts.get(path))
}

/** The refusal of a toolkit launch whose prompt names no file: the file the session writes into its prompt. */
function missingFile(lens: string, method: LensMethod & { readonly kind: 'toolkit' }): string {
  return `the ${lens} reader's prompt must name its method's file, which it reads first: ${method.path} (${TOOLKIT} ${method.agent}). Relaunch the reader with that path in its prompt.`
}

/** The id the host gave a reader it launched in the background. */
function launchedId(answer: unknown): string | undefined {
  const body = isRecord(answer) ? answer['result'] : undefined
  const id = isRecord(body) && body['status'] === 'async_launched' ? body['agentId'] : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function register(on: On<Held>): void {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const facts = e['subagent_type'] === LENS_AGENT && typeof e['description'] === 'string' ? parseLensDescription(e['description']) : undefined
    if (facts === undefined) return next(e)
    let method: LensMethod | undefined
    try {
      method = await methodOf($, facts.lens)
    } catch (err) {
      await logLine($, 'lens-ids', `a reader's method was not read: ${messageOf(err)}`)
    }
    if (method?.kind === 'toolkit') {
      const prompt = typeof e['prompt'] === 'string' ? e['prompt'] : ''
      if (!prompt.includes(method.path)) return { deny: missingFile(facts.lens, method) }
    } else if (method?.kind === 'generic') {
      await observed($, LENS_GENERIC_CODE)
    }
    const answer = await next(e)
    try {
      const id = launchedId(answer)
      if (id !== undefined) {
        background.set(id, facts.lens)
        return answer
      }
      return marked(answer, facts.lens)
    } catch (err) {
      await logLine($, 'lens-ids', `a reader's answer left unmarked: ${messageOf(err)}`)
      return answer
    }
  }).catch(async ($, e, next) => {
    await logLine($, 'lens-ids', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })

  on('tool.call', { tool: HANDBACK_TOOL }, async (_$, e, next) => {
    const id = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
    const lens = id === undefined ? undefined : background.get(id)
    if (lens === undefined || typeof e['message'] !== 'string') return next(e)
    background.delete(id ?? '')
    return next({ ...e, message: withFindingIds(e['message'], lens) })
  }).catch(async ($, e, next) => {
    await logLine($, 'lens-ids', `unhandled (${next.error?.kind ?? 'failure'}): ${next.error?.message ?? 'the hook did not finish'}`)
    return next(e)
  })
}
