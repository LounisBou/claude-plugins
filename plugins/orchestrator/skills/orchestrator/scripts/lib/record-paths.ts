// Where the files beside an orchestration's dispatch record live: read by dispatch-record and
// succession (the owner and the goals). Pure: no file is read here.

/** The file that names the record's owner, beside it. */
export function ownerFileOf(record: string): string {
  return `${record}.owner`
}

/** The spec's goals of the build, beside the record. */
export function goalsFileOf(record: string): string {
  const slash = record.lastIndexOf('/')
  return `${slash < 0 ? '.' : record.slice(0, slash)}/goals.md`
}
