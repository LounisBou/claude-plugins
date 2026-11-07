// hooks/tests/screen.ts
// A pane's tree laid out as the rows a terminal shows, for the tests and the screens: a column
// stacks its children with its gap between them, a row sets them side by side (a child of fixed
// width keeps it, the others share the rest), a border and a padding take their cells, a margin
// its blank rows, and a text wraps at its spaces as the module counts it (wrapWords). A picker
// is its collapsed line, a field its label and placeholder, a button its label; a box drawn
// at an absolute place (the track, the pinned key line) is left out. Colours are not drawn.
import { wrapWords } from '../supervision.ts'

type Node = string | { type: string; props: Record<string, any> } | null | undefined | false

const kidsOf = (node: Node): Node[] => (node && typeof node === 'object' ? [node.props.children].flat().filter(kid => kid !== undefined && kid !== null && kid !== false) : [])

// The words a text draws, its nested texts and links included.
export function textOf(node: Node): string {
  if (typeof node === 'string') return node
  if (!node) return ''
  return kidsOf(node).map(textOf).join('')
}

const wrapped = (text: string, width: number) => text.split('\n').flatMap(line => wrapWords(line, Math.max(1, width)))

function margins(node: Node, rows: string[]): string[] {
  if (!node || typeof node !== 'object') return rows
  return [...Array(node.props.marginTop ?? 0).fill(''), ...rows, ...Array(node.props.marginBottom ?? 0).fill('')]
}

export function drawScreen(node: Node, width: number, over: { focused?: boolean } = {}): string[] {
  if (typeof node === 'string') return wrapped(node, width)
  if (!node) return []
  const props = node.props
  switch (node.type) {
    case 'Text':
    case 'Link':
      return props.wrap === 'truncate-end' ? textOf(node).split('\n').map(line => line.slice(0, width)) : wrapped(textOf(node), width)
    case 'Button':
      return wrapped(String(props.label ?? ''), width)
    case 'Input':
      return [`${props.label ?? ''}: ${props.placeholder ?? ''}`.slice(0, width)]
    case 'Select': {
      const value = props.options.find((option: { value: string }) => option.value === props.value)
      return [`${props.label}: ${value?.label ?? ''}`.slice(0, width), ...(over.focused ? props.options.map((option: { label: string }) => option.label.slice(0, width)) : [])]
    }
    case 'Box':
      return box(node as { type: string; props: Record<string, any> }, width, over)
    default:
      throw new Error(`no layout for ${node.type}`)
  }
}

function box(node: { type: string; props: Record<string, any> }, width: number, over: { focused?: boolean }): string[] {
  const props = node.props
  if (props.position === 'absolute') return []
  const outer = props.width ?? width
  const border = props.borderStyle ? 1 : 0
  const left = props.paddingLeft ?? props.paddingX ?? props.padding ?? 0
  const right = props.paddingRight ?? props.paddingX ?? props.padding ?? 0
  const top = props.paddingTop ?? props.paddingY ?? props.padding ?? 0
  const bottom = props.paddingBottom ?? props.paddingY ?? props.padding ?? 0
  const inner = outer - 2 * border - left - right
  const kids = kidsOf(node).filter(kid => !(kid && typeof kid === 'object' && kid.props.position === 'absolute'))
  let rows: string[]
  if ((props.flexDirection ?? 'row') === 'column' || kids.length < 2) {
    rows = kids.flatMap((kid, i) => [...(i > 0 ? Array(props.gap ?? 0).fill('') : []), ...margins(kid, drawScreen(kid, inner, over))])
  } else {
    const fixed = kids.map(kid => (kid && typeof kid === 'object' ? kid.props.width : undefined) as number | undefined)
    const free = kids.length - fixed.filter(w => w !== undefined).length
    const rest = inner - fixed.reduce((sum: number, w) => sum + (w ?? 0), 0) - (props.gap ?? 0) * (kids.length - 1)
    const widths = fixed.map(w => w ?? Math.floor(rest / Math.max(1, free)))
    const columns = kids.map((kid, i) => drawScreen(kid, widths[i], over))
    const height = Math.max(...columns.map(column => column.length))
    rows = Array.from({ length: height }, (_, r) => columns.map((column, i) => (column[r] ?? '').padEnd(widths[i])).join(' '.repeat(props.gap ?? 0)).trimEnd())
  }
  rows = [...Array(top).fill(''), ...rows, ...Array(bottom).fill('')].map(row => `${' '.repeat(left)}${row}`)
  if (!border) return rows
  const span = outer - 2
  return [`╭${'─'.repeat(span)}╮`, ...rows.map(row => `│${row.padEnd(span)}│`), `╰${'─'.repeat(span)}╯`]
}
