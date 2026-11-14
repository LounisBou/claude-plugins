// The contracts other languages read, by the file name `npm run core` writes each under in a
// plugin's copy. A contract's data lives in its TypeScript module; this list only names it.
import { AUDIT_CONTRACT, LEARNING_CONTRACT } from './learning.ts'
import { NAMES_CONTRACT } from './names.ts'
import { PR_RECORD_CONTRACT } from './pr-record.ts'
import { READINESS_CONTRACT } from './readiness.ts'
import { STORE_CONTRACT } from './store-io.ts'

export const DATA_FILES: Readonly<Record<string, object>> = {
  'learning-audit.json': AUDIT_CONTRACT,
  'learning.json': LEARNING_CONTRACT,
  'names.json': NAMES_CONTRACT,
  'pr-record.json': PR_RECORD_CONTRACT,
  'readiness.json': READINESS_CONTRACT,
  'store.json': STORE_CONTRACT,
}
