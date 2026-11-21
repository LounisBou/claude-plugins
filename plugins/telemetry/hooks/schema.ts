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
  { name: 'title', type: 'string', description: 'The title of the session that acted; absent until the module learns it (the host\'s start, a rename, the transcript\'s head). A launched session\'s spawn and close carry the child\'s own.' },
  { name: 'role', type: 'string', description: 'The role that title gives: `orchestrator`, `coordinator`, `agent`, `auditor`, `reviewer` or `other`; absent with the title.' },
  { name: 'parent', type: 'string', description: 'The name of the orchestrator the session reports to, as its launcher gave it (`ORCHESTRATOR_REPORTS_TO`), cut to 80 characters; absent in a session launched without one.' },
  { name: 'launch_tier', type: 'string', description: 'The capability tier the session was launched on, as its launcher gave it (`ORCHESTRATOR_TIER`); absent in a session launched by a model\'s name or by the operator.' },
]

const field = (name: string, type: string, description: string, unit?: string): FieldSpec => (unit === undefined ? { name, type, description } : { name, type, unit, description })

const TOKENS = 'tokens'

export const EVENT_SCHEMA = {
  session_start: {
    summary: 'A session begins.',
    writers: ['hook `session.start`; `$.session.usage().startedAt`'],
    fields: [
      field('cwd', 'string', 'The working directory.'),
      field('project', 'string', 'The `owner/name` of the session\'s git remote (`origin`, else the first), the same from any worktree; the last segment of `cwd` when it has no remote.'),
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
      field('cost_usd', 'number', 'The session\'s cumulative cost, up to this turn: never sum it across events.', 'usd'),
      field('turn_cost_usd', 'number', 'This turn\'s own cost: `cost_usd` less the previous turn\'s (the first turn: its whole value). Sum this one across events.', 'usd'),
    ],
  },
  api_call: {
    summary: 'One API call of the session\'s own loop or of one of its subagents (`agent`), as its transcript records it: the facts whole and raw, nothing derived (turns, idle gaps and cold rewrites are computed from the session\'s own, in the report; token use per session per hour from all of them).',
    writers: ['the writer, from the transcript, when it appends a session\'s own-loop `turn_end`: the calls of the turn that ended', 'the writer, from the child\'s transcript, when it appends a subagent\'s `agent_closed`: the calls of the run that ended, with `agent`', '`telemetry.ts backfill --calls <transcript>`: every call of a past transcript\'s own loop'],
    fields: [
      field('prompt', 'string', 'The host\'s `promptId`: the calls under one are one turn.'),
      field('message', 'string', 'The API message id of the response: a call is recorded once however often it is read.'),
      field('request', 'string', 'The API request id, when the transcript holds it.'),
      field('model', 'string', 'The model that answered.'),
      field('stop_reason', 'string', 'Why the model stopped (`end_turn`, `tool_use`, …).'),
      field('end', 'string', 'When the call\'s last entry was written; `ts` is its first\'s.', 'ISO 8601 UTC'),
      field('usage', 'object', 'The `usage` object of the response exactly as the host wrote it, every field it holds: token counts, `cache_creation` by TTL, `iterations`, service tier, speed, … Fields the host adds later are kept.'),
      field('tools', 'string[]', 'The names of the tools the call used, in order; no input and no output.'),
    ],
  },
  tool_call: {
    summary: 'A tool call, its outcome and who refused it.',
    writers: ['hooks `tool.call` around `next`, and `tool.check` when the decision is not `allow`', 'hook `turn.complete`, for the plugin and MCP calls a plugin answered in place of `next` (the `tool.call` hook beneath never runs): read back from the transcript once answered, with no `duration_ms` and no `check`, and the turn\'s end as `ts`'],
    fields: [
      field('tool', 'string', 'The tool\'s name.'),
      field('mcp_server', 'string', 'The MCP server, for an `mcp__<server>__<tool>` call.'),
      field('mcp_tool', 'string', 'The MCP tool of that server.'),
      field('tool_use_id', 'string', 'The host\'s id of the call.'),
      field('outcome', 'string', '`ok`, `error` or `refused`.'),
      field('decided_by', 'string', 'Who refused: `user`, `auto_mode`, `safety`, `rule`, `hook`, `plugin`, `plugin:<name>`.'),
      field('error_message', 'string', 'The text the model was given for an `error` or `refused` call: its first paragraph, the `<tool_use_error>` wrapper dropped, redacted then cut to 800 characters. Absent on an `ok` call, and on a refusal that gave no text.'),
      field('wait_kind', 'string', 'A `declare_wait` call: the wait\'s kind, `operator`, `done` or `deferred`; the `operator` ones also write a `question` event.'),
      field('check', 'object', 'The permission check when it did not allow: `decision`, `rule`, `hook`, `plugin`, `setting`.'),
      field('duration_ms', 'number', 'The call\'s duration, the permission wait included; absent on a call read back from the transcript.', 'ms'),
      field('ask_ms', 'number', 'A call whose permission dialog was shown (a `permission_ask` event of the same `tool_use_id`): from the dialog to the call\'s end, the operator\'s wait plus the tool\'s own run; `outcome` is his answer (`ok` allowed, `refused` by `user` denied). Absent on any other call.', 'ms'),
      field('bash', 'object', 'A Bash call: `head` (first command), `heads` (every command), `line` (redacted, cut to 400 characters).'),
      field('skill', 'string', 'The skill a `Skill` call loaded.'),
      field('subagent_type', 'string', 'The type an `Agent` call started.'),
      field('command', 'string', 'The `command` argument of an MCP call (`pr-merge`, `pr-gate`, …).'),
      field('target', 'object', 'What a GitHub act names: `repo`, `pr`, `head` (its first 12 characters), each present when the arguments or the result of the `mcp__github__gh` call, of a review or a record call, or the `gh` or `git push` line, name it.'),
    ],
  },
  permission_ask: {
    summary: 'A permission dialog is about to be shown to the operator. His answer is the `outcome` of the `tool_call` of the same `tool_use_id`, the wait its `ask_ms`; a call still waiting on him has this event alone.',
    writers: ['hook `classic.PermissionRequest`, written at once, with the ask `tool.check` announced for the call (its id, Claude Code\'s reason, who asked); none when a settings hook answered the request'],
    fields: [
      field('tool', 'string', 'The tool\'s name.'),
      field('mcp_server', 'string', 'The MCP server, for an `mcp__<server>__<tool>` call.'),
      field('mcp_tool', 'string', 'The MCP tool of that server.'),
      field('tool_use_id', 'string', 'The host\'s id of the call, from `tool.check`\'s ask; absent when no announced ask matched the dialog\'s tool and arguments (`ask_reason` is then absent too).'),
      field('ask_reason', 'string', 'Claude Code\'s reason for the ask as `tool.check` gave it (« via a symlink », « sensitive file », …), redacted and cut to 400 characters; absent when it gave none.'),
      field('check', 'object', 'The announced ask: `decision` `ask`, and `rule`, `hook`, `plugin`, `setting` when it names them.'),
      field('permission_mode', 'string', 'The session\'s permission mode when the dialog was raised.'),
      field('file', 'string', 'The path the arguments name (`file_path`, `notebook_path`, `path`), redacted and cut to 400 characters.'),
      field('bash', 'object', 'A Bash call: `head`, `heads` and `line` (redacted, cut to 400 characters).'),
      field('url', 'string', 'The `url` argument (a fetch), redacted and cut to 400 characters.'),
      field('skill', 'string', 'The skill a `Skill` call asks to load.'),
      field('command', 'string', 'The `command` argument of an MCP call (`pr-merge`, …).'),
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
    summary: 'A run of a subagent ended (its first, then each later one), or a launched session is closed.',
    writers: ['hook `turn.complete` of the child, each time one of its runs ends (kind `subagent`), then the writer reading the child\'s transcript', 'the launcher\'s `iterm-agent.sh close` command line (kind `session`)'],
    fields: [
      field('kind', 'string', '`subagent` or `session`.'),
      field('child', 'string', 'Subagent: the child\'s agent id.'),
      field('run', 'number', 'Subagent: the run\'s rank from the spawn, 1 for the first; absent when the module did not see the spawn (a resumed session).', 'count'),
      field('duration_ms', 'number', 'Subagent: the first run from its spawn to its end; a later run from its first turn\'s start, or the host\'s own figure for its last turn when that start was not seen.', 'ms'),
      field('reason', 'string', 'Subagent: why its run ended.'),
      field('subagent_type', 'string', 'Enriched, subagent: its type, from the host\'s `agent-<id>.meta.json`.'),
      field('description', 'string', 'Enriched, subagent: its task (a review reader\'s lens), redacted and cut to 80 characters.'),
      field('models', 'string[]', 'Enriched, subagent: every model that answered in the run.'),
      field('effort', 'string', 'Enriched, subagent: the reasoning effort of the run\'s last answer.'),
      field('calls', 'number', 'Enriched, subagent: the run\'s API calls, from its transcript.', 'count'),
      field('totals', 'object', 'Enriched, subagent: the run\'s `in`, `out`, `cache_read`, `cache_write` sums.', TOKENS),
      field('lens', 'string', 'Enriched, review reader: its lens, from its description (`lens <lens> <owner/name>#<pr> <base>..<head>`, core\'s lens.ts).'),
      field('target', 'object', 'Enriched, review reader: the pull request its description names, `repo` and `pr`.'),
      field('range', 'string', 'Enriched, review reader: the range its description names, `<base>..<head>`.'),
      field('findings', 'object', 'Enriched, review reader: the findings of its last answer by severity, `critical`, `important`, `minor`; their words are not kept.', 'count'),
      field('finding_ids', 'string[]', 'Enriched, review reader: each finding\'s id, `<lens>:<hash>` over its lens, file, line and claim, the id the review index and the review\'s decision name.'),
      field('title', 'string', 'Session: the closed session\'s title.'),
    ],
  },
  self_review: {
    summary: 'The outcome of one finding of an implementer\'s self-review: fixed, or answered with its reason.',
    writers: ['tool `mcp__telemetry__self_review`, one event per finding of the call'],
    fields: [
      field('lens', 'string', 'The reader\'s lens that reported it.'),
      field('file', 'string', 'The file it names.'),
      field('line', 'number', 'The line it names.'),
      field('severity', 'string', '`critical`, `important` or `minor`.'),
      field('outcome', 'string', '`fixed` or `answered`.'),
      field('reason', 'string', 'Answered: why it stays, redacted and cut to 80 characters.'),
      field('target', 'object', 'The pull request: `repo`, `pr`, each present when the call names it.'),
    ],
  },
  escape: {
    summary: 'A candidate escaped defect: a fix whose subject or text names pull requests; whether a name was merged is its reader\'s join. The orchestrator\'s own record of one is the `dispatch` event of `sub` `escaped`.',
    writers: ['tool `mcp__github__gh` `pr-create` with a `fix` title (source `pull_request`)', 'a Bash `gh pr create --title fix…` (source `pull_request`) or `git commit -m fix…` (source `commit`) that succeeded'],
    fields: [
      field('source', 'string', '`pull_request` or `commit`.'),
      field('names', 'string[]', 'The pull requests its title, body or message names, as written (`owner/name#N`, `name#N`, `#N`; a URL as `owner/name#N`), at most 10.'),
      field('target', 'object', 'The fix\'s own pull request or repository, when the call names it: `repo`, `pr`.'),
    ],
  },
  question: {
    summary: 'A question put to the operator and the letters chosen; no text.',
    writers: ['tool `AskUserQuestion` (source `ask_user`)', 'orchestrator tool `declare_wait` of kind `operator` (source `round`)', '`telemetry.ts sweep`, from a settled question\'s file in the orchestrator\'s round (source `round_file`): the event\'s `session`, `title` and `role` are the asker\'s, its `ts` the answer\'s'],
    fields: [
      field('source', 'string', '`ask_user`, `round` or `round_file`.'),
      field('count', 'number', 'Questions in the call.', 'count'),
      field('headers', 'string[]', 'Each question\'s header, cut to 12 characters.'),
      field('options', 'number[]', 'Options offered by each question.', 'count'),
      field('multi', 'boolean[]', 'Whether each question allowed several choices.'),
      field('chosen', 'string[]', 'The letters chosen for each question, `-` unanswered (round file: withdrawn), `other` free text.'),
      field('wait_ms', 'number', 'How long the call waited for the answer; round file: from the question to its settling.', 'ms'),
      field('kind', 'string', 'Round: the declared wait\'s kind; round file: `operator`, or `done` for a closing proposal.'),
      field('urgent', 'boolean', 'Round: presented at once.'),
      field('id', 'string', 'Round file: the question\'s id in the round.'),
      field('status', 'string', 'Round file: `answered`, `withdrawn` or `closed`.'),
      field('by', 'string', 'Round file: who settled it: `pane`, `tab`, `coordinator`, `sender` or `message`.'),
      field('recommended', 'string', 'Round file: the recommended choice\'s letter.'),
    ],
  },
  dispatch: {
    summary: 'A write to the orchestrator\'s dispatch record, as its script published it.',
    writers: ['`telemetry.ts sweep`, from the `dispatch` event `dispatch-record.sh` writes in the orchestrator\'s journal for each write that succeeds (source `journal`): the event\'s `session` is the one that ran the write, its `ts` the write\'s'],
    fields: [
      field('source', 'string', '`journal`.'),
      field('id', 'string', 'The journal event\'s id: a dispatch is recorded once.'),
      field('sub', 'string', 'The subcommand: `open`, `round`, `review`, `verdict`, `close`, `cost`, `goals` (a goal written), `pr`, …'),
      field('record', 'string', 'The record\'s file name.'),
      field('row', 'string', 'The row the write touches.'),
      field('class', 'string', 'The row\'s work class.'),
      field('tier', 'string', 'The row\'s capability tier.'),
      field('model', 'string', 'The row\'s model.'),
      field('effort', 'string', 'The row\'s reasoning effort.'),
      field('head', 'string', 'The commit a `--head` named in full, cut to 12 characters.'),
      field('verdict', 'string', 'A review\'s result (`pass`, `fail`, `accepted`), or a close\'s verdict when it is one plain word.'),
    ],
  },
  reconcile: {
    summary: 'What github\'s reconciler did since its previous event, at most an hour apart: its beats, its forge listings, its gates and its label moves.',
    writers: ['`telemetry.ts sweep`, from the `reconcile` event github\'s hooks module writes in its journal at a renewal of the reconciler\'s lease, at most once an hour (source `journal`): the event\'s `session` is the one holding the lease, its `ts` the renewal\'s'],
    fields: [
      field('source', 'string', '`journal`.'),
      field('id', 'string', 'The journal event\'s id: a reconcile is recorded once.'),
      field('ticks', 'number', 'The beats the reconciler ran since its previous event.', 'count'),
      field('listings', 'number', 'Its listings of a repository\'s open pull requests, one forge call each.', 'count'),
      field('gates', 'number', 'Its readings of the readiness gate.', 'count'),
      field('moves', 'number', 'The Ready or Not Ready labels it moved.', 'count'),
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
    writers: ['`telemetry.ts backfill <transcript>`', '`telemetry.ts sweep`, for a session whose events stopped a day ago with no `session_end`'],
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
      field('source', 'string', '`transcript` (backfill) or `sweep`.'),
    ],
  },
} satisfies Record<string, KindSpec>

export type EventName = keyof typeof EVENT_SCHEMA

/** The declared kinds, in the order of the schema. */
export const EVENTS = Object.keys(EVENT_SCHEMA) as readonly EventName[]
