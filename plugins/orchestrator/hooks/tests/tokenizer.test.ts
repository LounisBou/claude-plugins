// hooks/tests/tokenizer.test.ts
// The push tokeniser's fixtures: every command line the shell suite refused
// (tests/run-tests.sh, the push guard section) and every one it accepted,
// moved here module-side — the awk script and its shell cases stay green until
// Task 12 retires them. Two lines the plan names that no suite carried yet
// ($((...)) arithmetic holding a <<, and a Unicode command line) are added on
// the awk's own verdicts, probed against hooks/push-guard.sh before landing.
import { expect, test } from 'claude-code/testing'
import { detectForces } from '../tokenizer.ts'

const refused = [
  'git push --force origin main',
  'git push -f origin main',
  'git push origin +feature:main',
  'git push --force-with-lease origin main',
  'git push --force-with-lease=main origin main',
  'git -C /tmp/r push --force',
  'git -C . push --force-with-lease',
  'git -c x=y push -f',
  'git --no-pager push -f',
  '/usr/bin/git push -f origin main',
  'git --git-dir=/tmp/r/.git --work-tree /tmp/r push -f',
  'FOO=1 git push -f',
  'timeout 60 git push --force origin main',
  'env -u X git push -f',
  'git push -uf origin main',
  'git push -fu origin main',
  'git push -vf',
  'git push -nf',
  '(cd x && git push -f)',
  'git push -f)',
  'git push "-f"',
  'git push origin "+main"',
  "git push origin 'a:b' '+x'",
  'git push -f`true`',
  'git push -f>out',
  '{ git push -f; }',
  'git push origin main 2>/dev/null --force',
  'git push \\\n  --force origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease=other origin main',
  'git push --mirror origin',
  'git push --fo origin main',
  'git push --for origin main',
  'git push --forc origin main',
  'git commit -F - <<\'EOF\'\ngit push --force\nEOF\ngit push -f',   // heredoc body is data; the real push after it is read
  // Moved from the shell suite: a forced push after a heredoc is still read,
  // and one inside a command substitution is a command of its own.
  'cat <<EOF\ntext\nEOF\ngit push -f',
  'echo "$(git push -f)"',
  // The plan's two named cases, absent from every suite until now: a << inside
  // $((...)) is arithmetic, not a heredoc that swallows what follows, and a
  // multibyte character shifts no token boundary.
  'echo $((1 << 2))\ngit push -f',
  'echo ✅ && git push -f',
]

const accepted = [
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main',
  'git push origin main',
  'git status',
  'git fetch -f && git push origin main',
  'git push -o +foo origin main',
  'git push -o+foo -v origin main',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' --force-with-lease=dev:' + 'a'.repeat(40) + ' origin main dev',
  'git push --force-with-lease=main:' + 'a'.repeat(40) + ' origin main 2>&1 | tail -3',
  'git commit -m "fix; git push -f later"',
  'gh pr create --body "rebase && git push --force is refused"',
  // Moved from the shell suite: a heredoc body, a heredoc inside a quoted
  // substitution with a stray quote in it, and a comment — data, never commands.
  'git commit -F - <<\'EOF\'\nsubject\n\ngit push --force\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nsay \\"why; git push -f is refused\nEOF\n)"',
  'git push origin main # --force',
  // The pinned lease is a shape, not a length — the awk accepts any non-empty
  // sha, and a hex-length limit would refuse a SHA-256 repository's 64-char ids.
  'git push --force-with-lease=main:deadbeef origin main',
]

test('every forced form the shell suite refused is refused here', () => {
  for (const c of refused) expect(detectForces(c), c).not.toEqual([])
})

test('everything the shell suite accepted is accepted here', () => {
  for (const c of accepted) expect(detectForces(c), c).toEqual([])
})
