#!/usr/bin/env bash
# The launcher's own push guard, enforced by the harness rather than remembered by the
# model — the same reasoning as hooks/context-gate.sh.
#
# Active only in a session the launcher spawned: iterm_agent.py's build_command exports
# ORCHESTRATOR_SPAWNED=1 in the launch command it hands the app, and this hook does
# nothing unless that is set. The operator's own sessions carry no such marker and are
# never touched by it.
#
# WHY A HOOK. Phase 3 ruling 5: a rebase is pushed with `--force-with-lease=<branch>:<sha
# read>`, the only force allowed; every other force push stays refused. A sentence the
# model must remember is a sentence it can rationalise away under pressure to "just get
# the branch up"; a check the harness runs before the command executes is not.
#
# Runs on PreToolUse for Bash. The command line is tokenised the way the shell reads it —
# quotes removed, `;` `&` `|` `(` `)` newlines and backticks separating commands, `<` `>`
# `{` `}` separating words, heredoc bodies and `#` comments dropped, `$(…)` read as a
# command of its own — and only a command whose first word is git (bare or by a path,
# after assignments and a known wrapper such as `timeout` or `env`) followed by git's
# global options and then `push` is read for a force: `--force` or an abbreviation of it,
# `-f` alone or inside a cluster of short flags, `--mirror`, a `+<refspec>`, or any
# `--force-with-lease` not of the form `=<branch>:<sha>`. Text that only mentions a push —
# a commit message, a pull request body, a heredoc — is an argument, never a command.
#
# It reads text, so a push it cannot see as text passes: one inside a string another
# program runs (`sh -c`, `bash -c`, `eval`), behind a variable or an alias, or through a
# wrapper it does not know.
set -u

[ -n "${ORCHESTRATOR_SPAWNED:-}" ] || exit 0

# A guard that cannot read its input says so and lets the call through: blocking every
# command of the session because a tool is missing would be worse than the push it guards.
if ! command -v jq >/dev/null 2>&1; then
    echo "push-guard: jq is not installed, so git push is NOT checked in this launcher-spawned session; install jq to restore the guard" >&2
    exit 0
fi

payload="$(cat 2>/dev/null || true)"
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)"
[ "$tool_name" = "Bash" ] || exit 0

command="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$command" ] || exit 0

# One awk pass: the tokeniser feeds every completed simple command to `analyze`, which
# prints what forces the push, if it is one. Byte-wise (LC_ALL=C): every character that
# matters to the shell is ASCII, and a multibyte one must not shift an index.
read -r -d '' TOKENISE <<'AWK'
function push(cl) { flush_word(); d++; closer[d] = cl; nw[d] = 0; pd[d] = 0; dq[d] = 0; sk[d] = 0 }
function pop() { flush_word(); flush_cmd(); d--; cur = ""; started = dq[d] ? 1 : 0 }
function flush_word() {
    if (started) {
        if (sk[d]) sk[d] = 0
        else { nw[d]++; W[d, nw[d]] = cur }
    }
    cur = ""; started = 0
}
function flush_cmd() { analyze(d); nw[d] = 0; sk[d] = 0 }
# `$((…))` is arithmetic, not a command: skipped whole, so a `<<` inside it is no heredoc.
function arith(j,   n, ch) {
    n = 0
    for (; j <= L; j++) {
        ch = substr(s, j, 1)
        if (ch == "(") n++
        else if (ch == ")") { n--; if (n == 0) return j + 1 }
    }
    return j
}
# After `<<` or `<<-`: the delimiter, quotes removed. The body starts at the next newline.
function heredoc(j,   ch, dl, strip, q) {
    strip = 0
    if (substr(s, j, 1) == "-") { strip = 1; j++ }
    while (substr(s, j, 1) == " " || substr(s, j, 1) == "\t") j++
    dl = ""
    for (; j <= L; j++) {
        ch = substr(s, j, 1)
        if (ch == "'" || ch == "\"") {
            q = index(substr(s, j + 1), ch)
            if (q == 0) { dl = dl substr(s, j + 1); j = L + 1; break }
            dl = dl substr(s, j + 1, q - 1); j += q; continue
        }
        if (ch == "\\") { dl = dl substr(s, j + 1, 1); j++; continue }
        if (ch ~ /[ \t\n;|&<>()]/) break
        dl = dl ch
    }
    hn++; HD[hn] = dl; HS[hn] = strip
    return j
}
function bodies(j,   k, e, line) {
    for (k = hdone + 1; k <= hn; k++) {
        while (j <= L) {
            e = index(substr(s, j), "\n")
            if (e == 0) { line = substr(s, j); j = L + 1 }
            else { line = substr(s, j, e - 1); j += e }
            if (HS[k]) sub(/^\t+/, "", line)
            if (line == HD[k]) break
        }
    }
    hdone = hn
    return j
}
function prefix_of(name, full, min) { return length(name) >= min && index(full, name) == 1 }
function seen(r) { if (index(found, r) == 0) found = found (found == "" ? "" : ", ") r }
function analyze(d,   n, k, w, j, ch, name, val, eq, skip, ddash, wrap) {
    n = nw[d]; k = 1
    while (k <= n) {
        w = W[d, k]
        if (w ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || (w in RESERVED)) { k++; continue }
        if (w in WRAPPER) {
            wrap = w; k++
            while (k <= n && W[d, k] ~ /^-/) { k += (((wrap, W[d, k]) in VALUED) ? 2 : 1) }
            if (wrap == "timeout" || wrap == "gtimeout") k++
            continue
        }
        break
    }
    if (k > n || W[d, k] !~ /^(.*\/)?git$/) return
    for (k++; k <= n && W[d, k] ~ /^-/; k++) if (W[d, k] in GITVALUED) k++
    if (k > n || W[d, k] != "push") return
    skip = 0; ddash = 0
    for (k++; k <= n; k++) {
        w = W[d, k]
        if (skip) { skip = 0; continue }
        if (!ddash && w == "--") { ddash = 1; continue }
        if (!ddash && w ~ /^--/) {
            eq = index(w, "=")
            name = eq ? substr(w, 1, eq - 1) : w
            val = eq ? substr(w, eq + 1) : ""
            if (prefix_of(name, "--force", 4)) seen("--force")
            else if (prefix_of(name, "--force-with-lease", 9)) {
                if (!eq || val !~ /^[^:= \t\n]+:[^ \t\n]+$/) seen("--force-with-lease without <branch>:<sha>")
            }
            else if (prefix_of(name, "--mirror", 4)) seen("--mirror")
            else if (!eq && (name in PUSHVALUED)) skip = 1
            continue
        }
        if (!ddash && w ~ /^-./) {
            for (j = 2; j <= length(w); j++) {
                ch = substr(w, j, 1)
                if (ch == "f") seen("-f")
                if (ch == "o") { if (j == length(w)) skip = 1; break }
            }
            continue
        }
        if (w ~ /^\+/) seen("a +<refspec>")
    }
}
BEGIN {
    split("! if then else elif do while until time", a, " "); for (i in a) RESERVED[a[i]] = 1
    split("env command builtin exec nohup nice timeout gtimeout sudo xargs", a, " "); for (i in a) WRAPPER[a[i]] = 1
    split("env -u|env -C|env -S|nice -n|timeout -s|timeout -k|gtimeout -s|gtimeout -k|sudo -u|sudo -g|sudo -C|sudo -h|sudo -p|xargs -n|xargs -I|xargs -P|xargs -L|xargs -s|xargs -d|xargs -E|xargs -a", a, "|")
    for (i in a) { split(a[i], b, " "); VALUED[b[1], b[2]] = 1 }
    split("-C -c --git-dir --work-tree --namespace --super-prefix --config-env", a, " "); for (i in a) GITVALUED[a[i]] = 1
    split("--repo --push-option --receive-pack --exec", a, " "); for (i in a) PUSHVALUED[a[i]] = 1
}
{ s = s $0 "\n" }
END {
    L = length(s); d = 0; i = 1
    while (i <= L) {
        c = substr(s, i, 1); n1 = substr(s, i + 1, 1)
        if (dq[d]) {
            if (c == "\"") { dq[d] = 0; i++ }
            else if (c == "\\") {
                if (n1 == "\n") i += 2
                else { cur = cur (n1 ~ /[$`"\\]/ ? n1 : c n1); i += 2 }
            }
            else if (c == "`") { push("`"); i++ }
            else if (c == "$" && n1 == "(") {
                if (substr(s, i + 2, 1) == "(") i = arith(i + 1)
                else { push(")"); i += 2 }
            }
            else { cur = cur c; i++ }
            continue
        }
        if (c == " " || c == "\t") { flush_word(); i++ }
        else if (c == "\n") { flush_word(); flush_cmd(); i = bodies(i + 1) }
        else if (c == "\\") { if (n1 != "\n") { cur = cur n1; started = 1 } i += 2 }
        else if (c == "'") {
            j = index(substr(s, i + 1), "'")
            if (j == 0) { cur = cur substr(s, i + 1); i = L + 1 }
            else { cur = cur substr(s, i + 1, j - 1); i += j + 1 }
            started = 1
        }
        else if (c == "$" && (n1 == "'" || n1 == "\"")) i++
        else if (c == "\"") { dq[d] = 1; started = 1; i++ }
        else if (c == "#" && !started) { while (i <= L && substr(s, i, 1) != "\n") i++ }
        else if (c == "$" && n1 == "(") {
            if (substr(s, i + 2, 1) == "(") { i = arith(i + 1); started = 1 }
            else { push(")"); i += 2 }
        }
        else if (c == "`") { if (d > 0 && closer[d] == "`") pop(); else push("`"); i++ }
        else if (c == "(") { flush_word(); flush_cmd(); pd[d]++; i++ }
        else if (c == ")") {
            flush_word(); flush_cmd()
            if (pd[d] > 0) pd[d]--
            else if (d > 0 && closer[d] == ")") pop()
            i++
        }
        else if (c == ";" || c == "|") { flush_word(); flush_cmd(); i++ }
        else if (c == "&") { flush_word(); if (n1 != ">") flush_cmd(); i++ }
        else if (c == "<" && n1 == "<") {
            flush_word()
            if (substr(s, i + 2, 1) == "<") { sk[d] = 1; i += 3 }
            else i = heredoc(i + 2)
        }
        else if (c == "<" || c == ">") {
            flush_word(); i++
            while (substr(s, i, 1) ~ /[<>&|]/) i++
            sk[d] = 1
        }
        else if (c == "{" || c == "}") { flush_word(); i++ }
        else { cur = cur c; started = 1; i++ }
    }
    flush_word(); flush_cmd()
    while (d > 0) pop()
    if (found != "") print found
}
AWK

forced="$(printf '%s\n' "$command" | LC_ALL=C awk "$TOKENISE" 2>/dev/null)"
[ -n "$forced" ] || exit 0

# The host's documented denial for this event: exit 2, the reason on stderr, read back by
# the session as the tool's answer.
echo "git push refused: this session was spawned by the launcher, and the only forced push allowed here is --force-with-lease=<branch>:<sha> with the sha you read. Seen: $forced. If the command only mentions a push, put text that mentions a push in a file (\`git commit -F\`, \`gh … --body-file\`)." >&2
exit 2
