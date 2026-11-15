// tier — the model and effort the operator's tier map binds to a tier (`resolve-tier`, and a
// spawn given --tier). The map is ORCHESTRATOR_MODELS_MAP, else `models.json` in the launcher's
// state directory; ORCHESTRATOR_TIER_<TIER> overrides one binding for one run.
//
// A binding is a model, `model/effort`, or {"model": …, "effort": …}. An unbound tier, or no map
// at all, answers an empty pair: the host's own default applies. A map that does not read is
// refused, never read as unbound: one missing comma would route every dispatch to the default in
// silence. A versioned model is said on stderr, never refused nor rewritten: the map is the operator's.
import { join } from 'node:path'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const EFFORT_LIST = 'low, medium, high, xhigh or max'

/** A refusal of the launcher's, said `ERROR: <message>` with exit 1. */
export class Refused extends Error {}

export const TIERS = ['deep', 'standard', 'light'] as const

export interface TierPair {
  readonly model: string
  readonly effort: string
}

export interface TierDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  /** The map's text, or null when no file is there. */
  readonly read: (path: string) => string | null
  readonly warn: (line: string) => void
}

/** The launcher's state directory, as every launcher command reads it. */
export function stateDirOf(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return env['ORCHESTRATOR_STATE_DIR'] || join(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'claude-orchestrator')
}

export function modelsMapOf(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return env['ORCHESTRATOR_MODELS_MAP'] || join(stateDirOf(env, home), 'models.json')
}

/** A map value as text, as the map's first reader wrote it: a falsy value is no binding. */
const asText = (value: unknown): string => {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return 'True'
  return JSON.stringify(value)
}

/*
 * A versioned identifier goes stale without a sign: trailing numeric dash segments, a version or a
 * date; the family alias is the segment before them, a bracketed variant suffix carried over.
 */
export function versionedWarning(tier: string, value: string): string | null {
  const match = /^(.*?)(\[[^\]]*\])?$/su.exec(value)
  const base = match?.[1] ?? value
  const suffix = match?.[2] ?? ''
  const parts = base.split('-')
  let n = parts.length
  while (n > 0 && /^\d+(\.\d+)*$/.test(parts[n - 1] ?? '')) n--
  if (n > 0 && n < parts.length) {
    return `WARNING: tier ${tier} is bound to the versioned identifier ${value}, which goes stale when a newer model ships; bind it to the family alias ${parts[n - 1] ?? ''}${suffix} instead`
  }
  return null
}

export function resolveTierPair(tier: string, map: string, deps: TierDeps): TierPair {
  if (!(TIERS as readonly string[]).includes(tier)) refused(`resolve-tier: unknown tier: ${tier} (expected deep, standard or light)`)
  let value: unknown = deps.env[`ORCHESTRATOR_TIER_${tier.toUpperCase()}`]
  if (!value) {
    const text = deps.read(map)
    if (text === null) return { model: '', effort: '' }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      refused(`resolve-tier: ${map} does not read as a tier map (invalid JSON, empty, or not an object)`)
    }
    value = (data as Record<string, unknown>)[tier] || ''
  }
  let model: string
  let effort: string
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const binding = value as Record<string, unknown>
    model = asText(binding['model'])
    effort = asText(binding['effort'])
    if (!model) refused(`resolve-tier: tier ${tier} is bound to an object without a model`)
  } else {
    const text = asText(value)
    const slash = text.indexOf('/')
    model = slash < 0 ? text : text.slice(0, slash)
    effort = slash < 0 ? '' : text.slice(slash + 1)
  }
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) refused(`resolve-tier: tier ${tier} has an unknown effort: ${effort} (expected ${EFFORT_LIST})`)
  const warning = versionedWarning(tier, model)
  if (warning !== null) deps.warn(warning)
  return { model, effort }
}

/** The binding as one word: `model`, `model/effort`, or empty when unbound. */
export function resolveTier(tier: string, map: string, deps: TierDeps): string {
  const { model, effort } = resolveTierPair(tier, map, deps)
  return model + (effort && model ? `/${effort}` : '')
}

function refused(message: string): never {
  throw new Refused(message)
}
