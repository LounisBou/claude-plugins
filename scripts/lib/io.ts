// What a script writes and reads from its process, passed in so a test can stand in for it.

export interface Io {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
}

export const processIo: Io = {
  out: line => console.log(line),
  err: line => console.error(line),
  env: process.env,
}
