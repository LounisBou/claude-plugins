// hooks/mode-dialog.ts
// The mode question, pure: whether a dialog call asks an orchestrator which mode it runs in; and
// the dialogs of a session others wait on while a coordinator runs are observed by guards.ts.
// The rulebook says a session reads its mode from its argument or its brief and, with none,
// asks it by the method's question format; a dialog in the session's own tab reaches neither the
// coordinator's pane nor a `waiting:` line. guards.ts holds the $ that reads the session's role.

// A dialog whose questions offer both modes: `build` and `investigate` in the options, the
// question or the header naming a mode.
export function asksTheMode(e: { questions?: unknown }): boolean {
  if (!Array.isArray(e.questions)) return false
  return e.questions.some((q: unknown) => {
    const held = field(q, 'options')
    const options = Array.isArray(held) ? held.map((o: unknown) => String(field(o, 'label') ?? '')).join(' ') : ''
    return /\bmode\b/i.test(`${field(q, 'header') ?? ''} ${field(q, 'question') ?? ''}`)
      && /\bbuild\b/i.test(options) && /\binvestigate\b/i.test(options)
  })
}

// A field of a value the dialog handed, whatever it is: undefined where the value holds none.
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined
  const read: unknown = Reflect.get(value, key)
  return read
}
