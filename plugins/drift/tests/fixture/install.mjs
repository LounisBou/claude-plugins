// The fixture project's install: writes the marker its build requires, holding FIXTURE_RELEASE as
// the install saw it. A file named FAIL_INSTALL makes the install fail.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

if (existsSync('FAIL_INSTALL')) {
  console.error('install failed on purpose')
  process.exit(1)
}
mkdirSync('node_modules', { recursive: true })
writeFileSync('node_modules/.installed', process.env.FIXTURE_RELEASE ?? '')
