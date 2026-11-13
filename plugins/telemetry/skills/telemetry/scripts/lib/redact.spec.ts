// Each redaction pattern on a sample of its own, named by the mark it leaves: removing a pattern
// fails its case. The samples are assembled at run time so no token shape sits in the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entropy, ENV_VALUE_MIN, envPatterns, isHighEntropy, parseEnvFile, redactText, redactValue } from './redact.ts'

const join = (...parts: string[]): string => parts.join('')
const RANDOM = 'q7Lm2Xp9Rz4Kw8Nv3Tb6Hc1Yd5Fs0Gj'
const HUNTER = join('hun', 'ter2x')

const SAMPLES: readonly (readonly [pattern: string, text: string, secret: string])[] = [
  ['private-key', `key: ${join('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIE', RANDOM, '\n-----END RSA PRIVATE KEY-----')}`, `MIIE${RANDOM}`],
  ['github-token', `push with ${join('gh', 'p_', RANDOM, 'abcd')}`, join('gh', 'p_', RANDOM, 'abcd')],
  ['github-token', `pat ${join('github', '_pat_', RANDOM, '_', RANDOM)}`, RANDOM],
  ['anthropic-key', `export it ${join('sk-', 'ant-', 'api03-', RANDOM)}`, RANDOM],
  ['openai-key', `the key ${join('sk-', 'proj-', RANDOM)}`, RANDOM],
  ['aws-key', `aws ${join('AK', 'IA', 'Q7LM2XP9RZ4KW8NV')} here`, join('AK', 'IA', 'Q7LM2XP9RZ4KW8NV')],
  ['slack-token', `slack ${join('xo', 'xb-', '1234567890-', 'abcdefABCDEF')}`, join('xo', 'xb-', '1234567890-', 'abcdefABCDEF')],
  ['google-key', `maps ${join('AI', 'za', RANDOM, 'abcdef')}`, RANDOM],
  ['stripe-key', `pay ${join('sk', '_live_', RANDOM)}`, RANDOM],
  ['telegram-token', `bot ${join('123456789', ':', 'AAH', RANDOM)} ok`, join('AAH', RANDOM)],
  ['npm-token', `npm ${join('np', 'm_', RANDOM)}`, RANDOM],
  ['jwt', `jwt ${join('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'sig_nature_value')}`, 'eyJzdWIiOiIxMjM0In0'],
  ['authorization', 'curl -H "Authorization: token s3cr3t-value" https://api.example.com', 's3cr3t-value'],
  ['bearer', 'curl -H "X-Auth: Bearer abc.def.ghi-123456" x', 'abc.def.ghi-123456'],
  ['url-credentials', 'git clone https://someone:hunter2hunter2@git.example.com/a.git', 'hunter2hunter2'],
  ['url-credentials', 'git clone https://tokenvalue12345@git.example.com/a.git', 'tokenvalue12345'],
  ['url-secret', 'fetch https://api.example.com/v1?access_token=opensesame99&page=2', 'opensesame99'],
  ['secret-assignment', 'DB_PASSWORD=correcthorse psql', 'correcthorse'],
  ['secret-assignment', '{"client_secret": "shhh-not-for-you"}', 'shhh-not-for-you'],
  ['secret-assignment', 'PASSWORD="hush a b" make', ' a b'],
  ['secret-assignment', "PASSWORD='hush a b' make", ' a b'],
  ['secret-flag', join('mysql --pass', 'word ', HUNTER, ' -h db'), HUNTER],
  ['secret-flag', join('mysql --pass', 'word=', HUNTER, ' -h db'), HUNTER],
  ['secret-flag', 'cli --token t0ken-value list', 't0ken-value'],
  ['secret-flag', 'cli --token=t0ken-value list', 't0ken-value'],
  ['user-password', 'curl -u me:s3cretpass https://api.example.com', 's3cretpass'],
  ['password-flag', join('mysql -h db -', 'p', HUNTER, ' app'), HUNTER],
  ['password-flag', join('sshpass -', 'p ', HUNTER, ' ssh me@host'), HUNTER],
  ['password-flag', join('docker login -u me -', 'p ', HUNTER, ' registry.example'), HUNTER],
  ['password-flag', join('mysql -h db -', 'p', 'hun"ter"2x app'), 'ter'],
  ['password-flag', join('sshpass -', 'p ', "hun'ter'2x", ' ssh me@host'), '2x'],
  ['password-flag', join('docker login -u me -', 'p ', 'hun\\ ter2x registry.example'), 'ter2x'],
  ['password-flag', join('mysql -u me \\\n  -', 'p', HUNTER, ' app'), HUNTER],
  ['password-flag', join('sshpass \\\r\n  -', 'p ', HUNTER, ' ssh me@host'), HUNTER],
  ['password-flag', join('docker login -u me \\\n  -', 'p ', HUNTER, ' registry.example'), HUNTER],
  ['password-flag', join('mysql -', 'p', HUNTER, ' -e "select 1" -prompt x'), HUNTER],
  ['password-flag', join('sshpass -', 'p ', HUNTER, ' ssh me@host -p 22'), HUNTER],
  ['password-flag', join('mysql -e "select 1; select 2" -', 'p', HUNTER), HUNTER],
  ['password-flag', join("mysql -e 'a|b' -", 'p', HUNTER), HUNTER],
  ['password-flag', join('mysql -e "x \\" ; y" -', 'p', HUNTER), HUNTER],
  ['password-flag', join('/usr/bin/mysql -', 'p', HUNTER), HUNTER],
  ['password-flag', join('cd /tmp && sudo /usr/local/bin/mysql -', 'p', HUNTER), HUNTER],
  ['secret-assignment', join('DB_', 'PASS=', HUNTER, ' make'), HUNTER],
  ['secret-assignment', join('MYSQL_', 'PWD=', HUNTER, ' mysql'), HUNTER],
  ['authorization', join('curl -H "Authorization: Digest ', HUNTER, ' and more" https://api.example.com'), 'and more'],
  ['entropy', `the value ${RANDOM} stays out`, RANDOM],
]

for (const [pattern, text, secret] of SAMPLES) {
  test(`${pattern}: ${text.slice(0, 40)}`, () => {
    const out = redactText(text)
    assert.ok(out.text.includes(`[REDACTED:${pattern}]`), `${pattern} left no mark: ${out.text}`)
    assert.ok(!out.text.includes(secret), `the secret survived: ${out.text}`)
  })
}

test('env: every value of the env file, and every assignment of its keys', () => {
  const secrets = parseEnvFile('# comment\nexport API_HOST_PASS="pa ss word 1"\nSHORT=yes\nREPO=git@forge.example:me/logs.git\n')
  const out = redactText('ssh git@forge.example:me/logs.git then API_HOST_PASS=other and "pa ss word 1"; SHORT=yes', secrets)
  assert.equal(out.text, 'ssh [REDACTED:env] then [REDACTED:env] and "[REDACTED:env]"; SHORT=yes')
  assert.deepEqual(out.hits, ['env', 'env'])
})

test('env: a value shorter than the floor is kept, so common words survive', () => {
  assert.equal(ENV_VALUE_MIN, 8)
  assert.equal(envPatterns(new Map([['FLAG', 'true']])).length, 0)
  assert.equal(redactText('it is true', new Map([['FLAG', 'true']])).text, 'it is true')
})

test('parseEnvFile: quotes, export, inline comments and junk lines', () => {
  const env = parseEnvFile("A=1\nexport B='two words'\nC=three # note\nnot a line\n=x\nD=\"quoted # kept\" # note\nE='single' # note\n")
  assert.deepEqual([...env], [['A', '1'], ['B', 'two words'], ['C', 'three'], ['D', 'quoted # kept'], ['E', 'single']])
})

test('env: a quoted value followed by a comment is read whole, then redacted in a field', () => {
  const secrets = parseEnvFile('SERVICE_KEY="zq9-env-value-1" # the service\nOTHER_KEY=\'zq9-env-value-2\' # another\n')
  const event = { v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'tool_call', session: '60ed5626-9879-4041-892a-5db0ff0bad69', bash: { line: 'echo zq9-env-value-1 zq9-env-value-2' } }
  const { value } = redactValue(event, secrets)
  assert.deepEqual(value, { ...event, bash: { line: 'echo [REDACTED:env] [REDACTED:env]' } })
})

test('env: a double-quoted value has its escapes resolved, so the value matched is the one used', () => {
  const secrets = parseEnvFile('ESCAPED_KEY="zq9\\"env\\\\value\\$1" # note\nRAW_KEY=\'zq9\\"raw\\$2\'\n')
  assert.deepEqual([...secrets], [['ESCAPED_KEY', 'zq9"env\\value$1'], ['RAW_KEY', 'zq9\\"raw\\$2']])
  assert.equal(redactText('echo zq9"env\\value$1 done', secrets).text, 'echo [REDACTED:env] done')
})

test('entropy: words, model ids, paths, branches and uuids are kept', () => {
  for (const kept of [
    'claude-opus-5-5-20251101', 'ORCHESTRATOR_CONTEXT_GATE_TOKENS', 'isSpawnedSessionWithoutName', 'feat-telemetry-2026-11-13',
    'experimentalStripTypesNoWarnings', '60ed5626-9879-4041-892a-5db0ff0bad69', 'test_coverage_lines_85_branches',
  ]) assert.equal(isHighEntropy(kept), false, kept)
  assert.equal(redactText('/Users/me/dev/workspaces/claude-plugins/telemetry').hits.length, 0)
})

test('entropy: random runs with digits, or with both cases, are caught', () => {
  assert.equal(isHighEntropy(RANDOM), true)
  assert.equal(isHighEntropy('xKmPqRvTwZnBcFaaGhJk'), true)
  assert.equal(isHighEntropy('a3f9c2e1b7d4058e6f2a9c1b3e5d7f0a'), true)
  assert.ok(entropy('aaaa') === 0)
})

test('redaction is idempotent: a redacted text scans clean', () => {
  const secrets = parseEnvFile('TOKEN_X=abcdefgh12345678\n')
  for (const [, text] of SAMPLES) {
    const once = redactText(text, secrets).text
    assert.deepEqual(redactText(once, secrets).hits, [], once)
  }
})

test('password-flag: a second pass changes nothing, so the export is never blocked by it', () => {
  for (const [pattern, text] of SAMPLES.filter(([name]) => name === 'password-flag')) {
    const once = redactText(text).text
    assert.equal(redactText(once).text, once, `${pattern}: ${once}`)
  }
})

test('password-flag: bound to the command word, not to a path ending in it', () => {
  for (const line of ['find /var/lib/mysql -perm 600 -print -prune', 'ls x/y/mysql -print', 'echo /mysql/mysql -pfoo']) {
    assert.equal(redactText(line).text, line)
  }
})

test('password-flag: a separator outside quotes still ends the command', () => {
  const line = 'mysql -e x; echo -pfoo'
  assert.equal(redactText(line).text, line)
})

test('password-flag: linear time, so no input stalls the hook', () => {
  const inputs = [
    'mysql '.repeat(20000),
    join('mysql -u me ', '\\\n'.repeat(50000)),
    join('mysql -u me ', '\\\n'.repeat(50000), '-', 'p', HUNTER),
    join('sshpass ', '\\\n'.repeat(50000)),
    'mysql "a" '.repeat(20000),
    '/mysql'.repeat(20000),
  ]
  for (const input of inputs) {
    const start = performance.now()
    const out = redactText(input).text
    const elapsed = performance.now() - start
    assert.ok(elapsed < 200, `${input.slice(0, 20)}: ${Math.round(elapsed)} ms`)
    assert.ok(!out.includes(HUNTER), input.slice(0, 20))
  }
})

test('the option forms keep what holds no secret', () => {
  for (const kept of ['claude -p --max-tokens 100', 'git push -u origin main', 'tool --token-file ./path --pass-through x', 'mkdir -p a/b', 'docker run -p 8080:80 img', 'mysql -p app']) {
    assert.deepEqual(redactText(kept).hits, [], kept)
  }
})

test('redactValue: a token in an identifier field, nested or at the top level, is redacted', () => {
  const token = join('gh', 'p_', RANDOM, 'abcd')
  const event = {
    v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'tool_call', session: '60ed5626-9879-4041-892a-5db0ff0bad69',
    tool_use_id: token, nested: { agent: token, tool_use_id: token }, list: [{ agent: token }],
  }
  const { value, hits } = redactValue(event, new Map())
  assert.ok(!JSON.stringify(value).includes(token), JSON.stringify(value))
  assert.deepEqual(hits, ['github-token', 'github-token', 'github-token', 'github-token'])
})

test('redactValue: identifiers held to their shape, every other string scanned, other values kept', () => {
  const event = {
    v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'tool_call', session: '60ed5626-9879-4041-892a-5db0ff0bad69',
    tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv', agent: 'not an id!', count: 3, ok: true, none: null,
    bash: { line: `echo ${RANDOM}`, heads: ['echo', RANDOM] },
  }
  const { value, hits } = redactValue(event, new Map())
  assert.deepEqual(value, {
    ...event, agent: '[REDACTED:identifier]',
    bash: { line: 'echo [REDACTED:entropy]', heads: ['echo', '[REDACTED:entropy]'] },
  })
  assert.deepEqual(hits, ['identifier', 'entropy', 'entropy'])
})
