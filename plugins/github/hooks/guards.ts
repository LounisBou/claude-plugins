// The path helper the guards of register.ts read a file path with. A pure function.

// A path with its . and .. parts and repeated slashes resolved, a relative one
// against dir.
export function normalise(path: string, dir = '/'): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : dir + '/' + path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}
