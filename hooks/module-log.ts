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

// The root of the module's own files — its store, its measure files, this log: the config dir's
// claude-orchestrator, or the directory ORCHESTRATOR_MODULE_DIR names. The override is for a
// harness that drives a host on the machine's own config dir, where the login is: its rows,
// measures and lines stay in its sandbox, never among the operator's. Each domain reads the
// variable itself, by its literal name ($ never crosses an import), and hands it here.
export function moduleDirOf(config: string, override?: string | null): string {
  return override ? override : `${config}/claude-orchestrator`
}

export function logPath(config: string, override?: string | null): string {
  return `${moduleDirOf(config, override)}/hooks-module.log`
}

// The stamp names the half that wrote the line, the shape every line has had.
export function logArgv(root: string, config: string, half: string, message: string, at = new Date(), override?: string | null): string[] {
  return ['sh', `${root}/hooks/log-append.sh`, logPath(config, override), `${at.toISOString()} | ${half} | ${message}`, String(LOG_CAP)]
}
