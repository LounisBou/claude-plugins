// shell-profile — the shell file's copy and the one line that sources it from the profile.
//
// The plugin keeps one file of shell configuration (`shell/profile.sh` in its tree). The
// installer copies it into the state directory, where a deploy does not move it, and adds ONE line to
// the profile of the user's shell that sources the copy; the session start's sync rewrites the copy
// after an update, so the profile never changes again. Only the installer writes the profile, and
// only that line: every other line of it is the user's.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setting, type Env } from '../../../core/paths.ts'
import { writeAtomic } from '../../../core/store.ts'

/** The plugin's file under `shell/`, and the name of its copy in the state directory. */
export const SOURCE_NAME = 'profile.sh'
export const COPY_NAME = 'orchestrator-profile.sh'
/** What ends the line this plugin writes: the only thing that makes a line of a profile its own. */
export const MARKER = '# orchestrator shell file'

/** The plugin's shell file, under its root. */
export const sourceOf = (root: string): string => join(root, 'shell', SOURCE_NAME)

/** The copy the profile sources, under the state directory. */
export const copyOf = (state: string): string => join(state, COPY_NAME)

/** The user's profile for the shell `$SHELL` names (ZDOTDIR honoured), or undefined for any other. */
export function profileOf(env: Env, home: string): { readonly path: string; readonly shell: 'zsh' | 'bash' } | undefined {
  const shell = basename(setting(env, 'SHELL') ?? '')
  if (shell === 'zsh') return { path: join(setting(env, 'ZDOTDIR') ?? home, '.zshrc'), shell }
  if (shell === 'bash') return { path: join(home, '.bashrc'), shell }
  return undefined
}

/** The line, without its marker: guarded, so a missing file never breaks a shell. */
export function guarded(file: string, home: string): string {
  const rel = file.startsWith(`${home}/`) ? file.slice(home.length + 1) : undefined
  const spelled = rel !== undefined && /^[A-Za-z0-9._/-]+$/.test(rel) ? `"$HOME/${rel}"` : `'${file.split("'").join("'\\''")}'`
  return `[ -r ${spelled} ] && . ${spelled}`
}

/** The line the installer writes, marked as its own. */
export const lineOf = (file: string, home: string): string => `${guarded(file, home)} ${MARKER}`

const isMarked = (line: string): boolean => line.endsWith(` ${MARKER}`)

/** The text with exactly our line, or undefined when it already is so: a marked line of another file is replaced. */
export function withLine(text: string, line: string): string | undefined {
  const lines = text.split('\n')
  const marked = lines.filter(isMarked)
  if (marked.length === 1 && marked[0] === line) return undefined
  if (marked.length === 0) return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`
  let placed = false
  return lines.flatMap(l => {
    if (!isMarked(l)) return [l]
    if (placed) return []
    placed = true
    return [line]
  }).join('\n')
}

/** The text without the line, or undefined when it does not carry it. */
export function withoutLine(text: string, line: string): string | undefined {
  const lines = text.split('\n')
  return lines.includes(line) ? lines.filter(l => l !== line).join('\n') : undefined
}

/** The numbers of the lines where the earlier hand-written block begins: `unset CLAUDECODE …`. */
export function earlierBlock(text: string): number[] {
  return text.split('\n').flatMap((l, i) => (/^\s*unset\s+CLAUDECODE\b/.test(l) ? [i + 1] : []))
}

/** Writes the profile through a link it may be, keeping its mode; `before` is saved first by the caller. */
export function writeProfile(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path
  writeAtomic(target, text, existsSync(target) ? statSync(target).mode & 0o777 : 0o644)
}

/** Whether the copy differs from the plugin's file, and so a sync or an install rewrites it. */
export function copyDiffers(root: string, state: string): boolean {
  const copy = copyOf(state)
  return !existsSync(copy) || readFileSync(copy, 'utf8') !== readFileSync(sourceOf(root), 'utf8')
}

/** Rewrites the copy from the plugin's file; the caller has checked there is a plugin file to read. */
export function writeCopy(root: string, state: string): void {
  writeAtomic(copyOf(state), readFileSync(sourceOf(root), 'utf8'), 0o644)
}

/** The session start's pass: the copy, when one is there and differs; never one the user removed. Whether it rewrote. */
export function syncCopy(root: string, state: string, dry: boolean): boolean {
  if (!existsSync(copyOf(state)) || !existsSync(sourceOf(root)) || !copyDiffers(root, state)) return false
  if (!dry) writeCopy(root, state)
  return true
}
