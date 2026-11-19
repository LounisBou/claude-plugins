// Each redaction pattern on a sample of its own, named by the mark it leaves: removing a pattern
// fails its case. The samples are assembled at run time so no token shape sits in the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  ['secret-flag', join('cli --to', 'ken ', 't0ken-value', ' list'), 't0ken-value'],
  ['secret-flag', join('cli --to', 'ken=', 't0ken-value', ' list'), 't0ken-value'],
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

test('redactValue: an object key is redacted like a value, at any depth', () => {
  const value = 'a-long-enough-value'
  const token = join('gh', 'p_', RANDOM, 'abcd')
  const event = { [value]: 1, nested: { [value]: { deeper: [{ [value]: 'kept', [token]: true }] } } }
  const redacted = redactValue(event, new Map([['SERVICE_PASS', value]]))
  assert.deepEqual(redacted.value, { '[REDACTED:env]': 1, nested: { '[REDACTED:env]': { deeper: [{ '[REDACTED:env]': 'kept', '[REDACTED:github-token]': true }] } } })
  assert.deepEqual(redacted.hits, ['env', 'env', 'env', 'github-token'])
  assert.ok(!JSON.stringify(redacted.value).includes(value))
  assert.ok(!JSON.stringify(redacted.value).includes(token))
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

test('redactValue: the ids of an API call (message, request, prompt) are random by nature and kept, held to their shape; a token in one is redacted', () => {
  const ids = { message: 'msg_011Ch9Es93SpXusjSjN2z4sa', request: 'req_011Ch9Es8qYCGYKBz92ALbJh', prompt: '0dabbd84-0845-49a7-aaf7-5a1ce0b31ee4' }
  const event = { v: 1, ts: '2026-11-13T20:00:00.000Z', event: 'api_call', session: '60ed5626-9879-4041-892a-5db0ff0bad69', ...ids }
  assert.deepEqual(redactValue(event, new Map()).value, event)
  const token = join('gh', 'p_', RANDOM, 'abcd')
  const redacted = redactValue({ ...event, message: token, request: 'not an id!' }, new Map())
  assert.ok(!JSON.stringify(redacted.value).includes(token))
  assert.equal((redacted.value as Record<string, unknown>)['request'], '[REDACTED:identifier]')
})

// Fixtures computed at run time, never literals: a git object id, or a key of the same shape, is 40 hex.
const hexOf = (algorithm: 'sha1' | 'sha256' | 'md5', seed: string): string => createHash(algorithm).update(seed).digest('hex')
const SHA = hexOf('sha1', 'git-object-1')
const SHA_2 = hexOf('sha1', 'git-object-2')

test('the fixtures are what the entropy guess would redact, so a kept one is the context\'s doing', () => {
  for (const hex of [SHA, SHA_2, hexOf('sha256', 'k'), hexOf('md5', 'k')]) assert.equal(isHighEntropy(hex), true, hex)
})

// One case per shape git prints or a command and a URL carry: the id is kept in each.
const GIT_SHAPES: readonly (readonly [shape: string, text: string])[] = [
  ['line start', `${SHA} refs/tags/v1`],
  ['text start', SHA],
  ['commit word', `commit ${SHA}\nAuthor: me`],
  ['commit url', `https://github.com/acme/thing/commit/${SHA}`],
  ['range', `git log ${SHA}..${SHA_2}`],
  ['three dots', `git diff ${SHA}...${SHA_2}`],
  ['path', `git show ${SHA}:docs/a.md`],
  ['sha colon', `sha: ${SHA}`],
  ['json sha', `{"sha": "${SHA}"}`],
  ['head word', `head ${SHA}`],
  ['sha equal', `sha=${SHA}`],
  ['sha flag', `gh api -f sha=${SHA}`],
  ['--sha=', `gh.py pr-merge 12 --sha=${SHA}`],
  ['ref query', `https://api.example.com/contents?ref=${SHA}`],
  ['head dash', `head-${SHA}`],
  ['commit underscore', `commit_${SHA}`],
  ['match head commit', `gh pr merge 12 --match-head-commit=${SHA}`],
  ['env sha', `GIT_COMMIT_SHA=${SHA} make`],
  ['pinned action', `uses: actions/checkout@${SHA}`],
  ['pinned action path', `uses: acme/thing/.github/workflows/ci.yml@${SHA}`],
  ['quoted by backticks', `head \`${SHA}\``],
]

for (const [shape, text] of GIT_SHAPES) {
  test(`entropy: a git object id is kept: ${shape}`, () => {
    assert.deepEqual(redactText(text), { text, hits: [] })
  })
}

// Each of these is a 40-hex key, or any other hex of the shape of none: the id is redacted.
const LEAKS: readonly (readonly [form: string, text: string])[] = [
  ['key colon', `key: ${SHA}`],
  ['app key colon', `DD_APP_KEY: ${SHA}`],
  ['quoted', `DD_APP_KEY "${SHA}"`],
  ['token word', `GITHUB_TOKEN ${SHA}`],
  ['json key', `{"key": "${SHA}"}`],
  ['json app_key', `{"app_key":"${SHA}"}`],
  ['header', `curl -H 'DD-APPLICATION-KEY: ${SHA}' x`],
  ['assignment', `DD_APP_KEY=${SHA}`],
  ['after an at sign', `password@${SHA}`],
  ['backticks, no git word', `key \`${SHA}\``],
  ['prose', `merged at ${SHA}.`],
  ['after a path', `refs/heads/x ${SHA}`],
  ['glued before', `x${SHA}`],
  ['two ids glued', `${SHA}_${SHA_2}`],
  ['32 hex', `value ${hexOf('md5', 'k')}`],
  ['64 hex', `value ${hexOf('sha256', 'k')}`],
  ['41 hex', `value ${SHA}0`],
  ['39 hex', `value ${SHA.slice(1)}`],
  ['upper case', `value ${SHA.toUpperCase()}`],
]

for (const [form, text] of LEAKS) {
  test(`entropy: a hex secret is redacted where no git object stands: ${form}`, () => {
    const out = redactText(text)
    assert.ok(out.hits.includes('entropy'), out.text)
    assert.ok(!out.text.includes(SHA) && !out.text.includes(SHA.slice(1)) && !out.text.includes(SHA.toUpperCase()), out.text)
  })
}

test('a git object id given as the value of a secret, or after a token word, is still redacted by its own pattern', () => {
  const cases: readonly (readonly [string, string])[] = [
    [join('API_', 'TOKEN=', SHA, ' make'), 'secret-assignment'],
    [join('curl -H "Authorization: token ', SHA, '" x'), 'authorization'],
    [join('curl -H "X-Auth: Bearer ', SHA, '" x'), 'bearer'],
    [join('cli --to', 'ken ', SHA, ' list'), 'secret-flag'],
    [`fetch https://api.example.com/v1?access_token=${SHA}&page=2`, 'url-secret'],
    [join('git clone https://', SHA, '@git.example.com/a.git'), 'url-credentials'],
  ]
  for (const [text, pattern] of cases) {
    const out = redactText(text)
    assert.ok(out.hits.includes(pattern), `${pattern}: ${out.text}`)
    assert.ok(!out.text.includes(SHA), out.text)
  }
})

test('a value of ~/.env that is a git object id in a git context is still redacted', () => {
  const out = redactText(`commit ${SHA} ok`, new Map([['LEGACY_KEY', SHA]]))
  assert.deepEqual(out, { text: 'commit [REDACTED:env] ok', hits: ['env'] })
})

test('redactValue: a git object id is kept under a git field, or none, and redacted under any other', () => {
  const kept = { sha: SHA, commit: { head: SHA }, shas: [SHA, SHA_2], data: { parent_sha: SHA }, headSha: SHA }
  assert.deepEqual(redactValue(kept, new Map()), { value: kept, hits: [] })
  assert.deepEqual(redactValue([SHA], new Map()), { value: [SHA], hits: [] })
  const out = redactValue({ key: SHA, app_key: SHA, value: [SHA], data: { id: SHA } }, new Map())
  assert.deepEqual(out.value, { key: '[REDACTED:entropy]', app_key: '[REDACTED:entropy]', value: ['[REDACTED:entropy]'], data: { id: '[REDACTED:entropy]' } })
})

test('redactValue: a field that names a secret carries down through arrays and nested objects, a git field inside it included', () => {
  const event = { token: SHA, tokens: [SHA, [SHA]], credentials: { value: SHA }, secrets: { a: SHA, deep: { b: [SHA] } }, secret: { sha: SHA, list: [{ sha: SHA }] } }
  const out = redactValue(event, new Map())
  assert.ok(!JSON.stringify(out.value).includes(SHA), JSON.stringify(out.value))
  assert.equal(out.hits.length, 8)
})

test('entropy: only the random name of a macOS temporary directory is kept after /var/folders/xx/', () => {
  const dir = hexOf('sha1', 'tmp').slice(0, 30)
  for (const text of [`/var/folders/fz/${dir}/T/x.json`, `/private/var/folders/fz/${dir}/T/`]) {
    assert.deepEqual(redactText(text), { text, hits: [] }, text)
  }
  const mixed = RANDOM.toLowerCase()
  for (const text of [`/var/other/fz/${dir}/T/`, `/var/folders/${dir}/T/`, `value ${dir}`, `/var/folders/fz/${RANDOM}/T`, `/var/folders/fz/${mixed}`, `/var/folders/fz/${dir}${dir}/T`]) {
    assert.deepEqual(redactText(text).hits, ['entropy'], text)
  }
})

test('entropy: many git object ids in one text are read in linear time', () => {
  const text = Array.from({ length: 20000 }, (_, i) => `commit ${hexOf('sha1', String(i))}`).join('\n')
  const start = performance.now()
  assert.deepEqual(redactText(text).hits, [])
  assert.ok(performance.now() - start < 2000)
})
