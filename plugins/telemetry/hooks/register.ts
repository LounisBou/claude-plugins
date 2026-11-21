// hooks/register.ts
// The hooks module: observes the session and hands its events to the writer. Every hook calls
// `next` first and returns what it resolved to; its own bookkeeping runs in a try of its own, so
// a failure here never changes, delays past its bound, or repeats the call it observed (an
// observer fails open). The events are built in collect.ts; this file only reads the host.
import {
  agentClosed, agentSpawned, askOf, checkOf, Collector, firstRepository, firstTurn, mcpOf, originOf, permissionAsk, remoteUrlsArgv, renamedTo, repositoryOf, sessionEnd, sessionStart, sessionTitleOf, titleFromTranscriptHead, toolEvents, TRANSCRIPT_HEAD_BYTES, transcriptCallIds, transcriptToolEvents,
  turnEnd, usageFacts, type Event,
} from './collect.ts'
import { SELF_REVIEW_DESCRIPTION, SELF_REVIEW_SCHEMA, SELF_REVIEW_TOOL, selfReviewEvents, selfReviewLine } from './self-review.ts'

type Next = (e: unknown) => Promise<unknown>
type Hook = ($: Host, e: Record<string, unknown>, next: Next) => Promise<unknown>
type On = (event: string, ...rest: [Hook] | [Readonly<Record<string, string>>, Hook]) => unknown

/** The part of the host's `$` this module calls. */
export interface Host {
  readonly plugin: { readonly root: string }
  readonly env: { get(name: string): Promise<string | undefined> }
  readonly clock: { now(): Promise<number> }
  readonly process: { run(argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }
  readonly session: {
    id(): Promise<string>
    model(): Promise<string>
    usage(): Promise<unknown>
    info(): Promise<unknown>
    messages(args?: { agentId: string }): Promise<unknown>
    repo(): Promise<unknown>
  }
  readonly ui: { log(text: string, options?: { to?: string }): void }
  /** Lists the module's own tool. */
  readonly tool: { register(spec: { name: string; description: string; inputSchema: unknown; isDeferred?: boolean }): Promise<unknown> }
}

/** A write never holds the turn's end past this. */
export const WRITE_TIMEOUT_MS = 10_000
/** The read of a transcript's head is given this long. */
export const HEAD_READ_TIMEOUT_MS = 2_000
/** The read of a repository's remotes is given this long. */
export const REMOTES_READ_TIMEOUT_MS = 2_000
/** The export clones and pushes: it is given longer. */
export const EXPORT_TIMEOUT_MS = 120_000

const SCRIPT = 'skills/telemetry/scripts/telemetry.ts'

/** The writer's command line: the script under node, its subcommand, the config directory. */
export function scriptArgv(root: string, sub: string, config: string): string[] {
  return ['node', '--experimental-strip-types', '--no-warnings', `${root}/${SCRIPT}`, sub, '--config', config]
}

async function configDir($: Host): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
}

async function quietly($: Host, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    try {
      $.ui.log(`telemetry: ${what} skipped: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    } catch { /* the log itself never fails a hook */ }
  }
}

export function register(on: On): void {
  mount(on, new Collector())
}

/** The hooks over one collector: the host's mount, and a test's. */
/** Hands the buffered events to the writer; throws when it fails, for the caller's log. */
async function flush($: Host, collector: Collector): Promise<void> {
  const lines = collector.drain()
  if (lines === '') return
  const run = await $.process.run(scriptArgv($.plugin.root, 'append', await configDir($)), { stdin: lines, timeoutMs: WRITE_TIMEOUT_MS })
  if (run.exitCode !== 0) throw new Error(`append exited ${run.exitCode}: ${run.stderr.trim().split('\n').pop() ?? ''}`)
  // The writer speaks only to say what the operator should know once (the export has no repository to push to).
  const said = run.stdout.trim()
  if (said !== '') $.ui.log(said)
}

/**
 * The session's title from the head of its transcript, read once, while no other source gave it.
 * A read that fails leaves the title unknown: no error, no second try.
 */
async function readTitle($: Host, collector: Collector): Promise<void> {
  if (!collector.wantsHeadRead()) return
  try {
    const info = await $.session.info()
    const path = typeof info === 'object' && info !== null ? (info as Record<string, unknown>)['transcriptPath'] : undefined
    if (typeof path !== 'string' || path === '') return
    const run = await $.process.run(['head', '-c', String(TRANSCRIPT_HEAD_BYTES), '--', path], { timeoutMs: HEAD_READ_TIMEOUT_MS })
    if (run.exitCode === 0) collector.setTitle(titleFromTranscriptHead(run.stdout))
  } catch { /* the title stays unknown */ }
}

/**
 * The session's repository as `owner/name`, from the host's origin remote or, when it has none, the
 * first remote git lists. Read once, at the session's start; undefined when the directory is no
 * repository, has no remote or the read fails.
 */
async function readRepository($: Host): Promise<string | undefined> {
  try {
    const repo = await $.session.repo()
    if (typeof repo !== 'object' || repo === null) return undefined
    const { root, remote } = repo as { root?: unknown; remote?: unknown }
    const named = typeof remote === 'string' ? repositoryOf(remote) : undefined
    if (named !== undefined) return named
    if (typeof root !== 'string' || root === '') return undefined
    const run = await $.process.run(remoteUrlsArgv(root), { timeoutMs: REMOTES_READ_TIMEOUT_MS })
    return run.exitCode === 0 ? firstRepository(run.stdout) : undefined
  } catch {
    return undefined
  }
}

/** The `self_review` tool's answer: its events written at once, and the report's lines, one per finding, or why none was. */
async function selfReview($: Host, collector: Collector, input: Record<string, unknown>): Promise<{ result: string; isError?: boolean }> {
  try {
    const built = selfReviewEvents(await $.clock.now(), await $.session.id(), input)
    if ('why' in built) return { result: `self-review: not recorded — ${built.why}`, isError: true }
    collector.push(...built.events)
    await flush($, collector)
    return { result: built.events.map(selfReviewLine).join('\n') }
  } catch (error) {
    return { result: `self-review: not recorded — ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}

/** Buffers `events`, and writes them once the buffer reaches its threshold. */
async function add($: Host, collector: Collector, events: readonly Event[]): Promise<void> {
  if (collector.push(...events)) await flush($, collector)
}

export function mount(on: On, collector: Collector): void {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await quietly($, 'session.start', async () => {
      const at = await $.clock.now()
      const usage = usageFacts(await $.session.usage())
      collector.startAt = at
      collector.launchedAt = usage.startedAt
      collector.setTitle(sessionTitleOf(e))
      const spawned = Boolean(await $.env.get('ORCHESTRATOR_SPAWNED'))
      // The launcher's own words on a session it spawned (core's ENV.reportsTo and ENV.tier); neither is set in the operator's own.
      collector.setOrigin(originOf(await $.env.get('ORCHESTRATOR_REPORTS_TO'), await $.env.get('ORCHESTRATOR_TIER')))
      await add($, collector, [sessionStart(at, await $.session.id(), e, { model: await $.session.model(), startedAt: usage.startedAt, spawned, repository: await readRepository($) })])
    })
    // Listed from the start (not deferred): the self-review's last act calls it.
    await quietly($, 'the self_review tool', async () => {
      await $.tool.register({ name: 'self_review', description: SELF_REVIEW_DESCRIPTION, inputSchema: SELF_REVIEW_SCHEMA, isDeferred: false })
    })
    // A resumed session, or a reloaded module, holds calls an earlier run already wrote: they are not written again.
    await quietly($, 'session.start calls', async () => {
      for (const id of transcriptCallIds(await $.session.messages())) collector.claim(id)
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (typeof e['agentId'] === 'string') {
      const child = e['agentId']
      await quietly($, 'turn.start of a subagent', async () => collector.runStarted(child, await $.clock.now()))
    }
    if (e['agentId'] === undefined && !collector.firstTurnSeen) {
      collector.firstTurnSeen = true
      await quietly($, 'turn.start', async () => {
        await add($, collector, [firstTurn(await $.clock.now(), await $.session.id(), collector.startAt, collector.launchedAt)])
      })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await quietly($, 'turn.complete tool calls', async () => {
      const at = await $.clock.now()
      const agent = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
      const messages = await $.session.messages(agent === undefined ? undefined : { agentId: agent })
      await add($, collector, transcriptToolEvents(at, await $.session.id(), messages, agent, id => collector.claim(id)))
    })
    await quietly($, 'turn.complete', async () => {
      const at = await $.clock.now()
      const session = await $.session.id()
      if (e['agentId'] === undefined) await readTitle($, collector)
      const usage = usageFacts(await $.session.usage())
      const events = [turnEnd(at, session, e, usage, collector.turnCost(usage.costUsd))]
      const child = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
      if (child !== undefined) events.push(agentClosed(at, session, child, collector.closing(child), e))
      if (child === undefined) collector.turns++
      collector.push(...events)
      if (child === undefined) await flush($, collector)
    })
    return result
  })

  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    await quietly($, 'tool.check', async () => {
      collector.noteCheck(typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined, checkOf(result))
      collector.noteAsk(askOf(e, result))
    })
    return result
  })

  // The classic event the host raises as it is about to show a permission dialog. A settings hook that
  // answers the request (a decision on `next`'s result) shows none: nothing is written then. The hook
  // returns at once: the ask is taken without a host call, and the clock, the session id and the writer
  // run after it, never awaited, so the dialog waits on none of them. The line is written as the dialog
  // appears, not at the turn's end: a call still waiting on the operator has this line alone.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    try {
      if (typeof result === 'object' && result !== null && 'decision' in result) return result
      const ask = collector.takeAsk(typeof e['tool_name'] === 'string' ? e['tool_name'] : '', e['tool_input'], typeof e['agent_id'] === 'string' ? e['agent_id'] : undefined, typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined)
      void (async () => {
        const at = await $.clock.now()
        if (ask !== undefined) collector.markShown(ask.id, at)
        collector.push(permissionAsk(at, await $.session.id(), e, ask))
        await flush($, collector)
      })().catch(error => {
        try {
          $.ui.log(`telemetry: permission request skipped: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
        } catch { /* the log itself never fails a hook */ }
      })
    } catch { /* an observer: the dialog goes on */ }
    return result
  })

  on('tool.call', async ($, e, next) => {
    // The module's own tool: answered here, its call read back from the transcript like any plugin's.
    if (e['tool'] === SELF_REVIEW_TOOL) return selfReview($, collector, e)
    let started: number | undefined
    try {
      started = await $.clock.now()
    } catch { /* no duration, still the call */ }
    const result = await next(e)
    await quietly($, 'tool.call', async () => {
      const at = await $.clock.now()
      if (typeof e['tool_use_id'] === 'string' && mcpOf(String(e['tool'])) !== undefined) collector.claim(e['tool_use_id'])
      const check = collector.takeCheck(typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined)
      const askedAt = collector.settleAsk(typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined)
      await add($, collector, toolEvents(at, await $.session.id(), e, result, check, started === undefined ? 0 : Math.max(0, at - started), askedAt))
      collector.setTitle(renamedTo(e, result, check))
    })
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await quietly($, 'agent.spawn', async () => {
      const at = await $.clock.now()
      const event = agentSpawned(at, await $.session.id(), e, result)
      collector.spawned(typeof event['child'] === 'string' ? event['child'] : undefined, at)
      await add($, collector, [event])
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    await quietly($, 'session.end', async () => {
      const at = await $.clock.now()
      const session = typeof e['sessionId'] === 'string' ? e['sessionId'] : await $.session.id()
      collector.push(sessionEnd(at, session, e, { ...usageFacts(await $.session.usage()), turns: collector.turns }))
      await flush($, collector)
    })
    return next(e)
  })

  on('command.run', { command: 'telemetry:export' }, async ($) => {
    try {
      try {
        await flush($, collector)
      } catch (error) {
        return { text: `telemetry: export not run, the buffered events could not be written: ${error instanceof Error ? error.message : String(error)}` }
      }
      const run = await $.process.run(scriptArgv($.plugin.root, 'export', await configDir($)), { timeoutMs: EXPORT_TIMEOUT_MS })
      return { text: `${run.stdout}${run.stderr}`.trim() || `export exited ${run.exitCode}` }
    } catch (error) {
      return { text: `telemetry: the export did not run: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
