#!/usr/bin/env python3
"""goals.py: the spec's goals of one build, one file, read by the stop gate.

    goals.py init     <goals.md> --spec <path>|none [--aim "<text>"] [--goal "<text>"]... [--repo <dir>] [--replace]
    goals.py status   <goals.md>
    goals.py line     <goals.md>
    goals.py unplanned <goals.md>
    goals.py plan     <goals.md> <G> --phase "<text>"
    goals.py met      <goals.md> <G> --evidence "<token>"...
    goals.py rule-out <goals.md> <G> --ruling "<the operator's words>"
    goals.py defer    <goals.md> <G> --ruling "<the operator's words>"
    goals.py reopen   <goals.md> <G>
    goals.py check    <goals.md> [--json]

Run through `dispatch-record.sh goals <record> <subcommand> ...`, which names the file beside
the record (`<record's directory>/goals.md`) and registers the record under the session.

Why it exists: a build was declared done against its plan while three of its spec's five
goals had been moved « after the build » by the plan itself. Nothing measured done against
the spec, because the spec's goals lived nowhere a command could read. They live here now,
once, with their status: `open`, `met` (with evidence a local read can verify) or
`ruled-out` (with the operator's own words), or `deferred` (open work the operator put off,
with his words: the goal stays unmet, and the stop gate takes the ending `waiting: deferred`). The stop gate refuses `waiting: done` while a
goal is open or a row does not hold.

The file is Markdown: a header (`spec:`, `repo:`, `aim:`), then one table row per goal,
`| id | status | goal | plan | evidence or ruling |`. A literal `|` in a cell is written `\\|`.

Grammar, checked here and nowhere else:
- `met` needs at least one token a local read verifies: a path (absolute, `~/`, or relative
  to `repo:`) that exists, or `commit:<sha>` that git resolves in `repo:`. `pr:#<n>` and
  `run:<cmd>` may stand beside those, never alone: no network is read at a stop. Tokens are
  `;`-separated, and every path or commit token must verify.
- `ruled-out` and `deferred` need `operator: « <his words> »`, not empty.
- An `open` goal with an empty `plan` is in no phase: `unplanned`.
- With `spec:` a path whose `## Goals` lists numbered items, the rows match those items one
  for one, each goal's text equal to one item's after whitespace is collapsed, and `aim:`
  appears verbatim in the spec. A spec that has moved skips that match, and says so.

`check` exits 0 when every goal holds, 1 when one is held (open, deferred, or a fault), 2 when
the file cannot be read. `--json` prints `{ok, open, deferred, unplanned, faults, notes, rows,
met, ruled_out, table}` for the stop gate; `open` lists the goals still to work, `deferred` the
ones put off.
"""

import json
import os
import re
import subprocess
import sys

STATUSES = ("open", "met", "ruled-out", "deferred")
HEADER = "| id | status | goal (verbatim from the spec) | plan | evidence or ruling |"
RULE = "|---|---|---|---|---|"
COMMENT = "<!-- Evidence is the goal's OUTCOME on an artifact, never the tool that would produce it. -->"
RULING = re.compile(r"^operator:\s*«\s*(.*?)\s*»\s*$", re.S)


class Fault(Exception):
    pass


def die(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def collapse(text):
    return " ".join(text.split())


def escape(text):
    return collapse(text).replace("|", "\\|")


def split_row(line):
    """The cells of one table row, `\\|` kept as a literal pipe."""
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    cells, cell, i = [], "", 0
    while i < len(body):
        if body[i] == "\\" and i + 1 < len(body) and body[i + 1] == "|":
            cell += "|"
            i += 2
            continue
        if body[i] == "|":
            cells.append(cell.strip())
            cell = ""
        else:
            cell += body[i]
        i += 1
    cells.append(cell.strip())
    return cells


# --- the spec ------------------------------------------------------------------------------

def section(text, title):
    """The lines under the `## <title>` heading, up to the next heading of level 1 or 2."""
    lines = text.split("\n")
    out, inside = [], False
    for line in lines:
        if re.match(r"^#{1,2}\s", line):
            if inside:
                break
            inside = re.match(rf"^##\s+{re.escape(title)}\s*$", line, re.I) is not None
            continue
        if inside:
            out.append(line)
    return out if inside or out else None


def spec_goals(text):
    """The numbered items under the spec's `## Goals`, each collapsed; None without one."""
    lines = section(text, "Goals")
    if lines is None:
        return None
    items, current = [], None
    for line in lines:
        m = re.match(r"^\s{0,3}\d+[.)]\s+(.*)$", line)
        if m:
            if current is not None:
                items.append(collapse(current))
            current = m.group(1)
        elif current is not None and line.strip() and (line.startswith(" ") or line.startswith("\t")):
            current += " " + line.strip()
        elif current is not None and not line.strip():
            continue
        elif current is not None:
            items.append(collapse(current))
            current = None
    if current is not None:
        items.append(collapse(current))
    return items or None


def spec_aim(text):
    """The first paragraph under the spec's `## Why`, collapsed, or ''."""
    lines = section(text, "Why") or []
    para = []
    for line in lines:
        if line.strip():
            para.append(line)
        elif para:
            break
    return collapse(" ".join(para))


# --- the file ------------------------------------------------------------------------------

def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as err:
        raise Fault(f"cannot read {path}: {err.strerror}")
    head = {"spec": "", "repo": "", "aim": ""}
    rows = []
    for line in text.split("\n"):
        m = re.match(r"^(spec|repo|aim):\s?(.*)$", line)
        if m and not rows:
            head[m.group(1)] = m.group(2).strip()
            continue
        if not line.startswith("|") or line.strip() in (HEADER, RULE) or re.match(r"^\|[-| :]+\|$", line.strip()):
            continue
        cells = split_row(line)
        if cells and cells[0].lower() == "id":
            continue
        if len(cells) != 5:
            raise Fault(f"{path}: a row does not have five cells: {line.strip()}")
        rows.append(dict(zip(("id", "status", "goal", "plan", "evidence"), cells)))
    if not head["spec"]:
        raise Fault(f"{path}: no spec: line")
    return head, rows


def write(path, head, rows):
    lines = ["# Goals", f"spec: {head['spec']}", f"repo: {head['repo']}", f"aim: {head['aim']}", COMMENT, "", HEADER, RULE]
    for r in rows:
        lines.append("| " + " | ".join(escape(r[k]) for k in ("id", "status", "goal", "plan", "evidence")) + " |")
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


def find(rows, gid):
    for r in rows:
        if r["id"] == gid:
            return r
    die(f"no goal {gid} (goals: {', '.join(r['id'] for r in rows) or 'none'})")


# --- evidence ------------------------------------------------------------------------------

def tokens(cell):
    return [t.strip() for t in cell.split(";") if t.strip()]


def token_fault(token, repo):
    """None when the token holds, else why it does not. `pr:` and `run:` hold unread."""
    if token.startswith("pr:") or token.startswith("run:"):
        return None
    if token.startswith("commit:"):
        sha = token[len("commit:"):].strip()
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha):
            return f"{token} is no commit sha"
        try:
            done = subprocess.run(["git", "-C", repo or ".", "cat-file", "-e", f"{sha}^{{commit}}"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return f"{token} could not be resolved"
        return None if done.returncode == 0 else f"{token} does not resolve in {repo or '.'}"
    path = os.path.expanduser(token)
    if not os.path.isabs(path):
        path = os.path.join(repo or ".", path)
    return None if os.path.exists(path) else f"{token} does not exist"


def verifiable(token):
    return not (token.startswith("pr:") or token.startswith("run:"))


def evidence_faults(cell, repo):
    found = tokens(cell)
    if not any(verifiable(t) for t in found):
        return ["no path or commit"]
    return [f for f in (token_fault(t, repo) for t in found) if f]


def ruling_of(cell):
    m = RULING.match(cell.strip())
    return m.group(1).strip() if m else ""


# --- the reading -------------------------------------------------------------------------

def assess(path):
    head, rows = read(path)
    faults, notes = [], []
    open_ids = [r["id"] for r in rows if r["status"] == "open"]
    deferred_ids = [r["id"] for r in rows if r["status"] == "deferred"]
    unplanned = [r["id"] for r in rows if r["status"] == "open" and not r["plan"].strip()]
    for r in rows:
        if r["status"] not in STATUSES:
            faults.append(f"{r['id']} has no status of open, met, ruled-out or deferred: {r['status'] or 'empty'}")
        elif r["status"] == "met":
            for f in evidence_faults(r["evidence"], head["repo"]):
                faults.append(f"{r['id']} met without evidence on disk: {f}")
        elif r["status"] == "ruled-out" and not ruling_of(r["evidence"]):
            faults.append(f"{r['id']} ruled out without the operator's words")
        elif r["status"] == "deferred" and not ruling_of(r["evidence"]):
            faults.append(f"{r['id']} deferred without the operator's words")
    if head["spec"] != "none":
        try:
            with open(os.path.expanduser(head["spec"]), encoding="utf-8") as f:
                spec = f.read()
        except OSError:
            spec = None
            notes.append(f"the spec {head['spec']} cannot be read: its goals were not matched")
        if spec is not None:
            listed = spec_goals(spec)
            if listed is not None:
                if len(rows) != len(listed):
                    faults.append(f"{len(rows)} rows, the spec's Goals list {len(listed)}")
                left = list(listed)
                for r in rows:
                    text = collapse(r["goal"])
                    if text in left:
                        left.remove(text)
                    else:
                        faults.append(f"{r['id']} is not the spec's text")
            if head["aim"] and collapse(head["aim"]) not in collapse(spec):
                faults.append("the aim is not the spec's text")
    met = sum(1 for r in rows if r["status"] == "met")
    ruled = sum(1 for r in rows if r["status"] == "ruled-out")
    return {
        "ok": not open_ids and not deferred_ids and not faults,
        "open": open_ids, "deferred": deferred_ids, "unplanned": unplanned, "faults": faults, "notes": notes,
        "rows": len(rows), "met": met, "ruled_out": ruled,
        "aim": head["aim"], "spec": head["spec"],
        "table": "\n".join([HEADER, RULE] + ["| " + " | ".join(escape(r[k]) for k in ("id", "status", "goal", "plan", "evidence")) + " |" for r in rows]),
    }


def summary_line(a):
    line = (f"goals met={a['met']}/{a['rows']} ruled_out={a['ruled_out']} "
            f"open={','.join(a['open']) or 'none'} unplanned={','.join(a['unplanned']) or 'none'}")
    return f"{line} deferred={','.join(a['deferred'])}" if a["deferred"] else line


# --- the commands --------------------------------------------------------------------------

def options(argv, spec):
    """argv parsed against {name: 'one'|'many'|'flag'}; positional arguments are refused."""
    out = {k: ([] if v == "many" else (False if v == "flag" else None)) for k, v in spec.items()}
    i = 0
    while i < len(argv):
        name = argv[i][2:] if argv[i].startswith("--") else None
        if name not in spec:
            die(f"unknown argument {argv[i]}")
        if spec[name] == "flag":
            out[name] = True
            i += 1
            continue
        if i + 1 >= len(argv):
            die(f"--{name} needs a value")
        if spec[name] == "many":
            out[name].append(argv[i + 1])
        else:
            out[name] = argv[i + 1]
        i += 2
    return out


def repo_of(spec_path, given):
    if given:
        return os.path.abspath(os.path.expanduser(given))
    base = os.path.dirname(os.path.abspath(spec_path)) if spec_path else os.getcwd()
    try:
        done = subprocess.run(["git", "-C", base, "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=5)
        if done.returncode == 0 and done.stdout.strip():
            return done.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return base


def cmd_init(path, argv):
    o = options(argv, {"spec": "one", "aim": "one", "goal": "many", "repo": "one", "replace": "flag"})
    if not o["spec"]:
        die("init: --spec <path> or --spec none is required")
    spec_path = None if o["spec"] == "none" else os.path.abspath(os.path.expanduser(o["spec"]))
    aim = collapse(o["aim"] or "")
    if spec_path:
        try:
            with open(spec_path, encoding="utf-8") as f:
                spec = f.read()
        except OSError:
            die(f"init: cannot read the spec {spec_path}")
        listed = spec_goals(spec)
        if listed is None and not o["goal"]:
            die(f"init: {spec_path} has no numbered list under « ## Goals »: add one, or give each goal with --goal")
        if listed is not None and o["goal"]:
            die("init: the spec lists its goals; --goal is only for a spec with no Goals list")
        goals = listed if listed is not None else [collapse(g) for g in o["goal"]]
        if aim and aim not in collapse(spec):
            die("init: the aim is not the spec's text: copy it verbatim")
        aim = aim or spec_aim(spec)
    else:
        goals = [collapse(g) for g in o["goal"]]
    if any(not g for g in goals):
        die("init: a goal is empty")
    if os.path.exists(path):
        try:
            old, _ = read(path)
        except Fault:
            old = {"spec": "unreadable"}
        if not o["replace"]:
            die(f"init: {path} already holds the goals of spec {old['spec']}: give --replace to archive it and start over")
        stem = "none" if old["spec"] in ("none", "unreadable") else os.path.splitext(os.path.basename(old["spec"]))[0]
        archive = os.path.join(os.path.dirname(path), f"goals-{stem}.md")
        os.replace(path, archive)
        print(f"goals: the previous file is kept as {archive}")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    head = {"spec": spec_path or "none", "repo": repo_of(spec_path, o["repo"]), "aim": aim}
    rows = [{"id": f"G{i}", "status": "open", "goal": g, "plan": "", "evidence": ""} for i, g in enumerate(goals, 1)]
    write(path, head, rows)
    print(f"goals: {len(rows)} goal(s) written to {path}")


def cmd_status(path, _argv):
    a = assess_or_die(path)
    print(f"aim: {a['aim'] or 'none'}")
    print(f"spec: {a['spec']}")
    print(a["table"])
    for f in a["faults"]:
        print(f"fault: {f}")
    for n in a["notes"]:
        print(f"note: {n}")
    print(summary_line(a))


def cmd_line(path, _argv):
    print(summary_line(assess_or_die(path)))


def cmd_unplanned(path, _argv):
    for gid in assess_or_die(path)["unplanned"]:
        print(gid)


def assess_or_die(path):
    try:
        return assess(path)
    except Fault as err:
        die(str(err))


def edit(path, gid, change):
    try:
        head, rows = read(path)
    except Fault as err:
        die(str(err))
    row = find(rows, gid)
    change(head, row)
    write(path, head, rows)


def cmd_plan(path, argv):
    gid, o = argv[0] if argv else die("plan: a goal id is required"), options(argv[1:], {"phase": "one"})
    if not (o["phase"] or "").strip():
        die("plan: --phase <text> is required")
    edit(path, gid, lambda h, r: r.update(plan=collapse(o["phase"])))


def cmd_met(path, argv):
    gid, o = argv[0] if argv else die("met: a goal id is required"), options(argv[1:], {"evidence": "many"})
    found = [t for e in o["evidence"] for t in tokens(e)]
    if not found:
        die("met: --evidence <path|commit:<sha>> is required")

    def change(head, row):
        faults = evidence_faults("; ".join(found), head["repo"])
        if faults:
            die(f"met: {gid} not recorded: {'; '.join(faults)}")
        row.update(status="met", evidence="; ".join(found))
    edit(path, gid, change)


def ruling_words(given, command):
    """The operator's words out of --ruling, quotes dropped; dies when there are none."""
    words = (given or "").strip()
    m = RULING.match(words)
    if m:
        words = m.group(1)
    words = collapse(words.strip().strip("«»\"'").strip())
    if not words:
        die(f"{command}: --ruling needs the operator's own words, verbatim and not empty")
    return words


def cmd_rule_out(path, argv):
    gid, o = argv[0] if argv else die("rule-out: a goal id is required"), options(argv[1:], {"ruling": "one"})
    words = ruling_words(o["ruling"], "rule-out")
    edit(path, gid, lambda h, r: r.update(status="ruled-out", evidence=f"operator: « {words} »"))


def cmd_defer(path, argv):
    gid, o = argv[0] if argv else die("defer: a goal id is required"), options(argv[1:], {"ruling": "one"})
    words = ruling_words(o["ruling"], "defer")

    def change(head, row):
        if row["status"] != "open":
            die(f"defer: {gid} is {row['status']}, not open")
        row.update(status="deferred", evidence=f"operator: « {words} »")
    edit(path, gid, change)


def cmd_reopen(path, argv):
    gid = argv[0] if argv else die("reopen: a goal id is required")
    edit(path, gid, lambda h, r: r.update(status="open", evidence=""))


def cmd_check(path, argv):
    as_json = argv == ["--json"]
    if argv and not as_json:
        die(f"check: unknown argument {argv[0]}")
    try:
        a = assess(path)
    except Fault as err:
        if as_json:
            print(json.dumps({"ok": False, "error": str(err)}))
        else:
            print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(2)
    if as_json:
        print(json.dumps(a))
    else:
        if a["open"]:
            print(f"open: {', '.join(a['open'])}")
        if a["deferred"]:
            print(f"deferred: {', '.join(a['deferred'])}")
        for f in a["faults"]:
            print(f"fault: {f}")
        for n in a["notes"]:
            print(f"note: {n}")
        print(summary_line(a))
    sys.exit(0 if a["ok"] else 1)


COMMANDS = {
    "init": cmd_init, "status": cmd_status, "line": cmd_line, "unplanned": cmd_unplanned,
    "plan": cmd_plan, "met": cmd_met, "rule-out": cmd_rule_out, "defer": cmd_defer, "reopen": cmd_reopen, "check": cmd_check,
}


def main(argv):
    if len(argv) < 2 or argv[0] not in COMMANDS:
        die(f"usage: goals.py {{{'|'.join(COMMANDS)}}} <goals.md> [...] (see header)")
    path = argv[1]
    if argv[0] != "init" and not os.path.exists(path):
        if argv[0] == "check":
            cmd_check(path, argv[2:])
        die(f"no goals file at {path}: dispatch-record.sh goals <record> init --spec <path>|none")
    COMMANDS[argv[0]](path, argv[2:])


if __name__ == "__main__":
    main(sys.argv[1:])
