// The contracts other languages read, by the file name `npm run core` writes each under in a
// plugin's copy. A contract's data lives in its TypeScript module; this list only names it.
import { CLOSE_GATE_CONTRACT } from './close-gate.ts'
import { DECK_READER_CONTRACT } from './deck-reader.ts'
import { FORGE_CONTRACT } from './forge-status.ts'
import { AUDIT_CONTRACT, LEARNING_CONTRACT } from './learning.ts'
import { LAUNCHER_CONTRACT } from './launcher.ts'
import { NAMES_CONTRACT } from './names.ts'
import { ORCHESTRATION_CONTRACT, ROOTS_CONTRACT } from './orchestration.ts'
import { PR_RECORD_CONTRACT } from './pr-record.ts'
import { QUOTA_CONTRACT } from './quota.ts'
import { READINESS_CONTRACT } from './readiness.ts'
import { ROUND_READER_CONTRACT } from './round-question.ts'
import { STORE_CONTRACT } from './store-io.ts'

export const DATA_FILES: Readonly<Record<string, object>> = {
  'close-gate.json': CLOSE_GATE_CONTRACT,
  'deck-reader.json': DECK_READER_CONTRACT,
  'forge-status.json': FORGE_CONTRACT,
  'learning-audit.json': AUDIT_CONTRACT,
  'launcher.json': LAUNCHER_CONTRACT,
  'learning.json': LEARNING_CONTRACT,
  'names.json': NAMES_CONTRACT,
  'orchestration.json': ORCHESTRATION_CONTRACT,
  'pr-record.json': PR_RECORD_CONTRACT,
  'quota.json': QUOTA_CONTRACT,
  'readiness.json': READINESS_CONTRACT,
  'roots.json': ROOTS_CONTRACT,
  'round-reader.json': ROUND_READER_CONTRACT,
  'store.json': STORE_CONTRACT,
}
