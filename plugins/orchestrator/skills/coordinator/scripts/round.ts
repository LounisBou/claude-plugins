// The round's archive: round-archive moves the entries of <state>/round/ settled over a day ago into
// round/archive/ (archiveSettled, in the orchestrator's scripts/lib/round-archive.ts, which
// succession.sh live runs too). The entries are the hooks
// module's (hooks/round.ts, hooks/question.ts), each moved under the lock the module writes it under.
// A question is closed by the module's `settle` tool, no longer by a command here.
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ArchiveError, archiveSettled, DAY_MS } from '../../orchestrator/scripts/lib/round-archive.ts'
import { die, stateOf, type Context } from './context.ts'

export { parseEntry } from '../../orchestrator/scripts/lib/round-archive.ts'

export function roundArchive(ctx: Context, args: readonly string[]): number {
  if (args.length > 0) die(`round-archive: unexpected argument ${args[0]}`)
  const round = join(stateOf(ctx.env), 'round')
  let moved: number
  try {
    moved = archiveSettled(round, ctx.now())
  } catch (error) {
    if (error instanceof ArchiveError) die(error.message)
    throw error
  }
  let names: string[]
  try {
    names = readdirSync(round).sort()
  } catch {
    names = []
  }
  // A write that died between its temporary file and the rename leaves the temporary behind;
  // one a day old is no write in flight.
  const now = ctx.now().getTime()
  for (const name of names) {
    if (!/\.json\.tmp-/.test(name)) continue
    const path = join(round, name)
    try {
      const stat = statSync(path)
      if (stat.isFile() && now - stat.mtimeMs > DAY_MS) rmSync(path, { force: true })
    } catch {
      // Gone meanwhile, or unreadable: nothing to remove.
    }
  }
  ctx.out(`archived ${moved}`)
  return 0
}
