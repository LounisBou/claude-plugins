// hooks/schema.ts
// The declared list of event kinds: for each, what it records, who writes it and its fields with
// their units. This is the one source: the writer accepts exactly these kinds (`EVENTS`, read by
// collect.ts and the store), and the export generates the logs repository's schema pages from it.
// A new kind joins the writer and the index by one entry here; nothing else lists kinds.
// Pure data: no node module.

/** One field of an event line. */
export interface FieldSpec {
  readonly name: string
  /** `string`, `number`, `boolean`, `object`, `string[]`, … as JSON holds it. */
  readonly type: string
  /** `ms`, `usd`, `tokens`, `count`, `ISO 8601 UTC`; absent when the field has none. */
  readonly unit?: string
  readonly description: string
}

/** One kind of event. */
export interface KindSpec {
  readonly summary: string
  /** What emits it: the host hook or the command line the writer reads it from. */
  readonly writers: readonly string[]
  /** The fields beyond `COMMON_FIELDS`. */
  readonly fields: readonly FieldSpec[]
}

/** On every line, whatever the kind. */
export const COMMON_FIELDS: readonly FieldSpec[] = [
  { name: 'v', type: 'number', description: 'The event format version, 1.' },
  { name: 'ts', type: 'string', unit: 'ISO 8601 UTC', description: 'When the event was written; its first ten characters name the day file.' },
  { name: 'event', type: 'string', description: 'The kind, one of the pages of this schema.' },
  { name: 'session', type: 'string', description: 'The host\'s session id; the name of the session\'s transcript file, whose redacted copy is in the logs repository.' },
  { name: 'agent', type: 'string', description: 'The subagent whose loop the fact happened in; absent for the session\'s own loop.' },
]

const field = (name: string, type: string, description: string, unit?: string): FieldSpec => (unit === undefined ? { name, type, description } : { name, type, unit, description })

const TOKENS = 'tokens'

export const EVENT_SCHEMA = {
  session_start: {
    summary: 'A session begins.',
    writers: ['hook `session.start`; `$.session.usage().startedAt`'],
    fields: [
      field('cwd', 'string', 'The working directory.'),
      field('project', 'string', 'The last segment of `cwd`.'),
      field('model', 'string', 'The model the session starts on.'),
      field('interactive', 'boolean', 'Whether a person drives the session.'),
      field('surface', 'string', 'The host surface (terminal, desktop, …).'),
      field('spawned', 'boolean', 'Launched by the orchestrator rather than by the operator.'),
      field('startup_ms', 'number', 'From the launch to `session.start`.', 'ms'),
    ],
  },
  first_turn: {
    summary: 'The first turn of the session\'s own loop begins.',
    writers: ['hook `turn.start`, once per session'],
    fields: [
      field('since_start_ms', 'number', 'From `session_start`.', 'ms'),
      field('since_launch_ms', 'number', 'From the launch: the « started after 5 minutes » figure.', 'ms'),
    ],
  },
  turn_end: {
    summary: 'A turn ends: its cost, tokens and the context fill.',
    writers: ['hook `turn.complete`; `$.session.usage()`'],
    fields: [
      field('turn', 'string', 'The turn id.'),
      field('reason', 'string', 'Why the turn ended.'),
      field('duration_ms', 'number', 'The turn\'s duration.', 'ms'),
      field('model', 'string', 'The model that answered.'),
      field('tokens', 'object', '`in`, `out`, `cache_read`, `cache_write`, as the host counted them.', TOKENS),
      field('refusal', 'string', 'The category of a refusal that ended the turn.'),
      field('context_tokens', 'number', 'The context fill (the session\'s own loop only).', TOKENS),
      field('window', 'number', 'The context window (the session\'s own loop only).', TOKENS),
      field('cost_usd', 'number', 'The session\'s cumulative cost.', 'usd'),
    ],
  },
  tool_call: {
    summary: 'A tool call, its outcome and who refused it.',
    writers: ['hooks `tool.call` around `next`, and `tool.check` when the decision is not `allow`'],
    fields: [
      field('tool', 'string', 'The tool\'s name.'),
      field('mcp_server', 'string', 'The MCP server, for an `mcp__<server>__<tool>` call.'),
      field('mcp_tool', 'string', 'The MCP tool of that server.'),
      field('tool_use_id', 'string', 'The host\'s id of the call.'),
      field('outcome', 'string', '`ok`, `error` or `refused`.'),
      field('decided_by', 'string', 'Who refused: `user`, `auto_mode`, `safety`, `rule`, `hook`, `plugin`, `plugin:<name>`.'),
      field('check', 'object', 'The permission check when it did not allow: `decision`, `rule`, `hook`, `plugin`, `setting`.'),
      field('duration_ms', 'number', 'The call\'s duration, the permission wait included.', 'ms'),
      field('bash', 'object', 'A Bash call: `head` (first command), `heads` (every command), `line` (redacted, cut to 400 characters).'),
      field('skill', 'string', 'The skill a `Skill` call loaded.'),
      field('subagent_type', 'string', 'The type an `Agent` call started.'),
      field('command', 'string', 'The `command` argument of an MCP call (`pr-merge`, `pr-gate`, …).'),
    ],
  },
  agent_spawned: {
    summary: 'A subagent or a launched session is started.',
    writers: ['hook `agent.spawn` (kind `subagent`)', 'the launcher\'s `iterm-agent.sh spawn` command line (kind `session`)'],
    fields: [
      field('kind', 'string', '`subagent` or `session`.'),
      field('child', 'string', 'Subagent: the child\'s agent id.'),
      field('subagent_type', 'string', 'Subagent: its type.'),
      field('model', 'string', 'The model it runs on.'),
      field('requested_model', 'string', 'Subagent: the model the call asked for.'),
      field('background', 'boolean', 'Subagent: run in the background.'),
      field('provider', 'string', 'Subagent: the plugin that provides it.'),
      field('description', 'string', 'Subagent: its task, redacted and cut to 80 characters.'),
      field('title', 'string', 'Session: its title.'),
      field('role', 'string', 'Session: the role its title gives it.'),
      field('tier', 'string', 'Session: the capability tier.'),
      field('effort', 'string', 'Session: the reasoning effort.'),
      field('permission_mode', 'string', 'Session: the permission mode.'),
    ],
  },
  agent_closed: {
    summary: 'A subagent finished its first run, or a launched session is closed.',
    writers: ['hook `turn.complete` of the child (kind `subagent`)', 'the launcher\'s `iterm-agent.sh close` command line (kind `session`)'],
    fields: [
      field('kind', 'string', '`subagent` or `session`.'),
      field('child', 'string', 'Subagent: the child\'s agent id.'),
      field('duration_ms', 'number', 'Subagent: from its spawn to its first run\'s end.', 'ms'),
      field('reason', 'string', 'Subagent: why its run ended.'),
      field('title', 'string', 'Session: the closed session\'s title.'),
    ],
  },
  question: {
    summary: 'A question put to the operator and the letters chosen; no text.',
    writers: ['tool `AskUserQuestion` (source `ask_user`)', 'orchestrator tool `declare_wait` of kind `operator` (source `round`)'],
    fields: [
      field('source', 'string', '`ask_user` or `round`.'),
      field('count', 'number', 'Questions in the call.', 'count'),
      field('headers', 'string[]', 'Each question\'s header, cut to 12 characters.'),
      field('options', 'number[]', 'Options offered by each question.', 'count'),
      field('multi', 'boolean[]', 'Whether each question allowed several choices.'),
      field('chosen', 'string[]', 'The letters chosen for each question, `-` unanswered, `other` free text.'),
      field('wait_ms', 'number', 'How long the call waited for the answer.', 'ms'),
      field('kind', 'string', 'Round: the declared wait\'s kind.'),
      field('urgent', 'boolean', 'Round: presented at once.'),
    ],
  },
  dispatch: {
    summary: 'A write to the orchestrator\'s dispatch record.',
    writers: ['the `dispatch-record.sh <sub> <record> [<row>]` command line of a Bash call'],
    fields: [
      field('sub', 'string', 'The subcommand: `open`, `round`, `review`, `ready`, `close`, `cost`, …'),
      field('record', 'string', 'The record\'s file name.'),
      field('row', 'string', 'The row the write touches.'),
      field('class', 'string', 'The work class.'),
      field('tier', 'string', 'The capability tier.'),
      field('model', 'string', 'The model.'),
      field('effort', 'string', 'The reasoning effort.'),
      field('head', 'string', 'The commit the write is bound to.'),
      field('verdict', 'string', 'The review verdict, redacted and cut to 80 characters.'),
    ],
  },
  session_end: {
    summary: 'A session ends, enriched from its transcript.',
    writers: ['hook `session.end`, then the writer reading the transcript'],
    fields: [
      field('reason', 'string', 'Why the session ended.'),
      field('duration_ms', 'number', 'The session\'s duration.', 'ms'),
      field('turns', 'number', 'Turns of the session\'s own loop.', 'count'),
      field('cost_usd', 'number', 'The session\'s total cost.', 'usd'),
      field('context_tokens', 'number', 'The context fill at the end.', TOKENS),
      field('window', 'number', 'The context window.', TOKENS),
      field('title', 'string', 'Enriched: the transcript\'s title.'),
      field('role', 'string', 'Enriched: `orchestrator`, `coordinator`, `agent`, `auditor`, `reviewer` or `other`.'),
      field('effort', 'string', 'Enriched: the reasoning effort of the last answer.'),
      field('models', 'string[]', 'Enriched: every model that answered.'),
      field('first_turn_ms', 'number', 'Enriched: from the first entry to the first answer.', 'ms'),
      field('totals', 'object', 'Enriched: the transcript\'s `in`, `out`, `cache_read`, `cache_write` sums.', TOKENS),
    ],
  },
  session_summary: {
    summary: 'A past session summarized from its transcript.',
    writers: ['`telemetry.ts backfill <transcript>`'],
    fields: [
      field('title', 'string', 'The transcript\'s title.'),
      field('role', 'string', 'The role the title gives.'),
      field('effort', 'string', 'The reasoning effort of the last answer.'),
      field('models', 'string[]', 'Every model that answered.'),
      field('cwd', 'string', 'The working directory.'),
      field('started', 'string', 'The first entry\'s time.', 'ISO 8601 UTC'),
      field('ended', 'string', 'The last entry\'s time.', 'ISO 8601 UTC'),
      field('first_turn_ms', 'number', 'From the first entry to the first answer.', 'ms'),
      field('totals', 'object', '`in`, `out`, `cache_read`, `cache_write` sums.', TOKENS),
      field('tools', 'object', 'Calls by tool name.', 'count'),
      field('errors', 'number', 'Tool calls that failed.', 'count'),
      field('refusals', 'object', 'Refusals by decider.', 'count'),
      field('source', 'string', '`transcript`.'),
    ],
  },
} satisfies Record<string, KindSpec>

export type EventName = keyof typeof EVENT_SCHEMA

/** The declared kinds, in the order of the schema. */
export const EVENTS = Object.keys(EVENT_SCHEMA) as readonly EventName[]
