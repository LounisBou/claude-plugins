// hooks/tests/config-sync.test.ts
// The options-to-file bridge: what is stored is written, what is not set is
// left alone, and a failure never blocks a session start or a menu change.
import { expect, test } from 'claude-code/testing'
import { storedOptions, mergeConfig, isOwnRow, register } from '../config-sync.ts'
import { mount, fakeDollar, fakeNext } from './fakes.ts'

const FILE = '/home/u/.claude/statusline-config.txt'

test('stored options come from the plugin entry under any marketplace spelling, booleans only', () => {
  const settings = { pluginConfigs: {
    'statusbar@inline': { options: { SHOW_PR: false, SHOW_MODEL: 'no', OTHER: false } },
    'another-plugin': { options: { SHOW_BRANCH: false } },
  } }
  expect(storedOptions(settings, 'statusbar')).toEqual({ SHOW_PR: false })
  expect(storedOptions({}, 'statusbar')).toEqual({})
  expect(storedOptions(null, 'statusbar')).toEqual({})
})

test('merge rewrites a line in place, appends a missing one and keeps the rest', () => {
  const existing = '# mine\nSHOW_PR=1\nSHOW_MODEL=0\n'
  expect(mergeConfig(existing, { SHOW_PR: false, SHOW_BRANCH: true })).toBe('# mine\nSHOW_PR=0\nSHOW_MODEL=0\nSHOW_BRANCH=1\n')
  expect(mergeConfig('', { SHOW_PR: false })).toBe('SHOW_PR=0\n')
  expect(mergeConfig(existing, {})).toBe(existing)
})

test('a row is this plugin\'s when it is one of the fourteen under its name', () => {
  expect(isOwnRow('statusbar.SHOW_PR', 'statusbar')).toBe(true)
  expect(isOwnRow('statusbar@market.SHOW_PR', 'statusbar')).toBe(true)
  expect(isOwnRow('theme', 'statusbar')).toBe(false)
  expect(isOwnRow('other-plugin.SHOW_PR', 'statusbar')).toBe(false)
})

test('the module hooks session.start and config.set only', () => {
  expect(mount(register).map(r => [r.event, r.matcher])).toEqual([['session.start', undefined], ['config.set', undefined]])
})

test('session start writes the stored options and leaves every unset line alone', async () => {
  const start = mount(register)[0]
  const fx = fakeDollar({
    files: { [FILE]: 'SHOW_MODEL=0\nSHOW_PR=1\n' },
    pluginConfigs: { 'statusbar@inline': { options: { SHOW_PR: false } } },
  })
  const e = { reason: 'startup' }
  expect(await start.handler(fx.dollar, e, fakeNext())).toEqual({ passed: e })
  expect(fx.files.get(FILE)).toBe('SHOW_MODEL=0\nSHOW_PR=0\n')
})

test('session start with nothing stored never touches the file', async () => {
  const start = mount(register)[0]
  const fx = fakeDollar({ files: { [FILE]: 'SHOW_MODEL=0\n' } })
  await start.handler(fx.dollar, {}, fakeNext())
  expect(fx.files.get(FILE)).toBe('SHOW_MODEL=0\n')
  const absent = fakeDollar()
  await start.handler(absent.dollar, {}, fakeNext())
  expect(absent.files.size).toBe(0)
})

test('the file follows STATUSBAR_CONFIG and CLAUDE_CONFIG_DIR as the script does', async () => {
  const start = mount(register)[0]
  const stored = { 'statusbar': { options: { SHOW_PR: false } } }
  const dir = fakeDollar({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, pluginConfigs: stored })
  await start.handler(dir.dollar, {}, fakeNext())
  expect(dir.files.get('/cfg/statusline-config.txt')).toBe('SHOW_PR=0\n')
  const over = fakeDollar({ env: { CLAUDE_CONFIG_DIR: '/cfg', STATUSBAR_CONFIG: '/alt.txt' }, pluginConfigs: stored })
  await start.handler(over.dollar, {}, fakeNext())
  expect(over.files.get('/alt.txt')).toBe('SHOW_PR=0\n')
})

test('a menu change on one of the fourteen rows reaches the file after the host stored it', async () => {
  const set = mount(register)[1]
  const fx = fakeDollar({ pluginConfigs: { 'statusbar@inline': { options: { SHOW_BRANCH: false } } } })
  const e = { key: 'statusbar.SHOW_BRANCH', value: false }
  expect(await set.handler(fx.dollar, e, fakeNext())).toEqual({ passed: e })
  expect(fx.files.get(FILE)).toBe('SHOW_BRANCH=0\n')
  // A row of another owner changes nothing here.
  const other = fakeDollar({ pluginConfigs: { 'statusbar@inline': { options: { SHOW_BRANCH: false } } } })
  await set.handler(other.dollar, { key: 'theme', value: 'dark' }, fakeNext())
  expect(other.files.size).toBe(0)
})

test('a failing sync lets the start and the menu change through', async () => {
  const [start, set] = mount(register)
  const fx = fakeDollar({ failSettings: true })
  const e = { key: 'statusbar.SHOW_PR', value: false }
  const next = fakeNext('settings unavailable')
  expect(await start.net(fx.dollar, e, next)).toEqual({ passed: e })
  expect(await set.net(fx.dollar, e, next)).toEqual({ passed: e })
})
