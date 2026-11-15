// hooks/tests/config-sync.test.ts
// The options-to-file bridge: what is stored is written, what is not set is
// left alone, and a failure never blocks a session start or a menu change.
import { expect, test } from 'claude-code/testing'
import { storedOptions, mergeConfig, isOwnRow } from '../config-sync.ts'
import { world } from './fakes.ts'

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

test('session start writes the stored options and leaves every unset line alone', async ($, on) => {
  const fx = world(on, {
    files: { [FILE]: 'SHOW_MODEL=0\nSHOW_PR=1\n' },
    pluginConfigs: { 'statusbar@inline': { options: { SHOW_PR: false } } },
  })
  expect(await $.session.start({ cwd: '/work' })).toMatchObject({ cwd: '/work' })
  expect(fx.files.get(FILE)).toBe('SHOW_MODEL=0\nSHOW_PR=0\n')
})

test('session start with nothing stored never touches the file', async ($, on) => {
  const fx = world(on, { files: { [FILE]: 'SHOW_MODEL=0\n' } })
  await $.session.start({ cwd: '/work' })
  expect(fx.files.get(FILE)).toBe('SHOW_MODEL=0\n')
})

test('with nothing stored and no file, none is written', async ($, on) => {
  const fx = world(on)
  await $.session.start({ cwd: '/work' })
  expect(fx.files.size).toBe(0)
})

test('the file follows CLAUDE_CONFIG_DIR as the script does', async ($, on) => {
  const fx = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, pluginConfigs: { 'statusbar': { options: { SHOW_PR: false } } } })
  await $.session.start({ cwd: '/work' })
  expect(fx.files.get('/cfg/statusline-config.txt')).toBe('SHOW_PR=0\n')
})

test('STATUSBAR_CONFIG wins over CLAUDE_CONFIG_DIR', async ($, on) => {
  const fx = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg', STATUSBAR_CONFIG: '/alt.txt' }, pluginConfigs: { 'statusbar': { options: { SHOW_PR: false } } } })
  await $.session.start({ cwd: '/work' })
  expect(fx.files.get('/alt.txt')).toBe('SHOW_PR=0\n')
})

test('a menu change on one of the fourteen rows reaches the file after the host stored it', async ($, on) => {
  const fx = world(on, { pluginConfigs: { 'statusbar@inline': { options: { SHOW_BRANCH: false } } } })
  const e = { key: 'statusbar.SHOW_BRANCH', value: false }
  expect(await $.config.set(e)).toMatchObject({ value: false })
  expect(fx.files.get(FILE)).toBe('SHOW_BRANCH=0\n')
})

test('a menu change on a row of another owner changes nothing here', async ($, on) => {
  const fx = world(on, { pluginConfigs: { 'statusbar@inline': { options: { SHOW_BRANCH: false } } } })
  await $.config.set({ key: 'theme', value: 'dark' })
  expect(fx.files.size).toBe(0)
})

test('a failing sync lets the start and the menu change through', async ($, on) => {
  world(on, { failSettings: true })
  expect(await $.session.start({ cwd: '/work' })).toMatchObject({ cwd: '/work' })
  const e = { key: 'statusbar.SHOW_PR', value: false }
  expect(await $.config.set(e)).toMatchObject({ value: false })
})
