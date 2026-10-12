// hooks/module-log.ts
// The module's log line, pure: the argv every domain hands its own $.process.run
// (the engine fences $ to the file that received it, so each domain runs the line
// itself). The writing is hooks/log-append.sh's: an append, never a read-then-write
// of the whole file — every session on the machine shares the one log, and handlers
// run at once — rotated to one `.1` generation past the cap instead of being wiped
// when the host's 4 MiB read limit refused the read.

// Past this size the log is moved to its `.1` file: the two together stay under what
// one read of the host's file API can take.
export const LOG_CAP = 2 * 1024 * 1024

// A line never holds its handler past this: the append is one short write.
export const LOG_TIMEOUT_MS = 5000

export function logPath(config: string): string {
  return `${config}/claude-orchestrator/hooks-module.log`
}

// The stamp names the half that wrote the line, the shape every line has had.
export function logArgv(root: string, config: string, half: string, message: string, at = new Date()): string[] {
  return ['sh', `${root}/hooks/log-append.sh`, logPath(config), `${at.toISOString()} | ${half} | ${message}`, String(LOG_CAP)]
}
