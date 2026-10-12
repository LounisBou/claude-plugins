// hooks/validate.ts
// N5: the lexical checks of the norms:validate skill (2: empty entries, 3: the
// listed vague words, 5: no code block at all, 6: mixed list markers and no
// top-level header) run here on CONTRIBUTING.md, with exact line numbers, and
// land as a table appended to the skill's prompt. Checks 1 and 4, and the
// prose-paragraph part of 6, still need the model's judgment. A failure, or no
// CONTRIBUTING.md, leaves the skill's text as it was.

export type Finding = { check: 2 | 3 | 5 | 6; severity: 'ERROR' | 'WARNING'; line: number | null; section: string; detail: string }

// skills/validate/SKILL.md, Check 3.
export const VAGUE = [
  'properly', 'clearly', 'cleanly', 'well', 'good', 'appropriate',
  'when needed', 'as necessary', 'where possible',
  'or whatever', 'etc.', 'and so on',
]

function vagueRe(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w])${escaped}(?=$|[^\\w])`, 'i')
}

export function lintContributing(text: string): Finding[] {
  const lines = text.split('\n')
  const findings: Finding[] = []
  let section = '(top)'
  let inFence = false
  let fences = 0
  let hasH1 = false
  const markers: Record<string, number[]> = { '-': [], '*': [] }
  const headings: { level: number; index: number; title: string }[] = []

  lines.forEach((line, i) => {
    const n = i + 1
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) fences++
      inFence = !inFence
      return
    }
    if (inFence) return
    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/)
    if (h) {
      if (h[1].length === 1) hasH1 = true
      if (h[1].length <= 2) section = h[2]
      headings.push({ level: h[1].length, index: i, title: h[2] })
      return
    }
    const bullet = line.match(/^\s*([-*+])(\s+(.*))?$/)
    if (bullet) {
      if (bullet[1] === '-' || bullet[1] === '*') markers[bullet[1]].push(n)
      if (!(bullet[3] ?? '').trim()) {
        findings.push({ check: 2, severity: 'ERROR', line: n, section, detail: 'Empty bullet: add the intended rule text or remove the entry.' })
        return
      }
    }
    for (const word of VAGUE) {
      if (vagueRe(word).test(line)) {
        findings.push({ check: 3, severity: 'WARNING', line: n, section, detail: `Contains "${word}": "${line.trim()}"` })
      }
    }
  })

  // A `##` or `###` heading whose body, up to the next heading of its level
  // or higher, holds nothing but blank lines and headings.
  for (let k = 0; k < headings.length; k++) {
    const { level, index, title } = headings[k]
    if (level < 2 || level > 3) continue
    let end = lines.length
    for (let j = k + 1; j < headings.length; j++) {
      if (headings[j].level <= level) {
        end = headings[j].index
        break
      }
    }
    const body = lines.slice(index + 1, end).filter(l => l.trim() && !/^#{1,6}\s/.test(l) && !/^\s*[-*+]\s*$/.test(l))
    if (body.length === 0) {
      findings.push({ check: 2, severity: 'ERROR', line: index + 1, section: title, detail: 'Section header with no rules under it.' })
    }
  }

  if (fences === 0) {
    findings.push({ check: 5, severity: 'WARNING', line: null, section: '(file)', detail: 'No code block anywhere: add at least one good/bad example per section.' })
  }
  if (markers['-'].length && markers['*'].length) {
    const [minority, other] = markers['-'].length < markers['*'].length ? ['-', '*'] : ['*', '-']
    findings.push({
      check: 6, severity: 'WARNING', line: markers[minority][0], section: '(file)',
      detail: `Mixed list markers: "${minority}" on lines ${markers[minority].join(', ')}; the rest use "${other}".`,
    })
  }
  if (!hasH1) {
    findings.push({ check: 6, severity: 'WARNING', line: null, section: '(file)', detail: 'No top-level `#` header.' })
  }
  return findings.sort((a, b) => a.check - b.check || (a.line ?? 0) - (b.line ?? 0))
}

const cell = (s: string) => s.replace(/\|/g, '\\|')

export function scanBlock(findings: Finding[], lineCount: number): string {
  const out = [
    '<norms-validate-scan>',
    `The norms plugin scanned CONTRIBUTING.md (${lineCount} lines) for checks 2, 3, 5 and 6. Report these findings with these line numbers as given; drop a check 3 hit only where the word is not a qualifier (for example "as well as"). Judge checks 1 and 4, and rules buried in prose (check 6), yourself.`,
  ]
  if (!findings.length) {
    out.push('No lexical finding: checks 2, 3 and 5 pass, and check 6 has no marker or header issue.')
  } else {
    out.push('', '| Check | Severity | Line | Section | Detail |', '|---|---|---|---|---|')
    for (const f of findings) out.push(`| ${f.check} | ${f.severity} | ${f.line ?? '-'} | ${cell(f.section)} | ${cell(f.detail)} |`)
  }
  out.push('</norms-validate-scan>')
  return out.join('\n')
}

export function register(on: any): void {
  on('skill.prompt', { skill: 'norms:validate' }, async ($: any, e: any, next: any) => {
    if (!(await $.fs.exists('CONTRIBUTING.md'))) return next(e)
    const text = String(await $.fs.read('CONTRIBUTING.md'))
    const block = scanBlock(lintContributing(text), text.split('\n').length)
    const r = await next(e)
    return { ...r, text: `${r.text}\n\n${block}` }
  }).catch(($: any, e: any, next: any) => next(e))
}
