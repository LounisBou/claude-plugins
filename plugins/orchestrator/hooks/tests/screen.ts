// hooks/tests/screen.ts
// A pane's tree laid out as the rows a terminal shows, for the tests and the screens: a column
// stacks its children with its gap between them, a row sets them side by side (a child of fixed
// width keeps it, the others share the rest), a border and a padding take their cells, a margin
// its blank rows, and a text wraps at its spaces as the module counts it (wrapWords). A picker
// is its collapsed line, a field its label and placeholder, a button its label; a box drawn
// at an absolute place (the track, the pinned key line) is left out. Colours are not drawn.
import { wrapWords } from '../supervision.ts'

type Element = { type: string; props: Readonly<Record<string, unknown>> }
type Node = string | Element | null | undefined | false

// A prop as a number, a text or a list, as the layout reads it.
const num = (props: Element['props'], ...names: string[]): number | undefined => {
  for (const name of names) if (typeof props[name] === 'number') return props[name]
  return undefined
}
const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value))
type Option = { value: string; label: string }
const optionsOf = (props: Element['props']): Option[] => (Array.isArray(props['options']) ? props['options'] as Option[] : [])

const kidsOf = (node: Node): Node[] => (node && typeof node === 'object' ? ([node.props['children']].flat() as Node[]).filter(kid => kid !== undefined && kid !== null && kid !== false) : [])

// The words a text draws, its nested texts and links included.
export function textOf(node: Node): string {
  if (typeof node === 'string') return node
  if (!node) return ''
  return kidsOf(node).map(textOf).join('')
}

const wrapped = (text: string, width: number) => text.split('\n').flatMap(line => wrapWords(line, Math.max(1, width)))

function margins(node: Node, rows: string[]): string[] {
  if (!node || typeof node !== 'object') return rows
  return [...Array(num(node.props, 'marginTop') ?? 0).fill(''), ...rows, ...Array(num(node.props, 'marginBottom') ?? 0).fill('')]
}

export function drawScreen(node: Node, width: number, over: { focused?: boolean } = {}): string[] {
  if (typeof node === 'string') return wrapped(node, width)
  if (!node) return []
  const props = node.props
  switch (node.type) {
    case 'Text':
    case 'Link':
      return props['wrap'] === 'truncate-end' ? textOf(node).split('\n').map(line => line.slice(0, width)) : wrapped(textOf(node), width)
    case 'Button':
      return wrapped(str(props['label']), width)
    case 'Input':
      return [`${str(props['label'])}: ${str(props['placeholder'])}`.slice(0, width)]
    case 'Select': {
      const options = optionsOf(props)
      const value = options.find(option => option.value === props['value'])
      return [`${str(props['label'])}: ${value?.label ?? ''}`.slice(0, width), ...(over.focused ? options.map(option => option.label.slice(0, width)) : [])]
    }
    case 'Box':
      return box(node, width, over)
    default:
      throw new Error(`no layout for ${node.type}`)
  }
}

function box(node: Element, width: number, over: { focused?: boolean }): string[] {
  const props = node.props
  if (props['position'] === 'absolute') return []
  const outer = num(props, 'width') ?? width
  const border = props['borderStyle'] ? 1 : 0
  const left = num(props, 'paddingLeft', 'paddingX', 'padding') ?? 0
  const right = num(props, 'paddingRight', 'paddingX', 'padding') ?? 0
  const top = num(props, 'paddingTop', 'paddingY', 'padding') ?? 0
  const bottom = num(props, 'paddingBottom', 'paddingY', 'padding') ?? 0
  const inner = outer - 2 * border - left - right
  const kids = kidsOf(node).filter(kid => !(kid && typeof kid === 'object' && kid.props['position'] === 'absolute'))
  let rows: string[]
  const gap = num(props, 'gap') ?? 0
  if ((props['flexDirection'] ?? 'row') === 'column' || kids.length < 2) {
    rows = kids.flatMap((kid, i) => [...(i > 0 ? Array(gap).fill('') : []), ...margins(kid, drawScreen(kid, inner, over))])
  } else {
    const fixed = kids.map(kid => (kid && typeof kid === 'object' ? num(kid.props, 'width') : undefined))
    const free = kids.length - fixed.filter(w => w !== undefined).length
    const rest = inner - fixed.reduce((sum: number, w) => sum + (w ?? 0), 0) - gap * (kids.length - 1)
    const widths = fixed.map(w => w ?? Math.floor(rest / Math.max(1, free)))
    const columns = kids.map((kid, i) => drawScreen(kid, widths[i] ?? 0, over))
    const height = Math.max(...columns.map(column => column.length))
    rows = Array.from({ length: height }, (_, r) => columns.map((column, i) => (column[r] ?? '').padEnd(widths[i] ?? 0)).join(' '.repeat(gap)).trimEnd())
  }
  rows = [...Array(top).fill(''), ...rows, ...Array(bottom).fill('')].map(row => `${' '.repeat(left)}${row}`)
  if (!border) return rows
  const span = outer - 2
  return [`╭${'─'.repeat(span)}╮`, ...rows.map(row => `│${row.padEnd(span)}│`), `╰${'─'.repeat(span)}╯`]
}
