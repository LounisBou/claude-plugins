// A permission dialog matched to the call it is for. `tool.check` announces each call it puts to the
// operator (a verdict `ask`, with the call's id and Claude Code's reason); the classic
// `PermissionRequest` the host raises as it shows the dialog carries the tool and its arguments only.
// A module that tells the dialog binds the two by the rule below, never by a guess.

/** `value` as JSON with each object's keys in order: two inputs equal as values give one text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What the match reads of an announced ask: the tool, its arguments as `stableJson` gives them, the call's id and its loop (a subagent's id, undefined for the main one). */
export type AskKey = { readonly tool: string; readonly input: string; readonly id: string; readonly agent: string | undefined }

/**
 * The announced ask a dialog is for: the one the payload's own call id names when it carries one,
 * else the only ask of the same tool and loop with the same arguments. Several such asks, or none,
 * leave the dialog unmatched: it is never bound to an ask by a guess.
 */
export function askOfDialog<A extends AskKey>(asks: readonly A[], tool: string, input: unknown, agent: string | undefined, toolUseId?: string): A | undefined {
  const same = asks.filter(ask => ask.tool === tool && ask.agent === agent)
  if (toolUseId !== undefined) return same.find(ask => ask.id === toolUseId)
  const wanted = stableJson(input)
  const exact = same.filter(ask => ask.input === wanted)
  return exact.length === 1 ? exact[0] : undefined
}
