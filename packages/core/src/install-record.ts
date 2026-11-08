// The host's record of installed plugins, read from its text. Pure, with no import: a hooks
// module reads the file through its host and asks this where a plugin lives.

/**
 * The install paths the host's record gives `plugin`, from one of `marketplaces` in that order,
 * read from the record's text: pure, for a caller that reads files through its host.
 */
export function recordedInstallPaths(text: string, plugin: string, marketplaces: readonly string[]): { paths: string[] } | { problem: string } {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return { problem: 'the install record is not JSON' }
  }
  const plugins = isRecord(record) ? record['plugins'] : undefined
  if (!isRecord(plugins)) return { problem: 'the install record has no plugins' }
  const paths: string[] = []
  for (const marketplace of marketplaces) {
    const entries = plugins[`${plugin}@${marketplace}`]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const path = isRecord(entry) ? entry['installPath'] : undefined
      if (typeof path === 'string' && path !== '') paths.push(path)
    }
  }
  return { paths }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
