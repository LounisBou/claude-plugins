// Where an orchestration's dispatch record and the files beside it live, and how its brief names
// it: read by dispatch-record (the owner and the goals), succession (the brief's line) and the
// hooks module's move (the files that travel with the brief). Pure: no file is read here.

/** The record's « Dispatch record » line in a brief: its path between backticks, or ''. */
export function recordNamedIn(brief: string): string {
  return /^- Dispatch record[^`\n]*`([^`{}]+)`/m.exec(brief)?.[1] ?? ''
}

/** The file that names the record's owner, beside it. */
export function ownerFileOf(record: string): string {
  return `${record}.owner`
}

/** The spec's goals of the build, beside the record. */
export function goalsFileOf(record: string): string {
  const slash = record.lastIndexOf('/')
  return `${slash < 0 ? '.' : record.slice(0, slash)}/goals.md`
}

/** Every file of a record: the record itself, its owner and its goals. */
export function recordFiles(record: string): [string, string, string] {
  return [record, ownerFileOf(record), goalsFileOf(record)]
}
