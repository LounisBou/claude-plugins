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

// The module sandbox exposes no process global: the config dir is resolved
// through the host's env surface by the caller that holds $ (gauge.ts), then
// handed in — the pure half stays testable, the impure half stays in one place.
export function measureFilePath(config: string, sessionId: string): string {
  return `${config}/claude-orchestrator/measure/${sessionId}.json`
}

export function parseMeasure(line: string): MeasureReading | null {
  // $.fs.write is not atomic: a line caught mid-write is data, and every reader
  // treats it as unmeasured rather than crashing (gate.py reuses the same rule).
  // A line that parses but lacks a figure is unmeasured too.
  try {
    const reading = JSON.parse(line) as MeasureReading
    return reading && hasFigures(reading) ? reading : null
  } catch {
    return null
  }
}

// The host leaves the token count and the percentage out until the session's
// first answer (SessionContextUsage marks both optional): a reading without
// all three figures is no reading, never a figure of undefined.
export function hasFigures(r: { context_tokens?: unknown; context_window?: unknown; context_percent?: unknown }): boolean {
  return [r.context_tokens, r.context_window, r.context_percent].every(n => typeof n === 'number' && Number.isFinite(n))
}
