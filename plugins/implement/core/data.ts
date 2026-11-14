// Generated from packages/core/src by `npm run core`: edit the source, never this copy.
// The contracts other languages read, by the file name `npm run core` writes each under in a
// plugin's copy. A contract's data lives in its TypeScript module; this list only names it.
import { AUDIT_CONTRACT, LEARNING_CONTRACT } from './learning.ts'
import { NAMES_CONTRACT } from './names.ts'
import { ORCHESTRATION_CONTRACT } from './orchestration.ts'
import { PR_RECORD_CONTRACT } from './pr-record.ts'
import { STORE_CONTRACT } from './store-io.ts'

export const DATA_FILES: Readonly<Record<string, object>> = {
  'learning-audit.json': AUDIT_CONTRACT,
  'learning.json': LEARNING_CONTRACT,
  'names.json': NAMES_CONTRACT,
  'orchestration.json': ORCHESTRATION_CONTRACT,
  'pr-record.json': PR_RECORD_CONTRACT,
  'store.json': STORE_CONTRACT,
}
