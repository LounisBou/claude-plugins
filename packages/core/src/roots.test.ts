import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DATA_FILES } from './data.ts'
import { DATA_ROOT_DIR_PATTERN, DATA_ROOT_FILE, DATA_ROOT_TEXT_PATTERN, DATA_ROOT_VERSION, dataRootFileOf, dataRootOf, parseDataRoot, ROOTS_CONTRACT } from './orchestration.ts'
import { moduleDirUnder, orchestratorRoots } from './roots.ts'

const file = (dir: string): string => JSON.stringify({ version: DATA_ROOT_VERSION, dir })

describe('the data-root file', () => {
  it('lies under the protected root', () => {
    assert.equal(dataRootFileOf('/p'), `/p/${DATA_ROOT_FILE}`)
    assert.equal(dataRootFileOf('/p/'), `/p/${DATA_ROOT_FILE}`)
  })

  it('names an absolute directory, its trailing slashes dropped', () => {
    assert.equal(parseDataRoot(file('/shared/claude-orchestrator')), '/shared/claude-orchestrator')
    assert.equal(parseDataRoot(file('/shared/x//')), '/shared/x')
    assert.equal(parseDataRoot(file('/shared/with space')), '/shared/with space')
  })

  it('names none when absent, torn, of another version, or not an absolute directory of printable characters', () => {
    for (const text of [
      undefined, null, '', '{', '[]', 'null', '"/x"', JSON.stringify({ dir: '/x' }),
      JSON.stringify({ version: 2, dir: '/x' }), JSON.stringify({ version: '1', dir: '/x' }),
      JSON.stringify({ version: 1, dir: 3 }), file('relative/x'), file(''), file('/'), file('//'),
      file('/x\ny'), file('/x\ty'), file('/x\u007f'),
    ]) assert.equal(parseDataRoot(text), null, String(text))
  })

  it('names none from a text JSON.parse takes but that is no flat object of strict JSON another reader would agree on', () => {
    for (const text of [
      `\ufeff${file('/x')}`, '{"version": 1, "dir": "/x", "n": "\ufffd"}', '{"version": 1, "dir": "/x\\udc00"}',
      '{"version": 1, "dir": "/x", "m": {"a": 1}}', '{"version": 1, "dir": "/x", "m": []}', `\u000c${file('/x')}`,
    ]) assert.equal(parseDataRoot(text), null, JSON.stringify(text))
    assert.equal(parseDataRoot('{ "version" : 1.0 ,\n "dir" : "\\/x\\u00e9", "n": null }\n'), '/xé')
  })

  it('is read by the other languages from roots.json: its name, its version and the patterns its text and its dir match', () => {
    assert.deepEqual(DATA_FILES['roots.json'], { version: 1, file: DATA_ROOT_FILE, file_version: DATA_ROOT_VERSION, text_pattern: DATA_ROOT_TEXT_PATTERN, dir_pattern: DATA_ROOT_DIR_PATTERN })
    assert.equal(DATA_FILES['roots.json'], ROOTS_CONTRACT)
  })

  it('leaves the data on the protected root when it names none', () => {
    assert.equal(dataRootOf('/p', undefined), '/p')
    assert.equal(dataRootOf('/p', file('relative')), '/p')
    assert.equal(dataRootOf('/p', file('/d')), '/d')
  })
})

describe('the roots a script resolves', () => {
  it('are one directory until the operator places the data elsewhere', () => {
    const home = mkdtempSync(join(tmpdir(), 'roots-'))
    const own = join(home, '.claude', 'claude-orchestrator')
    assert.deepEqual(orchestratorRoots({}, home), { protectedRoot: own, dataRoot: own, moduleDir: own })
    const config = join(home, 'cfg')
    assert.deepEqual(orchestratorRoots({ CLAUDE_CONFIG_DIR: config }, home), {
      protectedRoot: join(config, 'claude-orchestrator'), dataRoot: join(config, 'claude-orchestrator'), moduleDir: join(config, 'claude-orchestrator'),
    })
  })

  it('read the data root from the protected root\'s file, never from the data root itself', () => {
    const home = mkdtempSync(join(tmpdir(), 'roots-'))
    const own = join(home, '.claude', 'claude-orchestrator')
    const shared = join(home, 'shared')
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(own, { recursive: true })
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(own, DATA_ROOT_FILE), file(shared))
    // A data-root file planted in the data root moves nothing further.
    writeFileSync(join(shared, DATA_ROOT_FILE), file(elsewhere))
    assert.deepEqual(orchestratorRoots({}, home), { protectedRoot: own, dataRoot: shared, moduleDir: shared })
  })

  it('follow the harness overrides: the protected root\'s file for the data, the module\'s own variable for its files', () => {
    const home = mkdtempSync(join(tmpdir(), 'roots-'))
    const state = join(home, 'state')
    mkdirSync(state)
    writeFileSync(join(state, DATA_ROOT_FILE), file(join(home, 'data')))
    assert.deepEqual(orchestratorRoots({ ORCHESTRATOR_STATE_DIR: state }, home), {
      protectedRoot: state, dataRoot: join(home, 'data'), moduleDir: join(home, '.claude', 'claude-orchestrator'),
    })
    assert.equal(orchestratorRoots({ ORCHESTRATOR_STATE_DIR: state, ORCHESTRATOR_MODULE_DIR: '/m' }, home).moduleDir, '/m')
    assert.deepEqual(orchestratorRoots({ ORCHESTRATOR_STATE_DIR: '', ORCHESTRATOR_MODULE_DIR: '' }, home).protectedRoot, join(home, '.claude', 'claude-orchestrator'))
  })

  it('place the module\'s directory of a given configuration directory the same way', () => {
    const config = mkdtempSync(join(tmpdir(), 'roots-'))
    const own = join(config, 'claude-orchestrator')
    assert.equal(moduleDirUnder(config), own)
    mkdirSync(own)
    writeFileSync(join(own, DATA_ROOT_FILE), file('/shared/o'))
    assert.equal(moduleDirUnder(config), '/shared/o')
    assert.equal(moduleDirUnder(config, '/m'), '/m')
    assert.equal(moduleDirUnder(config, ''), '/shared/o')
  })

  it('keep the data on the protected root when its file cannot be read', () => {
    const roots = orchestratorRoots({ ORCHESTRATOR_STATE_DIR: '/p' }, '/h', () => undefined)
    assert.equal(roots.dataRoot, '/p')
    const unreadable = mkdtempSync(join(tmpdir(), 'roots-'))
    mkdirSync(join(unreadable, DATA_ROOT_FILE))
    assert.equal(orchestratorRoots({ ORCHESTRATOR_STATE_DIR: unreadable }, '/h').dataRoot, unreadable)
  })
})
