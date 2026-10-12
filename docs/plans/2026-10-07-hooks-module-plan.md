# The hooks module — v0.49 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the context measurement, the three gates and the cross-session state into one in-process hooks module, and cut over in release 0.49.0.

**Architecture:** `hooks/hooks.json` gains a `modules` array pointing at hooks/register.ts, which mounts four domain modules (`gauge.ts`, `guards.ts`, `supervision.ts`, `commands.ts`) plus two pure helpers (`gauge-core.ts`, `tokenizer.ts`, `session-name.ts`). Every domain carries a `*.test.ts` run by `claude plugin test`. The shell hooks, the tap and `ctx/` are removed in the same release.

**Tech Stack:** TypeScript loaded directly by the host (no build step), `claude plugin test` / `claude plugin validate`, the existing shell test suite for the parts that stay shell.

**Spec:** `docs/specs/2026-10-07-hooks-module-design.md` — the plan argues from it; executors read both.

## Global Constraints

- English only, everywhere; never name the vendor, the product or a model in prose — the runtime is "the host". Load-bearing identifiers are exempt: `~/.claude/`, `.claude-plugin/`, `hooks.json` keys, event names (`tool.call`, `prompt.submit`, `session.measure`, `classic.Stop`), env vars (`CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_SESSION_ID`, `ORCHESTRATOR_*`), the repository name.
- Conventional commits, imperative subject, body explains why; no co-author or tool attribution, ever.
- `./tests/run-tests.sh` passes after every task — run it after the task's commit, never before: the design-layout check reads tracked files, and a file the commit adds but the layout does not name turns the next run red. A task that creates or deletes a file updates the `## 2. Layout` block of `docs/design.md` in the same commit.
- The host's `plugin test ..` passes from `hooks/` after every task that adds one.
- Host version floor: 2.1.287, checked by `install.sh`.
- Hard cutover: nothing of the tap/`ctx/` pipeline survives in 0.49.0 beyond the single `measure/<session-id>.json` file.
- Every handler registers a `.catch` that logs one line to the state dir and never blocks.
- Engine laws, ratified at the Task 5 review and extended at the Task 9 report (the plan's earlier sketches predate them): `$` is fenced to the file that received it — never passed across an import, always spelled `$.noun.event(...)` at the call site, `$.env.get` takes a literal name; `on(...)` chains `.catch(handler)` inline at the registration site — the engine checks for it and refuses the module without it; a second registration of an event the module already registered must carry a matcher — the empty object `{}` when it means every event (the engine refuses a second bare registration, its message naming the first site; validate lists the shape as `event{}`); and matcher keys are NOT validated against the event's fields — a key no event carries silently selects nothing, so field names are spelled from the shipped types. Shared logic splits pure (importable, plain values) from $-holding (stays in the file whose handler received `$`).
- The measure file is the only channel to external processes; the store is never read from outside a session.
- `$.fs.write` is non-atomic: every reader of `measure/*.json` treats an unparseable line as unmeasured.

## Review Focus

Five input classes the task tests do not fully pin; each line's test is added to the owning task.

1. **A partially written measure file** (non-atomic write caught mid-turn by `gate.py`) must read as unmeasured, never crash the caller → Task 2 step 6, Task 15 step 4.
2. **A handler exceeding the 10-second time bound** (slow CI read in the stop gate) must degrade to "let it pass and log", never block the stop forever → Task 8 step 2.
3. **Hot reload resets module memory** (a re-registered module re-runs `register`) — model-drift state and unmeasured-once markers must not double-announce after a reload → Task 2 step 7 (the `null` reset covers both markers, which live in module memory).
4. **Two sessions writing the store at once** — keys are per session id; a concurrent write to another key must not be lost → Task 9 step 1.
5. **A surface that draws nothing** (chat panel, headless) — the band handler must skip silently, not throw → Task 3 step 3 (the `surfaces` check) and its `bandTree(null)` test case.

---

### Task 1: Module scaffold and test chain

**Files:**
- Create: hooks/register.ts
- Modify: `hooks/hooks.json`
- Test: hooks/tests/scaffold.test.ts

Note: the spec's `register.js` becomes `register.ts` for a uniform TypeScript module set — same entry, same role.

**Interfaces:**
- Produces: `register(on: Function): void` exported from hooks/register.ts; `hooks.json` `modules: ["./register.ts"]`.

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/scaffold.test.ts
import { expect, test } from 'claude-code/testing'
import { register } from '../register.ts'

test('register mounts exactly one session.start handler', () => {
  const mounted: string[] = []
  register((event: string, handler: Function) => {
    if (typeof handler !== 'function') throw new Error(`no handler mounted for ${event}`)
    mounted.push(event)
  })
  expect(mounted).toEqual(['session.start'])
})
```

`claude plugin validate` (step 4) is the second half of the assertion: it lists what the module registers against the real event names.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hooks && claude plugin test ..`
Expected: FAIL — no `modules` entry, nothing loads.

- [ ] **Step 3: Write the scaffold**

```json
// hooks/hooks.json — full replacement
{
  "description": "The orchestrator hooks module",
  "modules": ["./register.ts"]
}
```

```typescript
// hooks/register.ts
// Entry point of the hooks module: mounts the four domains. Each domain lands in
// its own task; until then the module only proves the chain loads.
export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => unknown) {
  on('session.start', async ($: unknown, e: unknown, next: (e: unknown) => unknown) => next(e))
}
```

The three settings-hook blocks (`UserPromptSubmit`, `PreToolUse`, `Stop`) stay in place until Task 12 — a `hooks.json` may carry both `modules` and `hooks` at once.

- [ ] **Step 4: Validate and test**

Run: `claude plugin validate .. && cd hooks && claude plugin test ..`
Expected: validate lists `hooks: session.start`; tests PASS.

- [ ] **Step 5: Live smoke**

Run: `claude --plugin-dir ~/dev/claude-orchestrator` then `/plugin`
Expected: `1 mod active · orchestrator`.

- [ ] **Step 6: Commit**

```bash
git add hooks/hooks.json hooks/register.ts hooks/tests/scaffold.test.ts
git commit -m "feat(hooks): load the module scaffold behind the shell hooks"
```

### Task 2: gauge-core — measurement, double gate, measure file, model drift

**Files:**
- Create: hooks/gauge-core.ts (pure functions, no host API)
- Create: hooks/gauge.ts (event wiring)
- Test: hooks/tests/gauge-core.test.ts

**Interfaces:**
- Consumes: nothing (first domain).
- Amends Task 1's scaffold test: `toEqual(['session.start'])` relaxes to `toContain('session.start')` — gauge mounts `session.measure` beside it (pre-flight ruling) — and the fake's handler check lands with the same edit (review finding: the fake ignored its handler argument).
- Produces:
  - `tripGate(percent: number | null, tokens: number | null, window: number | null, env?: { gate?: number; gateTokens?: number; largeWindow?: number }): { tripped: boolean; words: string }`
  - `measureFilePath(config: string, sessionId: string): string` → `<config>/claude-orchestrator/measure/<id>.json`; `configDir($)` in `gauge.ts` resolves `CLAUDE_CONFIG_DIR` through `$.env.get` (the module sandbox exposes no `process` global — ratified at the Task 2 review)
  - `writeMeasure($: { fs: { write(p: string, c: string): Promise<unknown> } }, sessionId: string, reading: MeasureReading): Promise<void>`
  - `type MeasureReading = { context_tokens: number; context_window: number; context_percent: number; model: string; updated_at: string }`

- [ ] **Step 1: Write the failing tests**

```typescript
// hooks/tests/gauge-core.test.ts
import { expect, test } from 'claude-code/testing'
import { tripGate } from '../gauge-core.ts'

test('the gate trips at 80 percent of the window', () => {
  expect(tripGate(79, 79000, 100000).tripped).toBe(false)
  expect(tripGate(80, 80000, 100000).tripped).toBe(true)
})

test('the gate trips at 300,000 tokens on a window of 1,000,000 or more', () => {
  expect(tripGate(29, 299999, 1000000).tripped).toBe(false)
  expect(tripGate(30, 300000, 1000000).tripped).toBe(true)
  expect(tripGate(31, 310000, 1200000).tripped).toBe(true)
})

test('below the large window only the percent rules', () => {
  expect(tripGate(50, 300000, 400000).tripped).toBe(false)
})

test('an unreadable reading never trips', () => {
  expect(tripGate(null, null, null).tripped).toBe(false)
})

test('the tripped words name what was read', () => {
  expect(tripGate(80, 80000, 100000).words).toBe('80% (gate 80%)')
  expect(tripGate(30, 300000, 1000000).words).toBe('300,000 tokens (gate 300,000 on a 1M window)')
})

test('env overrides move the thresholds', () => {
  expect(tripGate(50, 50000, 100000, { gate: 50 }).tripped).toBe(true)
  expect(tripGate(10, 100000, 1000000, { gateTokens: 100000 }).tripped).toBe(true)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hooks && claude plugin test ..`
Expected: FAIL — `gauge-core.ts` does not exist.

- [ ] **Step 3: Implement**

```typescript
// hooks/gauge-core.ts
// The measurement rules, pure: the same numbers the shell gate read, with no host
// API in reach so the boundaries stay testable.

export type MeasureReading = {
  context_tokens: number; context_window: number; context_percent: number
  model: string; updated_at: string
}

export function tripGate(
  percent: number | null, tokens: number | null, window: number | null,
  env: { gate?: number; gateTokens?: number; largeWindow?: number } = {},
): { tripped: boolean; words: string } {
  const gate = env.gate ?? 80
  const gateTokens = env.gateTokens ?? 300000
  const largeWindow = env.largeWindow ?? 1000000
  const thousands = (n: number) => n.toLocaleString('en-US')
  const windowLabel = (n: number) => (n % 1000000 === 0 ? `${n / 1000000}M` : thousands(n))
  if (tokens !== null && window !== null && window >= largeWindow) {
    if (tokens < gateTokens) return { tripped: false, words: '' }
    return { tripped: true, words: `${thousands(tokens)} tokens (gate ${thousands(gateTokens)} on a ${windowLabel(window)} window)` }
  }
  if (percent !== null && percent >= gate) return { tripped: true, words: `${percent}% (gate ${gate}%)` }
  return { tripped: false, words: '' }
}

export function measureFilePath(config: string, sessionId: string): string {
  return `${config}/claude-orchestrator/measure/${sessionId}.json`
}
```

`configDir($): Promise<string>` (in `gauge.ts`) resolves `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`, through `$.env.get` — the module sandbox exposes no `process` global (ratified at the Task 2 review). `writeMeasure` serialises one JSON line through `$.fs.write`; it lives in `gauge.ts` because it takes `$`.

- [ ] **Step 4: Run to verify pass**

Run: `cd hooks && claude plugin test ..`
Expected: PASS.

- [ ] **Step 5: Wire the events in gauge.ts**

```typescript
// hooks/gauge.ts
import { measureFilePath, tripGate, type MeasureReading } from './gauge-core.ts'

// Module memory only — a reload resets both, by design (Review Focus 3): drift is
// announced between two measures of the same load, never re-announced from a stale
// previous model after a hot reload.
let current: MeasureReading | null = null
let lastModel: string | null = null

export function driftAnnouncement(model: string, previous: string): string {
  // Verbatim from hooks/context-gate.sh:94 — the host can switch the answering
  // model under a session (a refusal, an outage) and no other surface shows it.
  return `MODEL DRIFT: this session now answers as ${model}; it answered as ${previous} until now. The host switched on its own (a refusal, an outage): say it to the operator in your next message; a succession does not repair it.`
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => unknown) {
  on('session.measure', async ($: any, e: any, next: (e: any) => any) => {
    try {
      const usage = await $.session.usage()
      const model = await $.session.model()
      const reading: MeasureReading = {
        context_tokens: usage.context.tokens,
        context_window: usage.context.window,
        context_percent: usage.context.percent,
        model: String(model ?? 'unavailable'),
        updated_at: new Date().toISOString(),
      }
      await $.fs.write(measureFilePath(await configDir($), e.sessionId ?? await $.session.id()), JSON.stringify(reading) + '\n')
      if (lastModel !== null && lastModel !== reading.model) {
        await $.ui.toast(driftAnnouncement(reading.model, lastModel))
      }
      lastModel = reading.model
      current = reading
      $.ui.invalidate('ui.render')
    } catch (err) {
      // A measure that fails never blocks: the next turn measures again.
      await logLine($, `gauge: ${(err as Error).message}`)
    }
    return next(e)
  })
}

async function logLine($: any, message: string): Promise<void> {
  // Shared read-modify-write, best effort: concurrent sessions may interleave lines.
  // logLine stamps the module name — call sites pass the bare message, no prefix.
  const config = await configDir($)
  try {
    const existing = (await $.fs.read(`${config}/claude-orchestrator/hooks-module.log`)) ?? ''
    await $.fs.write(`${config}/claude-orchestrator/hooks-module.log`, `${existing}${new Date().toISOString()} | gauge | ${message}\n`)
  } catch { /* a log that cannot write stays silent */ }
}
```

Mount it from `register.ts`: `import { register as registerGauge } from './gauge.ts'` and call `registerGauge(on)` inside `register`. Delete the file at `session.end`:

```typescript
  on('session.end', async ($: any, e: any, next: (e: any) => any) => {
    try { /* $.fs has no delete; truncation marks it stale, install purges the dir */ }
    catch { /* never blocks */ }
    return next(e)
  })
```

(The host API surface for deletion is verified against the generated types during implementation; if `$.fs` offers no remove, the file is truncated to empty and `install.sh` purges stale files — an empty file already reads as unmeasured everywhere.)

- [ ] **Step 6: The drift announcement, verbatim**

```typescript
// added to hooks/tests/gauge-core.test.ts (driftAnnouncement lives in gauge.ts; the
// import moves there when the test file splits)
import { driftAnnouncement } from '../gauge.ts'

test('a model change is announced once, naming both models', () => {
  const a = driftAnnouncement('a-model', 'another-model')
  expect(a).toBe('MODEL DRIFT: this session now answers as a-model; it answered as another-model until now. The host switched on its own (a refusal, an outage): say it to the operator in your next message; a succession does not repair it.')
})
```

- [ ] **Step 7: Review Focus 1 — partial write tolerance**

Add to `gauge-core.test.ts`:

```typescript
import { parseMeasure } from '../gauge-core.ts'

test('a partial or empty measure line reads as unmeasured, never throws', () => {
  expect(parseMeasure('')).toBeNull()
  expect(parseMeasure('{"context_tokens":123')).toBeNull()
  expect(parseMeasure('{"context_tokens":123,"context_window":1000,"context_percent":12,"model":"a-model","updated_at":"t"}')).toMatchObject({ context_tokens: 123 })
})
```

Implement `parseMeasure(line: string): MeasureReading | null` — `JSON.parse` in a try/catch, null on any failure. `gate.py` (Task 15) reuses the same rule.

- [ ] **Step 8: Review Focus 3 — hot reload**

Add:

```typescript
test('a reloaded module does not inherit stale in-memory state', async ($: any) => {
  // session.start re-runs register; lastModel resets, so the first measure after a
  // reload announces nothing (no previous model to drift from). Driven through the
  // registered session.measure handler over a fake on/$ — the module loader refuses
  // import() (ratified at the Task 2 review).
  const measures: Function[] = []
  registerGauge((event: string, handler: Function) => { if (event === 'session.measure') measures.push(handler) })
  // three measures: a-model, a-model, b-model — the change is announced exactly once;
  // a second registerGauge (a reload) announces nothing on its own first measure.
})
```

The rule it pins: `lastModel` starts `null` on every load — drift is only announced between two measures of the same load.

- [ ] **Step 9: Run all, commit**

Run: `cd hooks && claude plugin test .. && cd .. && ./tests/run-tests.sh`
Expected: PASS (shell suite untouched — the shell hooks still run).

```bash
git add hooks/
git commit -m "feat(gauge): measure the context from session events into one file per session"
```

### Task 3: gauge — the AbovePrompt band

**Files:**
- Modify: hooks/gauge.ts
- Test: hooks/tests/gauge-band.test.ts

**Interfaces:**
- Consumes: `tripGate`, the reading kept by the `session.measure` handler — expose it as `export function currentReading(): MeasureReading | null` over the private `current` variable (Task 2 left it unexported; Task 2 review finding). Also export `configDir($)` from `gauge.ts`: Task 5 reads the measure file through it.
- Produces: an `ui.render` handler on `component: 'AbovePrompt'`.
- Carries (Task 2 review minors, adjudicated to this task — it already edits gauge.ts): the `session.end` handler gains the same `e.sessionId ?? await $.session.id()` fallback as `session.measure`; the `logLine` call sites drop their `gauge: `/`band: ` prefix (`logLine` stamps the module name itself); the scaffold test's title says what it now asserts, not "exactly one". From the Task 2 report: the sandbox exposes no `process` global and no `import()` — plain `$.…` calls inside try/catch only; the usage fields are optional in the shipped types before the first fill, so `currentReading()` staying `null` until then is the expected band input.

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/gauge-band.test.ts
import { expect, test } from 'claude-code/testing'
import { bandTree } from '../gauge.ts'

test('below the gate the band shows the fill without warning color', () => {
  const tree = bandTree({ context_percent: 42, context_tokens: 42000, context_window: 100000, model: 'a-model', updated_at: 't' })
  expect(JSON.stringify(tree)).toContain('42%')
  expect(JSON.stringify(tree)).not.toContain('rotation')
})

test('past the gate the band names the rotation', () => {
  const tree = bandTree({ context_percent: 84, context_tokens: 84000, context_window: 100000, model: 'a-model', updated_at: 't' })
  expect(JSON.stringify(tree)).toContain('84%')
  expect(JSON.stringify(tree)).toContain('rotation gate')
})
```

- [ ] **Step 2: Run to verify failure** — `bandTree` is not exported.

- [ ] **Step 3: Implement the tree and the render handler**

```typescript
// added to hooks/gauge.ts
export function bandTree(reading: MeasureReading | null): unknown {
  if (!reading) return null
  const past = tripGate(reading.context_percent, reading.context_tokens, reading.context_window).tripped
  const label = `context ${reading.context_percent}% · ${reading.context_tokens.toLocaleString('en-US')}/${reading.context_window.toLocaleString('en-US')}`
  // The concrete elements (Box, Text) come from $.ui.resolve(e) at render time;
  // bandTree returns the plain description the handler maps onto them.
  return { label, past, rotation: past ? 'rotation gate — succeed at the next quiet boundary' : null }
}
```

In `register`:

```typescript
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const surfaces = await $.session.surfaces()
      if (!surfaces?.draws) return next(e)   // Review Focus 5: nothing draws → skip silently
      const tree = bandTree(currentReading())
      if (!tree) return next(e)
      const el = await $.ui.resolve(e)
      // Draw: one Text row (label), colored when past the gate; the host's own
      // band content passes through next alongside ours.
      return next({ ...e, props: { ...e.props, rows: [el.Text({ color: tree.past ? 'red' : 'gray', children: tree.label }), ...(tree.rotation ? [el.Text({ color: 'red', children: tree.rotation })] : [])] } })
    } catch (err) {
      await logLine($, `band: ${(err as Error).message}`)
      return next(e)
    }
  })
```

The exact props of `AbovePrompt` and the element factory signatures come from the generated types in `.claude-plugin/types/` (written on first `--plugin-dir` load); the handler above is adjusted to those signatures, not the other way around.

- [ ] **Step 4: Run tests** — `cd hooks && claude plugin test ..` — PASS.

- [ ] **Step 5: Live smoke with hot reload**

Run: `claude --plugin-dir ~/dev/claude-orchestrator`, ask for a small task, watch the band above the prompt; edit the label, save, watch it reload.

- [ ] **Step 6: Commit**

```bash
git add hooks/
git commit -m "feat(gauge): draw the context fill above the prompt"
```

### Task 4: session-name — the one reading of a session's name

**Files:**
- Create: hooks/session-name.ts
- Test: hooks/tests/session-name.test.ts
- Test fixture: tests/fixtures/transcript-renamed.jsonl

**Interfaces:**
- Consumes: nothing.
- Produces: `readName($: any, transcriptPath: string): Promise<{ tty: string | null; name: string | null }>` — launch name from the process table (via `$.process.run`), else the last `custom-title` entry of the transcript read from the end in 64 KiB blocks; `roleOf(name: string): 'orchestrator' | 'agent' | 'auditor' | 'coordinator' | null` mapping the `Orch :`, `Agent :`, `Audit :`, `Coord :` prefixes.

- [ ] **Step 1: Write the failing tests**

```typescript
// hooks/tests/session-name.test.ts
import { expect, test } from 'claude-code/testing'
import { roleOf, lastCustomTitle } from '../session-name.ts'

test('the role is the prefix of the name', () => {
  expect(roleOf('Orch : payments')).toBe('orchestrator')
  expect(roleOf('Agent : belt-p3')).toBe('agent')
  expect(roleOf('Audit : 1712')).toBe('auditor')
  expect(roleOf('Coord : main')).toBe('coordinator')
  expect(roleOf('a plain session')).toBeNull()
  expect(roleOf('')).toBeNull()
})

test('the last custom-title entry wins, read from the end', async ($: any) => {
  const path = 'tests/fixtures/transcript-renamed.jsonl'
  expect(await lastCustomTitle($, path)).toBe('Agent : renamed-later')
})
```

The fixture is three lines: two entries, the last a rename to `Agent : renamed-later`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```typescript
// hooks/session-name.ts
// Ported from hooks/session_name.py: the launch name from the process table, else
// the last custom-title entry of the transcript, read from the end in blocks.
const BLOCK = 65536

export function roleOf(name: string | null): string | null {
  if (!name) return null
  if (name.startsWith('Orch :')) return 'orchestrator'
  if (name.startsWith('Agent :')) return 'agent'
  if (name.startsWith('Audit :')) return 'auditor'
  if (name.startsWith('Coord :')) return 'coordinator'
  return null
}

async function readRange($: any, path: string, offset: number, length: number): Promise<string> {
  // $.fs.read's range support is verified against the generated types at
  // implementation time; without ranges the tail comes from `tail -c +<n>` through
  // $.process.run — never a whole-file read, transcripts grow past the fs cap.
  return await $.fs.read(path, { offset, length })   // or the tail -c fallback
}

export async function lastCustomTitle($: any, path: string): Promise<string | null> {
  // A line-for-line port of title_in() in hooks/session_name.py:51-72 — seek from
  // the end in BLOCK-sized steps, carry the cut first line, answer the LAST
  // custom-title entry (a rename comes after the original title).
  const isTitle = (line: string) => /"type"\s*:\s*"custom-title"/.test(line)
  const titleOf = (line: string) => {
    const m = line.match(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    return m ? JSON.parse(`"${m[1]}"`) as string : null
  }
  let firstServed = false
  let carry = ''
  for (let offset = -BLOCK; ; offset -= BLOCK) {
    const chunk = carry + await readRange($, path, offset, BLOCK)
    const lines = chunk.split('\n')
    carry = firstServed ? '' : (lines.shift() ?? '')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isTitle(lines[i])) {
        const t = titleOf(lines[i])
        if (t !== null) return t
      }
    }
    if (chunk.length < BLOCK) {
      // Start of file reached; the carried cut line is the file's first line.
      if (carry && isTitle(carry)) {
        const t = titleOf(carry)
        if (t !== null) return t
      }
      return null
    }
    firstServed = true
  }
}
```

`readName($, transcriptPath)` — the process-table half, a port of `read_name()` (`session_name.py:81-92`) — asks `$.process.run` for the launch name against the same listing the launcher prints, and falls back to `lastCustomTitle` when the table answers nothing.

- [ ] **Step 4: Run tests, live smoke (rename a session, run a prompt, role is read).**

- [ ] **Step 5: Commit**

```bash
git add hooks/session-name.ts hooks/tests/session-name.test.ts tests/fixtures/transcript-renamed.jsonl
git commit -m "feat(hooks): read a session's name in-process"
```

### Task 5: guards — the context gate on prompt.submit

**Files:**
- Create: hooks/guards.ts
- Modify: hooks/register.ts (mount)
- Test: hooks/tests/context-gate.test.ts

**Interfaces:**
- Consumes: `roleOf`, `readName` (Task 4), `tripGate`, `parseMeasure` (Task 2).
- Produces: `roleLine(role: string): string` — the exact four lines from `context-gate.sh:57-63`; a `prompt.submit` handler.
- Carries (Task 4 review minor, adjudicated to this task — it is the first consumer of the name): `titleOf` in hooks/session-name.ts ports `unquoted()`'s normalization — strip whitespace, then surrounding quotes, then whitespace again, an empty result reads as null (`session_name.py`'s own rule); a padded rename `  Agent : x  ` must read back trimmed, with a test line in hooks/tests/session-name.test.ts proving it.

- [ ] **Step 1: Write the failing tests**

```typescript
// hooks/tests/context-gate.test.ts
import { expect, test } from 'claude-code/testing'
import { roleLine, gateAnnouncement } from '../guards.ts'

test('each role gets its own line, verbatim from the shell gate', () => {
  expect(roleLine('orchestrator')).toBe('Succeed at the next quiet boundary — run /orchestrator:succeed: spawn the successor in the operator\'s decision mode, then tell the user; do not ask.')
  expect(roleLine('agent')).toBe('Finish the unit in progress, report to your orchestrator with your measured context, and stop; no new phase is dispatched to you.')
  expect(roleLine('coordinator')).toContain('skills/coordination/SKILL.md')
  expect(roleLine('auditor')).toContain('auditor-succession-brief.md')
  expect(roleLine('none' as any)).toBe('')
})

test('the announcement names what was read', () => {
  const a = gateAnnouncement({ tripped: true, words: '80% (gate 80%)' }, 'agent')
  expect(a).toBe('CONTEXT GATE: this session is at 80% (gate 80%). ' + roleLine('agent'))
})

test('below the gate nothing is said', () => {
  expect(gateAnnouncement({ tripped: false, words: '' }, 'orchestrator')).toBe('')
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```typescript
// hooks/guards.ts — the context gate half (push and stop halves land in Tasks 6-8)
import { roleOf } from './session-name.ts'
import { tripGate, parseMeasure, measureFilePath } from './gauge-core.ts'
import { configDir } from './gauge.ts'

export function roleLine(role: string): string {
  // Verbatim from hooks/context-gate.sh:57-63 — the four role answers.
  switch (role) {
    case 'orchestrator': return 'Succeed at the next quiet boundary — run /orchestrator:succeed: spawn the successor in the operator\'s decision mode, then tell the user; do not ask.'
    case 'agent': return 'Finish the unit in progress, report to your orchestrator with your measured context, and stop; no new phase is dispatched to you.'
    case 'auditor': return 'Report not written, or nothing the operator gave you after it: write the one report with what you have read, and stop. Work he gave you after the report still in hand: succeed — templates/auditor-succession-brief.md; tell him before you hand over.'
    case 'coordinator': return 'With no relay in flight, succeed as skills/coordination/SKILL.md « Your context » says, then tell the operator.'
    default: return ''
  }
}

export function gateAnnouncement(gate: { tripped: boolean; words: string }, role: string): string {
  if (!gate.tripped) return ''
  return `CONTEXT GATE: this session is at ${gate.words}. ${roleLine(role)}`
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => unknown) {
  let saidUnmeasured = false
  on('prompt.submit', async ($: any, e: any, next: (e: any & { context?: string }) => any) => {
    try {
      const { name } = await readName($, e.transcript_path ?? '')
      const role = roleOf(name)
      if (!role) return next(e)                       // a session never spoken to
      const sessionId = await $.session.id()
      let raw: string | null = null
      try { raw = await $.fs.read(measureFilePath(await configDir($), sessionId)) } catch { /* no file yet: unmeasured */ }
      const reading = parseMeasure(String(raw ?? ''))
      if (!reading) {
        if (!saidUnmeasured && await transcriptHasAnswer($, e.transcript_path ?? '')) {
          saidUnmeasured = true
          return next({ ...e, context: joinContext(e.context, `CONTEXT GATE: unmeasured: the measure file carries no figure; the next turn fills it. The gate (80%, or 300,000 tokens on a window of 1,000,000 or more) cannot be read; measure by hand before dispatching or rotating.`) })
        }
        return next(e)
      }
      const gate = tripGate(reading.context_percent, reading.context_tokens, reading.context_window, gateEnv())
      const announcement = gateAnnouncement(gate, role)
      if (announcement) return next({ ...e, context: joinContext(e.context, announcement) })
    } catch (err) { /* a gate that cannot measure lets the prompt through */ }
    return next(e)
  })
}
```

`joinContext(existing, line)` concatenates with a newline; `gateEnv()` reads `ORCHESTRATOR_CONTEXT_GATE`, `ORCHESTRATOR_CONTEXT_GATE_TOKENS` and `ORCHESTRATOR_LARGE_WINDOW` through `$.env.get` and returns the `env` object `tripGate` takes; `transcriptHasAnswer` checks the transcript for one `"type": "assistant"` entry through the same block reader as Task 4 (the first-prompt case stays silent, `context-gate.sh:113-135`). Block-reader law, verified by Task 4: `$.fs.read` offers no ranges and refuses past 4 MiB — reads go through bounded `dd if=<path> bs=65536 skip=<n> count=1` windows via `$.process.run` (argv-only, no pipes), carrying the cut first line on every block except the file-starting one (`title_in()`'s rule — the sketch's inverted condition corrupted boundary lines and was ruled out at the Task 4 review).

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Live smoke** — rename the session `Orch : x`, fill past 80 % (or set `ORCHESTRATOR_CONTEXT_GATE=1`), send a prompt, see the line.

- [ ] **Step 6: Commit**

```bash
git add hooks/
git commit -m "feat(guards): speak the context gate from the module on every prompt"
```

### Task 6: tokenizer — the push tokeniser, ported to TypeScript

**Files:**
- Create: hooks/tokenizer.ts
- Test: hooks/tests/tokenizer.test.ts

**Interfaces:**
- Consumes: nothing.
- Produces: `detectForces(command: string): string[]` — every reason a `git push` in the command line is forced, empty when none. Ported from the awk tokeniser in hooks/push-guard.sh:49-219, whose header comment (`push-guard.sh:14-27`) is the specification.

- [ ] **Step 1: Write the failing tests — the fixtures move, they do not shrink**

```typescript
// hooks/tests/tokenizer.test.ts
import { expect, test } from 'claude-code/testing'
import { detectForces } from '../tokenizer.ts'

const refused = [
  'git push --force origin main',
  'git push -f origin main',
  'git push origin +feature:main',
  'git push --force-with-lease origin main',
  'git push --force-with-lease=main origin main',
  'git -C /tmp/r push --force',
  'git -C . push --force-with-lease',
  'git -c x=y push -f',
  'git --no-pager push -f',
  '/usr/bin/git push -f origin main',
  'git --git-dir=/tmp/r/.git --work-tree /tmp/r push -f',
  'FOO=1 git push -f',
  'timeout 60 git push --force origin main',
  'env -u X git push -f',
  'git push -uf origin main',
  'git push -fu origin main',
  'git push -vf',
  'git push -nf',
  '(cd x && git push -f)',
  'git push -f)',
  'git push "-f"',
  'git push origin "+main"',
  "git push origin 'a:b' '+x'",
  'git push -f`true`',
  'git push -f>out',
  '{ git push -f; }',
  'git push origin main 2>/dev/null --force',
  'git push \\\n  --force origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease=other origin main',
  'git push --mirror origin',
  'git push --fo origin main',
  'git push --for origin main',
  'git push --forc origin main',
  'git commit -F - <<\'EOF\'\ngit push --force\nEOF\ngit push -f',   // heredoc body is data; the real push after it is read
]

const accepted = [
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main',
  'git push origin main',
  'git status',
  'git fetch -f && git push origin main',
  'git push -o +foo origin main',
  'git push -o+foo -v origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease=dev:' + 'a'.repeat(40) + ' origin main dev',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main 2>&1 | tail -3',
  'git commit -m "fix; git push -f later"',
  'gh pr create --body "rebase && git push --force is refused"',
]

test('every forced form the shell suite refused is refused here', () => {
  for (const c of refused) expect(detectForces(c), c).not.toEqual([])
})

test('everything the shell suite accepted is accepted here', () => {
  for (const c of accepted) expect(detectForces(c), c).toEqual([])
})
```

The remaining cases from tests/run-tests.sh:3410-3430 (comment lines, `$((...))` arithmetic containing `<<`, nested quotes in the delimiter, and the Unicode command line) move into these two arrays the same way — read them from the shell suite while porting; nothing is dropped.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Port the tokeniser**

Structure — a line-for-line port of the awk functions, same names, same order:

```typescript
// hooks/tokenizer.ts
// Ported from the awk tokeniser in hooks/push-guard.sh. The specification is the
// header comment of that script: the command line is tokenised the way the shell
// reads it, and only a command whose first word is git followed by its global
// options and `push` is read for a force.

// Words that end a simple command or open a group — the shell's own reserved set.
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', '{', '}', '(', ')', '!', 'in'])
// Commands that wrap the real one: everything until a word that is not an option
// of the wrapper is skipped before the real command is read.
const WRAPPER = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'sudo', 'xargs'])
// git global options that take a value: `git -C /tmp/r push --force` pushes.
const GITVALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
// push options that take a value: `git push --repo x --force-with-lease` still forces.
const PUSHVALUED = new Set(['--repo', '--push-option', '--receive-pack', '--exec'])
const SHA = /^[0-9a-f]{40}$/

export function detectForces(command: string): string[] {
  const found: string[] = []
  const seen = (reason: string) => { if (!found.includes(reason)) found.push(reason) }
  // The port keeps the awk script's shape, one function per awk function:
  //   push()/pop()     — the depth stack with each opener's closer
  //   flushWord()      — a finished word joins the current simple command
  //   flushCmd()       — a finished simple command goes to analyze()
  //   arith()          — skip $((...)) whole, it may contain `<<`
  //   heredoc()        — read <<[-]"delim" and fast-forward past its body lines
  //   analyze()        — assignments, then wrappers (skipping their options and
  //                      their option arguments), then: git + valued global
  //                      options + `push` + valued push options, and the force
  //                      rules on the remaining words:
  //                        --force, or an abbreviation of it (>= --fo, prefix match)
  //                        -f alone, or -f inside a short cluster (-uf, -fu)
  //                        --mirror
  //                        +<refspec>, bare or quoted
  //                        --force-with-lease with no =, or =<branch> with no :<sha>,
  //                          or =<branch>:<sha> where sha is not 40 hex chars
  //   Everything else — non-git commands, heredoc bodies, comments, text in
  //   quotes that is an argument not an option — is data and never a force.
  return found
}
```

Each awk function maps to one TypeScript function with the same behaviour and the same test coverage; the awk source stays in the repo until Task 12 and is deleted only after the fixtures pass against the port. When a case fails, fix the port, never the fixture.

- [ ] **Step 4: Run until green** — `cd hooks && claude plugin test ..`. This is the highest-risk port of the plan; when a case fails, fix the port, never the fixture.

- [ ] **Step 5: Commit**

```bash
git add hooks/tokenizer.ts hooks/tests/tokenizer.test.ts
git commit -m "feat(guards): tokenize shell command lines for the push guard in-process"
```

### Task 7: guards — the push guard on tool.call

**Files:**
- Modify: hooks/guards.ts
- Test: hooks/tests/push-guard.test.ts

**Interfaces:**
- Consumes: `detectForces` (Task 6).
- Produces: `pushDecision(spawned: string | null | undefined, command: string): { deny: string } | null` — pure, exported from `guards.ts`; the `tool.call` handler is a thin wiring around it.
- Carries (Task 6 review minor, adjudicated to this task — it acquires the consumer of the reason strings): a one-line comment at `seen` in hooks/tokenizer.ts records the deliberate widening — the port dedups reasons by exact match where the awk dedups by substring, so the module's « Seen: … » can name a reason the shell guard suppressed (verdicts identical; pinned by the reviewer's differential).

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/push-guard.test.ts
import { expect, test } from 'claude-code/testing'
import { pushDecision } from '../guards.ts'

test('a marked session refuses a forced push and names the lease it accepts', () => {
  const d = pushDecision('1', 'git push --force origin main')
  expect(d?.deny).toContain('git push refused')
  expect(d?.deny).toContain('--force-with-lease=<branch>:<sha>')
})

test('an unmarked session and an unforced push both pass', () => {
  expect(pushDecision(undefined, 'git push --force origin main')).toBeNull()   // the operator's own sessions
  expect(pushDecision('1', 'git push origin main')).toBeNull()
  expect(pushDecision('1', 'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main')).toBeNull()
})

test('a command the guard cannot read passes', () => {
  expect(pushDecision('1', '')).toBeNull()
})
```

- [ ] **Step 2: Run to verify failure** (no `pushDecision` exported).

- [ ] **Step 3: Implement the decision and the handler in guards.ts**

```typescript
export function pushDecision(spawned: string | null | undefined, command: string): { deny: string } | null {
  if (!spawned) return null                        // the operator's own sessions: untouched
  const forces = detectForces(command)
  if (forces.length === 0) return null
  return { deny: `git push refused: this session was spawned by the launcher, and the only forced push allowed here is --force-with-lease=<branch>:<sha> with the sha you read. Seen: ${forces.join(', ')}. If the command only mentions a push, put text that mentions a push in a file (\`git commit -F\`, \`gh … --body-file\`).` }
}
```

The denial text is carried over verbatim from `push-guard.sh:226`; the handler wires it:

```typescript
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: (e: any) => any) => {
    try {
      const spawned = await $.env.get('ORCHESTRATOR_SPAWNED')
      const decision = pushDecision(spawned, String(e.input?.command ?? ''))
      if (decision) return decision                 // the exact deny shape comes from the generated types
      return next(e)
    } catch (err) {
      // A guard that cannot read its input lets the call through and says so.
      return next(e)
    }
  })
```

The `deny` return shape is verified against the generated types (`.claude-plugin/types/`) at implementation time — the settings-hook `PermissionDecision` phrasing and the module's may differ; the module's types win.

- [ ] **Step 4: Run tests, live smoke** (spawn a session through the launcher, try a forced push, read the refusal).

- [ ] **Step 5: Commit**

```bash
git add hooks/
git commit -m "feat(guards): refuse the forced pushes the launcher forbids, in-process"
```

### Task 8: guards — the stop gate on classic.Stop

**Files:**
- Modify: hooks/guards.ts
- Create: hooks/stop-gate.ts (the ported logic: listing, wake check, heads, CI read)
- Test: hooks/tests/stop-gate.test.ts

**Interfaces:**
- Consumes: `readName` (exported from hooks/guards.ts since Task 5's restructure — the `$` fence), `roleOf` (hooks/session-name.ts), `$.process.run`, `$.fs.read`, ci-watch's precomputed files under the state dir.
- Sandbox facts (verified by Task 4 against the shipped types): `$.fs.read` offers no ranges and refuses past 4 MiB — transcript reads go through bounded `dd if=<path> bs=65536 skip=<n> count=1` windows via `$.process.run` (argv-only, no pipes), the pattern hooks/session-name.ts established; `$.fs.stat` gives the size; the cut first line carries on every block except the file-starting one.
- Ratified at the Task 8 report (the shipped types and `stop_gate.py` over the sketch, each pinned by a wiring test): the block decision is `{ block: reason }` (the types' `ClassicResult` — a `decision` field would fail the hook silently); `transcript_path` IS on the classic.Stop event (`StopHookInput`), `transcriptPathOf` staying as the fallback; a busy own agent RELEASES the stop (`stop_gate.py:363-364` — the sketch's third test inverted the semantics the shell suite pins); the module keeps its own `.mheads` beside the shell's `.heads` until retirement (their tell tokens differ); ci-watch's logs carry no sha, so the tell is the log's mtime; check 2 reads the ci-watch logs and `git remote get-url origin`, never synchronous gh. At the review: check 2's log universe is scoped to the session's repository — the slug of the log names derived the way ci-watch itself derives it, with any residual widening declared at the listing — and the draft-guard filter is dropped by declaration: the logs carry no draft flag, and `ignored-checks` is the operator's fallback for exactly that (the shell suite pins it).
- The stop-time sweep is this task's scope (design.md, « The sweep runs by itself » — the brief's port list omitted it, caught at the report and ported in fix round 1): Orch-scoped passing stops only, never after a refusal, the deadline remainder minus the margin, once per ten minutes through the shell gate's own `<state>/sweep.stamp` (a time token — one file coordinates both gates until Task 12), the stamp written before the run so a hung sweep is not retried by every stop, each deletion one log line, never a refusal.
- Carries (Task 7 review minor, adjudicated): the fake `on` in each test file stays per-file — self-contained test files are this suite's convention; the third copy this task writes does not extract a shared helper. From the Task 4 review: the transcript walk scans from the end and the first hit ends it — a huge transcript with no rename costs one dd window per 64 KiB at worst.
- Produces: `withDeadline(work, ms)` — the race the Step 2 test imports; the name follows `stop_gate.py`'s own deadline vocabulary, because the suite's policy sweep refuses the word "budget" anywhere under hooks/ (the pre-flight ruling's `withBudget` name is superseded on that ground). Also `checkWake(...)`/`checkCi(...)` ports and a `classic.Stop` handler answering the same block decision as `stop_gate.py:647-651`. The handler registers in guards.ts, where `$` and `readName` live — hooks/stop-gate.ts holds the ported logic over plain values, the $-holding reads happening in the handler and their results passing in. The module event carries no `transcript_path`: locate the transcript by session id under `<config>/projects/*/<sessionId>.jsonl`, the way guards.ts's `transcriptPathOf` does (memoized per load), and verify the event's real field names against the generated types.

- [ ] **Step 1: Verify the blocking contract first**

Load the module with `--plugin-dir`, read `.claude-plugin/types/claude-code/index.d.ts`, search `classic.Stop`. The handler must be able to answer `{"decision":"block","reason":…}`. If it cannot, stop and apply the spec's contingency (keep the `Stop` settings hook one release longer) — say so before continuing.

- [ ] **Step 2: Write the failing tests — Review Focus 2 lives here**

```typescript
// hooks/tests/stop-gate.test.ts
import { expect, test } from 'claude-code/testing'
import { refuse, wakeDecision, withDeadline } from '../stop-gate.ts'

test('a refusal is the documented shape', () => {
  expect(refuse('an agent of yours is still busy')).toEqual({ decision: 'block', reason: 'an agent of yours is still busy' })
})

test('a stop with nothing to wake it passes', () => {
  expect(wakeDecision({ busyOwnAgents: [], blockingQuestion: null, openRows: [] })).toEqual({ decision: 'pass' })
})

test('a busy own agent holds the stop', () => {
  expect(wakeDecision({ busyOwnAgents: ['Agent : belt-p3'], blockingQuestion: null, openRows: [] }).decision).toBe('block')
})

test('a CI read that exceeds its time bound degrades to pass-and-log', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 250))
  const outcome = await withDeadline(slow, 10)
  expect(outcome.decision).toBe('pass')
})
```

`withDeadline(work, ms)` races the work against a timer and answers the degraded pass when the work loses the race; the stop gate wraps every `$.process.run`/`$.fs.read` in it — a gate that cannot read in time lets the stop pass, and the log says so.

- [ ] **Step 3: Port the logic**

Port `stop_gate.py` function by function into hooks/stop-gate.ts, same names, same split: `listing()` and `ownAgents()` over the launcher's listing (through `$.process.run`), `pullRequestOf()`, `checkWake()` (`stop_gate.py:356-395`), `headsPath()/readHeads()/writeHeads()` on `$.fs`, `checkCi()` (`stop_gate.py:537-595`) reading ci-watch's precomputed data — no synchronous network, everything through `withDeadline`. The `classic.Stop` handler: read `e` (its real fields verified against the generated types — `stop_hook_active` and the session id at least; no `transcript_path`, the transcript comes through `transcriptPathOf`), refuse at most once per turn, log and pass on any failure.

- [ ] **Step 4: Run tests, live smoke** (an orchestrator with a busy agent refuses to stop once, then passes).

- [ ] **Step 5: Commit**

```bash
git add hooks/
git commit -m "feat(guards): hold a stop until something will wake the orchestrator"
```

### Task 9: supervision — the shared store

**Files:**
- Create: hooks/supervision.ts
- Modify: hooks/register.ts
- Modify: hooks/session-name.ts, hooks/guards.ts (the name walk's pure core moves home; `readName` delegates, behavior unchanged)
- Test: hooks/tests/supervision.test.ts

**Interfaces:**
- Consumes: `currentReading()` from `gauge.ts` (plain import, no `$`), `roleOf` from `session-name.ts` (pure), and the name walk's pure core — extracted this task into `session-name.ts` over injected plain reader thunks (`run`, `readText`), with `guards.ts`'s `$`-holding `readName` delegating to it unchanged in behavior. The `$` fence forbids importing `readName` itself into supervision.ts, and duplicating the walk would be the standing duplication finding; the Global Constraints' own pure/$-holding split is the shape.
- Produces: store key `sessions/<session-id>` → `{ role, name, repo, context_percent, context_tokens, window, model, busy, updated_at }` (`type SessionRow`); `writeSession($: any, id: string, patch: Partial<SessionRow>): Promise<void>`, `readSessions($: any): Promise<Record<string, SessionRow>>`, `deleteSession($: any, id: string): Promise<void>`, `sessionKey(id: string): string`.
- Carries (Task 3 review minors, adjudicated to this task — it already edits gauge.ts for the session.end hook): the `session.end` handler's empty catch logs one line through `logLine` before passing through (the plan's every-handler-logs rule); the fake `on` in `hooks/tests/gauge-band.test.ts` stores the matcher it receives and the wiring test asserts the `ui.render` registration carries `{ component: 'AbovePrompt' }` — a bare two-argument registration would pass every test while drawing on every component.

- [ ] **Step 1: Write the failing tests — Review Focus 4 lives here**

```typescript
// hooks/tests/supervision.test.ts
import { expect, test } from 'claude-code/testing'
import { writeSession, readSessions, sessionKey } from '../supervision.ts'

test('the key is per session id', () => {
  expect(sessionKey('abc')).toBe('sessions/abc')
})

test('two sessions writing at once keep both rows', async ($) => {
  await writeSession($, 'first', { role: 'agent', context_percent: 40 })
  await writeSession($, 'second', { role: 'agent', context_percent: 55 })
  const rows = await readSessions($)
  expect(rows['sessions/first'].context_percent).toBe(40)
  expect(rows['sessions/second'].context_percent).toBe(55)
})

test('a session end removes its row', async ($) => {
  await writeSession($, 'gone', { role: 'agent', context_percent: 10 })
  await deleteSession($, 'gone')
  expect((await readSessions($))['sessions/gone']).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — `writeSession` reads the key, merges the patch, writes back (per-key writes do not collide across sessions); hooks into `session.measure` and `session.end` with its OWN registered handlers in supervision.ts — the `$` fence forbids gauge.ts calling an imported `writeSession($)`; the fresh figure comes through `currentReading()` (imported plain, no `$` argument), and the `$.fs` calls live in supervision.ts's handlers. A consumer that did not receive `$` (commands.ts, Task 11) reads the store through its own `$.fs` call plus supervision.ts's pure row parser. Stale rows: `readSessions` drops rows whose `updated_at` is older than one hour. The store lives under the module's state root, `<config>/claude-orchestrator/store/`, one file per key (`$.fs.write` creates the directories) — Review Focus 4's two-session write is per-key by construction. The measure handler fills the figures and `model` from `currentReading()`, `role`/`name` through the extracted core over supervision.ts's own readers, `repo` through its own one-line `git remote get-url origin` read (the per-file convention — `repositoryOf` is `$`-holding in guards.ts), `busy` defaulting false. `deleteSession` removes the row: verify whether `$.fs` offers a remove and use it if so; else truncate the key's file to empty and let the row parser read an absent, empty or unparseable row as no row — the measure-file doctrine, the one-hour staleness collecting the rest.

- [ ] **Step 4: Run tests, commit**

```bash
git add hooks/
git commit -m "feat(supervision): share every session's state through the host store"
```

### Task 10: supervision — the coordinator pane

**Files:**
- Modify: hooks/supervision.ts
- Test: hooks/tests/pane.test.ts

**Interfaces:**
- Consumes: `readSessions` (Task 9), `roleOf`.
- Produces: `paneRows(rows: Record<string, SessionRow>): { label: string; urgency: number }[]` sorted by rotation urgency (fill past the gate first, then fill descending).
- Carries (Task 9 review minors, adjudicated to this task — it edits supervision.ts): the measure handler's name walk and origin read take `withDeadline` (imported plain from stop-gate.ts — pure, no `$` crosses), matching guards.ts's bounded reads; a one-line comment at `writeSession` records the single-writer-per-key property (the measure handler is the only writer of a key; a same-key race is last-writer-wins, at most one measure of freshness). Registration facts: `session.start` is already bare-registered by the scaffold, so this task's second registration carries `{}` with the role check inside the handler; `ui.render` is already registered with `{ component: 'AbovePrompt' }` by gauge — the pane's registration carries its own real matcher, its component and pane names spelled from the shipped types, where the band handler (gauge.ts) is the working precedent for the render shape.

- [ ] **Step 1: Failing test**

```typescript
import { paneRows } from '../supervision.ts'
test('rows sort by rotation urgency', () => {
  const rows = paneRows({
    'sessions/a': { role: 'agent', name: 'Agent : low', context_percent: 30, context_tokens: 30000, window: 100000, model: 'a-model', busy: false, updated_at: 't', repo: 'r' },
    'sessions/b': { role: 'agent', name: 'Agent : hot', context_percent: 85, context_tokens: 85000, window: 100000, model: 'a-model', busy: true, updated_at: 't', repo: 'r' },
  })
  expect(rows[0].label).toContain('Agent : hot')
  expect(rows[0].label).toContain('85%')
})
```

- [ ] **Step 2: Implement** — on `session.start`, if the session's role is coordinator or orchestrator, `$.ui.open` a dock pane; on `ui.render { component: 'Pane' }` with our pane id, render one `Text` row per `paneRows` entry. Display only.

- [ ] **Step 3: Run tests, live smoke (a coordinator session shows the pane), commit**

```bash
git add hooks/
git commit -m "feat(supervision): show the supervised sessions in a dock pane"
```

### Task 11: commands — status, progress, agents become instant

**Files:**
- Create: hooks/commands.ts
- Modify: hooks/register.ts
- Test: hooks/tests/commands.test.ts

**Interfaces:**
- Consumes: supervision.ts's pure exports — `parseSessionRow`, `paneRows`, and the one-hour staleness rule (exported pure — `isStale(row, nowMs)` or equivalent — if Task 9 left it inside the `$`-holding reader); `parseMeasure`. The store read inside commands.ts is its own `$.fs.list`/`$.fs.read` calls over the same root — `readSessions($)` cannot cross an import — composing parser, staleness and `paneRows`; the progress command's dispatch-record tail read is its own bounded `$.fs` read (`withDeadline`, plain import), its path and format verified against the launcher's own record.
- Produces: three registered commands answering `{ text }` without a model turn.

- [ ] **Step 1: Failing test**

```typescript
// hooks/tests/commands.test.ts
import { expect, test } from 'claude-code/testing'

test('/orchestrator:status lists live sessions with their fill', async ($) => {
  const answer = await $.command.run({ command: 'orchestrator:status', args: '' })
  expect(typeof answer.text).toBe('string')
  expect(answer.text).not.toContain('CONTEXT GATE')
})
```

`$.command.run` is the documented test-harness entry; if the harness emits no `session.start` first, the registration riding `session.measure` (below) fires on the first measure instead — one of the two always precedes a `command.run` in a live session, and the test's failure would say so immediately.

- [ ] **Step 2: Implement**

```typescript
// hooks/commands.ts
import { readSessions, paneRows } from './supervision.ts'

const REGISTERED = new Set<string>()

async function registerCommands($: any): Promise<void> {
  // Idempotent: the first event that carries $ registers the three commands,
  // whichever comes first (session.start, or the first session.measure).
  const commands = [
    { name: 'orchestrator:status', description: 'Live sessions with their measured context fill' },
    { name: 'orchestrator:progress', description: 'Where the build stands — done, in flight, remaining, decisions pending' },
    { name: 'orchestrator:agents', description: 'Each running implementer agent\'s progress, with its measured context' },
  ]
  for (const c of commands) {
    if (REGISTERED.has(c.name)) continue
    await $.command.register(c)
    REGISTERED.add(c.name)
  }
}

export function register(on: (...args: [event: string, handler: Function] | [event: string, matcher: object, handler: Function]) => unknown) {
  for (const event of ['session.start', 'session.measure']) {
    on(event, {}, async ($: any, e: any, next: (e: any) => any) => {
      await registerCommands($).catch(() => undefined)
      return next(e)
    })
  }
  on('command.run', { command: 'orchestrator:status' }, async ($: any) => {
    const rows = paneRows(await readSessions($))
    return { text: rows.length === 0 ? 'no live sessions' : rows.map((r) => r.label).join('\n') }
  })
  // progress and agents: same shape, their own rows (progress adds the dispatch
  // record tail read through $.fs; agents filters to role === 'agent').
}
```

Command names were verified against the shipped types and the live engine, and the ratified shape (Task 11) is hooks-only: `CommandSpec`'s name charset refuses colons and the bare spellings `status` and `agents` are the host's own built-ins, so no registration can carry the spellings the person knows. The commands are served by `command.run` hooks matching the markdown invocations (`orchestrator:status|progress|agents`), answering `{ text }` without `next`; the `commands/*.md` files STAY as the typeahead entries and the degraded fallback a failed hook falls through to — deleting them would unhook the invocations entirely. The spec's register-and-delete line (commands.ts section) is void on its mechanics the way every engine refusal has voided a sketch; its intent — instant answers, no model turn — is delivered. The store read inside commands.ts is its own `$.fs` call plus supervision.ts's pure row parser — `readSessions($)` cannot cross an import (the `$` fence, Task 5's law); the sketch's line adjusts accordingly, and every `on(...)` chains `.catch(handler)` inline. The sketch's registration loop carries `{}` on both events (third registrations — the scaffold or gauge took the bare slot, supervision the second) and chains its `.catch` at the registration site, not around the awaited body. The `command.run` matcher's field names are spelled from the shipped types — matcher keys are validated nowhere — and the exact matcher objects are pinned by wiring tests. What coexistence with the markdown commands of the same names does mid-migration is declared from the engine's own answer, not guessed.

- [ ] **Step 3: Run tests, live smoke (`/orchestrator:status` answers while a turn runs), commit**

```bash
git add hooks/
git commit -m "feat(commands): answer status, progress and agents without a model turn"
```

### Task 12: the cutover — remove the shell pipeline

**Files:**
- Delete: hooks/context-gate.sh, hooks/push-guard.sh, hooks/stop-gate.sh, hooks/stop_gate.py, hooks/session_name.py, skills/context-gauge/ (both scripts and the SKILL.md) — deleted by this very task, so named without the backticks the link checker reads as pointers
- Keep: `commands/status.md`, `commands/progress.md`, `commands/agents.md` — Task 11's ratified shape serves the three commands through `command.run` hooks on these spellings; the files are the typeahead entries and the degraded fallback, and deleting them would leave the invocations unhooked (the engine refuses the registered spellings — charset and built-ins).
- Modify: `hooks/hooks.json` (drop the three settings-hook blocks), `hooks/commands.ts`, `hooks/guards.ts` (Step 4's override alignment), `install.sh`, `uninstall.sh`, `docs/design.md` (section 4.4)
- Test: `./tests/run-tests.sh` (the shell suite, updated), `hooks/tests/commands.test.ts` and `hooks/tests/stop-gate.test.ts` (the override wiring)

- [ ] **Step 1: Remove the settings hooks from hooks.json** — only `modules` remains.

- [ ] **Step 2: install.sh — three changes**
  1. Version floor: refuse to install below host 2.1.287 (`claude --version` parsed, error line names the floor).
  2. Unwrap the tap: restore `statusLine.command` from the saved previous object (`$STATE_DIR` holds it), or strip the tap prefix if no save exists — the inverse of `install.sh:138-162`.
  3. Purge `ctx/` and stale `measure/` files older than a day; create `measure/` (`$.fs.write` creates the stop-gate state directory itself — the shipped types' own doc; the Task 8 report's concern was void).

- [ ] **Step 3: uninstall.sh** — drop the measure directory and the hooks-module log alongside the existing cleanup.

- [ ] **Step 4: Align the module's shared-artifact roots on ORCHESTRATOR_STATE_DIR**

The surviving writers of the dispatch-records registry and the ci-watch logs (`dispatch-record.sh:59`, `ci-watch.sh`) honor `ORCHESTRATOR_STATE_DIR` before the config dir, while the module's readers — `commands.ts:134`'s registry and the stop gate's state root at `guards.ts:290` — resolve the config dir alone: under the documented override (design.md, section 4.4) `/orchestrator:progress` answers "no dispatch record registered" forever and the stop gate's check 2 reads no watch (the Task 11 review's Important 1; the Task 8 parked boundary ends here, not at the shell gate's retirement — the writers survive it). The stop gate's whole state root and the registry root gain the resolution the shell gate had: `ORCHESTRATOR_STATE_DIR` (through `$.env.get`, literal, at each call site — the `$` fence) else `<config>/claude-orchestrator`. The module's own artifacts — the measure file, the store, `hooks-module.log`, the module's stamp — stay under the config dir: the spec places them there and no surviving script shares them. One wiring test per site pins both branches (override set / absent), and design.md section 4.4 is rewritten in the same commit to name the new sharing.

- [ ] **Step 5: Update the shell suite** — delete the push-guard Bash-level cases (they live now in `tokenizer.test.ts`), the tap cases, the context-gauge.sh cases, and the stop-gate hook section (its cases live now in `hooks/tests/stop-gate.test.ts`, the sweep included); add: `install.sh` on a settings.json with a tap wiring unwraps it (fixture file), and the version-floor refusal.

- [ ] **Step 6: Full run + live smoke**

Run: `./tests/run-tests.sh && cd hooks && claude plugin test .. && claude plugin validate ..`
Live: fresh session through the launcher — band shows, gate speaks past 80 %, forced push refused, stop held with a busy agent, `/orchestrator:status` instant.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(hooks): cut over to the module — the tap, ctx/ and the shell gates are gone

The tap read the host's own status line to guess its context; the module asks the
host. The gates paid a process spawn per event; the module answers in-process.
One measure file per session remains, the only channel external processes read."
```

### Task 13: skills shrink and evals

**Files:**
- Modify: `skills/orchestrator/SKILL.md` (sections `Thresholds`, `Where the rest lives`), `skills/coordination/SKILL.md` (`Your context`)
- Modify: the eval set under `evals/` where it references `context-gauge.sh` or the tap
- Test: `./tests/run-tests.sh` (the rulebook assertions it carries)

- [ ] **Step 1: `Thresholds`** keeps the behavior (when to rotate, the 80 %/300,000 rule as a fact the band and the gate already enforce) and loses the measurement instructions — the how is code now. Target: ~350 tokens out.
- [ ] **Step 2: `Where the rest lives`** points to the module and the measure file, not the tap or `ctx/`.
- [ ] **Step 3: `coordination`'s state sections** say "read the live state with /orchestrator:status" instead of the reconstruction story.
- [ ] **Step 4: Eval sweep** — `grep -r 'context-gauge\|statusline-tap\|ctx/' evals/ skills/ templates/` returns only the intentional references; each hit is either updated or justified.
- [ ] **Step 5: Run `./tests/run-tests.sh`; commit**

```bash
git add skills/ evals/
git commit -m "docs(skills): the module owns the facts, the rulebook keeps the judgment"
```

### Task 14: release 0.49.0

**Files:**
- Modify: `.claude-plugin/plugin.json` (version `0.49.0`), `README.md`, the marketplace manifest in `LounisBou/claude-plugins-marketplace`

- [ ] **Step 1: README** gains one line naming the host version the release was tested against (2.1.292), and the install section states the 2.1.287 floor.
- [ ] **Step 2: Version and marketplace bump** — plugin.json to 0.49.0, the marketplace entry to the same.
- [ ] **Step 3: Full gates then release**

Run: `./tests/run-tests.sh && cd hooks && claude plugin test .. && claude plugin validate .. && grep -rniI 'claude' . --exclude-dir=.git` (only exempt occurrences), then the usual release flow.

```bash
git commit -m "chore: release 0.49.0"
```

### Task 15: bugs-bot 0.2.0 — the coordinated release

**Files** (in `~/dev/claude-bugs-bot`):
- Modify: `bugs_bot/gate.py` (measure source), `.claude-plugin/plugin.json` (dependency floor), tests/test_gate_measure.py, tests/test_succession.py, skills/bugs-bot/SKILL.md, `agent/AGENT.md`

**Interfaces:**
- Consumes: `~/.claude/claude-orchestrator/measure/<session-id>.json`, one line, the `MeasureReading` shape of Task 2.

- [ ] **Step 1: Failing test — Review Focus 1 lives here too**

```python
# tests/test_gate_measure.py — the measure-source half rewritten
def test_reads_the_module_measure_file(tmp_path):
    measure = tmp_path / "measure" / "s1.json"
    measure.parent.mkdir(parents=True)
    measure.write_text('{"context_tokens":310000,"context_window":1000000,"context_percent":31,"model":"a-model","updated_at":"t"}\n')
    out = gate.read_measure(measure)
    assert out["context_tokens"] == 310000

def test_a_partial_line_reads_as_unmeasured(tmp_path):
    measure = tmp_path / "measure" / "s2.json"
    measure.parent.mkdir(parents=True)
    measure.write_text('{"context_tokens":3100')
    assert gate.read_measure(measure) is None
```

- [ ] **Step 2: Implement** — `gate.py` drops `GAUGE_GLOB` and the `context-gauge.sh` execution (`gate.py:20` and the exec path); `read_measure(path)` replaces the parsing of the script's output; the `gate_tokens=`/`context_tokens=`/`context_window=`/`handover=` line keeps its exact shape. `--measure` finds the file by the session id it already carries.
- [ ] **Step 3: Floor and docs** — `plugin.json` dependency becomes `orchestrator@lounisbou >= 0.49`; SKILL.md and AGENT.md keep their "one plain command" wording (the command is unchanged, only its source moved).
- [ ] **Step 4: Run the bugs-bot suite** (`python -m pytest`), fix `test_succession.py`'s stub gauge references to the measure file, release 0.2.0 with the marketplace bump — in the same window as Task 14.

```bash
git commit -m "feat(gate): read the module's measure file instead of running the gauge script"
```
