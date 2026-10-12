// hooks/scope.ts
// The pure half of /norms:check's scope: what commands/check.md Steps 1 to 3
// ask the model to work out by hand (project type, file classes, applicable
// agents, the shortcut words, the reference paths), and the blocks the module
// appends for the command and for each norms agent. No $ here: check.ts runs
// the git and file reads and hands the facts in.

export const AGENTS = [
  'norms-pattern-conformity',
  'norms-variable-naming',
  'norms-test-structure',
  'norms-diff-scope',
  'norms-import-organization',
  'norms-magic-values',
  'norms-documentation',
  'norms-test-coverage',
] as const

// commands/check.md, "Available agent shortcuts".
export const SHORTCUTS: Record<string, string> = {
  pattern: 'norms-pattern-conformity',
  conformity: 'norms-pattern-conformity',
  naming: 'norms-variable-naming',
  variables: 'norms-variable-naming',
  tests: 'norms-test-structure',
  'test-structure': 'norms-test-structure',
  scope: 'norms-diff-scope',
  diff: 'norms-diff-scope',
  imports: 'norms-import-organization',
  magic: 'norms-magic-values',
  docs: 'norms-documentation',
  documentation: 'norms-documentation',
  coverage: 'norms-test-coverage',
}

export type Category = 'source' | 'test' | 'config' | 'other'

const CONFIG_EXT = /\.(json|ya?ml|toml|xml)$/i
// Tooling dotfiles: configuration, not application code.
const DOTFILE_CONFIG = /^\.(git(ignore|attributes|modules)|editorconfig|npmrc|nvmrc|dockerignore|prettierrc|eslintrc)/i
// Files that are neither application code nor configuration: documents,
// images, lock files. check.md's three classes leave them unnamed; counting
// them as source would start five agents on a README edit.
const OTHER_EXT = /\.(md|markdown|rst|txt|adoc|png|jpe?g|gif|svg|ico|webp|pdf|lock)$/i
const OTHER_NAMES = /^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|CODEOWNERS)(\..*)?$/i

// check.md Step 2: test is `*.test.*`, `*.spec.*`, `*_test.*`, `*/tests/*`,
// `*/test/*`; config is `*.json`, `*.yml`, `*.yaml`, `*.toml`, `*.xml`, `*.env*`.
export function classify(path: string): Category {
  const parts = path.split('/')
  const name = parts[parts.length - 1]
  const dirs = parts.slice(0, -1)
  if (/\.(test|spec)\./i.test(name) || /_test\.[^.]+$/i.test(name) || dirs.some(d => d === 'tests' || d === 'test' || d === '__tests__')) {
    return 'test'
  }
  if (CONFIG_EXT.test(name) || /^\.env/i.test(name) || DOTFILE_CONFIG.test(name)) return 'config'
  if (OTHER_EXT.test(name) || OTHER_NAMES.test(name)) return 'other'
  return 'source'
}

export type Classified = Record<Category, string[]>

export function classifyAll(files: readonly string[]): Classified {
  const out: Classified = { source: [], test: [], config: [], other: [] }
  for (const f of files) if (f) out[classify(f)].push(f)
  return out
}

// check.md Step 1, from the names at the project root.
const TYPE_MARKERS: [RegExp, string][] = [
  [/^package\.json$/, 'JavaScript/TypeScript'],
  [/^composer\.json$/, 'PHP'],
  [/^(requirements\.txt|pyproject\.toml)$/, 'Python'],
  [/^Cargo\.toml$/, 'Rust'],
  [/^go\.mod$/, 'Go'],
  [/^Gemfile$/, 'Ruby'],
  [/^(pom\.xml|build\.gradle(\.kts)?)$/, 'Java/Kotlin'],
  [/\.(csproj|sln)$/, 'C#/.NET'],
]

export function projectTypes(rootNames: readonly string[]): string[] {
  const found: string[] = []
  for (const [re, type] of TYPE_MARKERS) {
    if (rootNames.some(n => re.test(n)) && !found.includes(type)) found.push(type)
  }
  return found
}

export type CheckArgs = {
  base?: string
  // 'all': no agent named. 'free-text': agent words inside a sentence, which
  // only the model can read. Otherwise the agents the words name.
  agents: 'all' | 'free-text' | string[]
  paths: string[]
}

const PATH_START = /^(\/|\.\.?\/|~\/)/

// The user's words after /norms:check. A word list made only of shortcuts
// (`naming tests`) is an agent selection; a shortcut inside a sentence
// (`use ../lib as pattern reference`) is not settled here.
export function parseCheckArgs(args: string): CheckArgs {
  let base: string | undefined
  const paths: string[] = []
  const named: string[] = []
  let freeWords = 0
  let all = false
  for (const raw of args.split(/\s+/)) {
    if (!raw) continue
    const m = raw.match(/^base=(\S+)$/)
    if (m) {
      base = m[1]
      continue
    }
    if (PATH_START.test(raw) || (raw.includes('/') && !/^[a-z]+:\/\//i.test(raw))) {
      paths.push(raw.replace(/[,;]$/, ''))
      continue
    }
    const word = raw.toLowerCase().replace(/^[,;"'`]+|[,;.:"'`]+$/g, '')
    if (!word) continue
    if (word === 'all') all = true
    else if (SHORTCUTS[word]) {
      if (!named.includes(SHORTCUTS[word])) named.push(SHORTCUTS[word])
    } else freeWords++
  }
  let agents: CheckArgs['agents'] = 'all'
  if (named.length > 0) agents = freeWords > 0 ? 'free-text' : all ? 'all' : named
  return { base, agents, paths }
}

export type Applicability = { run: string[]; skipped: [string, string][] }

// check.md Step 3's table.
export function applicable(files: Classified, hasTestInfra: boolean): Applicability {
  const hasSource = files.source.length > 0
  const hasTest = files.test.length > 0
  const rules: [string, boolean, string][] = [
    ['norms-pattern-conformity', hasSource, 'No source files'],
    ['norms-variable-naming', hasSource, 'No source files'],
    ['norms-test-structure', hasTest, 'No test files'],
    ['norms-diff-scope', true, ''],
    ['norms-import-organization', hasSource, 'Config-only changes'],
    ['norms-magic-values', hasSource, 'Config-only changes'],
    ['norms-documentation', hasSource, 'Test-only or config-only'],
    ['norms-test-coverage', hasTestInfra, 'No test infrastructure'],
  ]
  const run: string[] = []
  const skipped: [string, string][] = []
  for (const [agent, ok, why] of rules) {
    if (ok) run.push(agent)
    else skipped.push([agent, why])
  }
  return { run, skipped }
}

export type Scope = {
  base: string
  baseArg?: string
  head: string
  branch: string
  files: Classified
  types: string[]
  hasContributing: boolean
  hasTestInfra: boolean
}

export type ReferencePaths = { found: string[]; missing: string[] }

// The block appended to /norms:check's arguments. commands/check.md reads it
// in place of Steps 1 to 3.
export function scopeBlock(scope: Scope, args: CheckArgs, refs: ReferencePaths): string {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none')
  const { run, skipped } = applicable(scope.files, scope.hasTestInfra)
  const lines = [
    '<norms-scope>',
    'Precomputed by the norms plugin: Steps 1 to 3 are done. Use these values as given.',
    `base: ${scope.base}${scope.baseArg ? ` (from base=${scope.baseArg})` : ''}`,
    `head: ${scope.head}`,
    `branch: ${scope.branch}`,
    `project type: ${scope.types.length ? scope.types.join(', ') : 'unknown (no indicator file at the root)'}`,
    `project norms: ${scope.hasContributing ? 'CONTRIBUTING.md found (agents will apply project-specific rules)' : 'no CONTRIBUTING.md (agents will discover conventions from codebase)'}`,
    `changed files: ${Object.values(scope.files).reduce((n, xs) => n + xs.length, 0)}`,
    `  source: ${list(scope.files.source)}`,
    `  test: ${list(scope.files.test)}`,
    `  config: ${list(scope.files.config)}`,
    `  other (docs, images, locks): ${list(scope.files.other)}`,
    `applicable agents: ${list(run)}`,
    `skipped by file type: ${skipped.length ? skipped.map(([a, why]) => `${a}: ${why}`).join('; ') : 'none'}`,
  ]
  if (args.agents === 'free-text') {
    lines.push('requested agents: named inside free text; read the words above and pick from the shortcut table')
  } else if (args.agents !== 'all') {
    lines.push(`requested agents: ${args.agents.join(', ')} (run only these)`)
  } else {
    lines.push('requested agents: all applicable')
  }
  lines.push(`external references (validated): ${list(refs.found)}`)
  if (refs.missing.length) lines.push(`external references not found (tell the user): ${refs.missing.join(', ')}`)
  lines.push('diff: the plugin appends it to each norms agent prompt at spawn; do not paste it')
  lines.push('</norms-scope>')
  return lines.join('\n')
}

// Which changed files each agent reviews, by class.
export const AGENT_CATEGORIES: Record<string, Category[]> = {
  'norms-pattern-conformity': ['source'],
  'norms-variable-naming': ['source'],
  'norms-import-organization': ['source'],
  'norms-magic-values': ['source'],
  'norms-documentation': ['source'],
  'norms-test-structure': ['test'],
  'norms-test-coverage': ['source', 'test'],
  'norms-diff-scope': ['source', 'test', 'config', 'other'],
}

export function filesFor(agent: string, files: Classified): string[] {
  return (AGENT_CATEGORIES[agent] ?? ['source', 'test', 'config', 'other']).flatMap(c => files[c])
}

// The CONTRIBUTING.md sections each agent's own instructions name. The
// conformity agent reads every section but the three other agents own; the
// diff-scope agent judges scope against the whole file.
const OWNED = ['test-conventions', 'naming', 'code-hygiene']
const SECTION_RULE: Record<string, (heading: string) => boolean> = {
  'norms-variable-naming': h => h === '[naming]',
  'norms-magic-values': h => h === '[code-hygiene]',
  'norms-documentation': h => h === '[code-hygiene]',
  'norms-import-organization': h => h === '[code-hygiene]' || /import/i.test(h),
  'norms-test-structure': h => h === '[test-conventions]',
  'norms-test-coverage': h => h === '[test-conventions]',
  'norms-pattern-conformity': h => !OWNED.some(o => h === `[${o}]`),
}

export type Excerpt = { text: string; headings: string[] }

// The `## ` sections of CONTRIBUTING.md that apply to the agent, whole.
export function contributingExcerpt(agent: string, contributing: string): Excerpt {
  const rule = SECTION_RULE[agent]
  if (!rule) return { text: contributing.trim(), headings: ['whole file'] }
  const out: string[] = []
  const headings: string[] = []
  let keep = false
  let inFence = false
  for (const line of contributing.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = inFence ? null : line.match(/^(#{1,2})\s+(.*?)\s*$/)
    if (h) {
      keep = h[1] === '##' && rule(h[2])
      if (keep) headings.push(h[2])
    }
    if (keep) out.push(line)
  }
  return { text: out.join('\n').trim(), headings }
}

// A fence longer than any backtick run inside the text, so a diff that
// itself holds ``` cannot close the block early.
export function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(longest + 1)
}

export const DIFF_INLINE_MAX = 40_000

export type AgentContext = {
  agent: string
  base: string
  head: string
  files: string[]
  diff?: string
  diffPath?: string
  diffStat?: string
  contributing?: string
}

// The block appended to a norms agent's prompt at spawn.
export function contextBlock(c: AgentContext): string {
  const lines = [
    '<norms-context>',
    'Precomputed by the norms plugin for this agent: use it instead of running git diff or reading CONTRIBUTING.md yourself.',
    `base: ${c.base}`,
    `head: ${c.head}`,
    `files for this agent: ${c.files.length ? c.files.join(', ') : 'none of this agent\'s kind changed'}`,
  ]
  if (c.contributing === undefined) {
    lines.push('CONTRIBUTING.md: absent')
  } else {
    const ex = contributingExcerpt(c.agent, c.contributing)
    if (ex.text) {
      const fence = fenceFor(ex.text)
      lines.push(`CONTRIBUTING.md sections for this agent: ${ex.headings.join(', ')}`, fence + 'markdown', ex.text, fence)
    } else {
      lines.push('CONTRIBUTING.md: present, with no section for this agent')
    }
  }
  if (c.files.length) {
    const range = `git diff ${c.base}...HEAD -- <files above>`
    if (c.diffPath) {
      lines.push(`diff: too large to inline; read it from ${c.diffPath} (${range})`)
      if (c.diffStat) lines.push(c.diffStat.trimEnd())
    } else {
      const diff = c.diff ?? ''
      const fence = fenceFor(diff)
      lines.push(`diff (${range}):`, fence + 'diff', diff.trimEnd(), fence)
    }
  }
  lines.push('</norms-context>')
  return lines.join('\n')
}
