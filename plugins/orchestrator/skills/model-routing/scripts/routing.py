#!/usr/bin/env python3
"""routing.py - measure and pick the model/effort pair a dispatch runs on.

The routing skill chose a tier from a table written by judgment, and nothing measured what
a dispatch cost or whether a lighter pair would have closed it. Every subcommand here turns
one part of that judgment into a reading: what a session cost, and which pair a table, else the
tier map, names for a class. What replayed pull requests say each pair delivers is
calibration.py's, which this file hands its subcommands to.

Measured data lives in <state dir>/routing/ and names model identifiers; it never enters
the plugin. Only `export` writes into the plugin, in tier/effort form.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

STATE_DIR = os.environ.get("ORCHESTRATOR_STATE_DIR") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
    "claude-orchestrator",
)
ROUTING_DIR = os.path.join(STATE_DIR, "routing")
# Where the host keeps one directory per checkout and one transcript per session, as the
# launcher reads it.
PROJECTS_DIR = os.environ.get("ORCHESTRATOR_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")
MODELS_MAP = os.environ.get("ORCHESTRATOR_MODELS_MAP") or os.path.join(STATE_DIR, "models.json")
DEFAULTS_DIR = os.environ.get("ORCHESTRATOR_ROUTING_DEFAULTS") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "defaults")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
TIERS = ("deep", "standard", "light")
# The cost rule, as data the hooks module prices the deck with: the JSON value after the marker.
COST_RULE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))), "hooks", "usage.ts")
COST_RULE_MARKER = "export const COST_RULE: CostRule = "


def die(msg):
    print("ERROR: %s" % msg, file=sys.stderr)
    sys.exit(1)


def warn(msg):
    print("WARNING: %s" % msg, file=sys.stderr)


def read_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except ValueError:
        die("%s does not read as JSON" % path)


def write_json(path, data):
    """Through a temporary file in the same directory, so a reader never sees half a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def parse_pair(text):
    model, sep, effort = (text or "").partition("/")
    if not model or not sep or effort not in EFFORTS:
        die("not a pair: %r (expected <alias>/<effort>, effort one of %s)" % (text, ", ".join(EFFORTS)))
    return model, effort


# --- cost -------------------------------------------------------------------------

def session_transcripts(session):
    found = glob.glob(os.path.join(PROJECTS_DIR, "*", session + ".jsonl"))
    if not found:
        die("cost: no transcript for session %s under %s" % (session, PROJECTS_DIR))
    for main in list(found):
        found += sorted(glob.glob(os.path.join(main[:-len(".jsonl")], "subagents", "*.jsonl")))
    return found


def cost_rule():
    """COST_RULE of hooks/usage.ts, checked to name what the arithmetic below reads."""
    try:
        with open(COST_RULE_FILE) as fh:
            text = fh.read()
        rule = json.JSONDecoder().raw_decode(text, text.index(COST_RULE_MARKER) + len(COST_RULE_MARKER))[0]
        names = set(rule["tokens"])
        ok = (rule.get("version") == 1 and isinstance(rule["per"], (int, float)) and rule["per"] > 0
              and all(isinstance(p, list) and p and all(isinstance(k, str) for k in p) for p in rule["tokens"].values())
              and set(rule["counted"]) <= names and set(rule["prompt"]) <= names
              and all(isinstance(t["rate"], str) and set(t["plus"]) | set(t["minus"]) <= names for t in rule["terms"]))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        ok = False
    if not ok:
        die("cost: %s holds no cost rule" % COST_RULE_FILE)
    return rule


def count_at(usage, path):
    """The count at a path of the usage object: 0 where a step is missing or no number."""
    value = usage
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    finite = isinstance(value, (int, float)) and not isinstance(value, bool) and value == value
    return value if finite and abs(value) != float("inf") else 0


def counts(usage, rule):
    return {name: count_at(usage, path) for name, path in rule["tokens"].items()}


def message_usages(paths, rule):
    """One usage per message id: the host writes one line per content block, and every one
    of them repeats the whole message's usage. A message whose counted tokens are all zero is
    the host's own placeholder, not a model's work: it is neither priced nor named.
    """
    seen = {}
    anonymous = []
    for path in paths:
        with open(path) as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                msg = entry.get("message") if isinstance(entry, dict) else None
                if not isinstance(msg, dict) or entry.get("type") != "assistant":
                    continue
                usage, model = msg.get("usage"), msg.get("model")
                if not isinstance(usage, dict) or not isinstance(model, str) or not model:
                    continue
                n = counts(usage, rule)
                if not any(n[k] for k in rule["counted"]):
                    continue
                if isinstance(msg.get("id"), str) and msg["id"]:
                    seen[msg["id"]] = (model, n)
                else:
                    anonymous.append((model, n))
    return list(seen.values()) + anonymous


def is_price(price, rule):
    """Every base rate a number and, when tiered, a numeric threshold and numeric upper rates."""
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")
    rates = [t["rate"] for t in rule["terms"]]
    if not isinstance(price, dict) or not all(num(price.get(r)) for r in rates):
        return False
    above = price.get("above")
    return above is None or (isinstance(above, dict) and num(above.get("tokens"))
                             and all(r not in above or num(above[r]) for r in rates))


def message_cost(n, price, rule):
    """A tiered price switches to its upper rates when the message's prompt passes the
    threshold; a rate the upper tier leaves out is the base one. None for no valid price.
    """
    if not is_price(price, rule):
        return None
    rate = dict(price)
    above = price.get("above")
    if above and sum(n[k] for k in rule["prompt"]) > above["tokens"]:
        rate.update(above)
    cost = 0
    for t in rule["terms"]:
        cost += (sum(n[k] for k in t["plus"]) - sum(n[k] for k in t["minus"])) * rate[t["rate"]]
    return cost / rule["per"]


def measure(paths):
    rule = cost_rule()
    prices = read_json(os.path.join(ROUTING_DIR, "prices.json"), {})
    if not isinstance(prices, dict):
        prices = {}
    out = {"cost_usd": 0.0, "models": {}, "tokens_in": 0, "tokens_out": 0,
           "cache_read": 0, "cache_write": 0}
    usages = message_usages(paths, rule)
    if not usages:
        die("cost: no message carries usage in %s" % ", ".join(paths))
    for model, n in usages:
        out["tokens_in"] += n["input"]
        out["tokens_out"] += n["output"]
        out["cache_read"] += n["cache_read"]
        out["cache_write"] += n["cache_write"]
        cost = message_cost(n, prices.get(model), rule)
        if cost is None:
            out["models"][model] = None
            continue
        if out["models"].get(model, 0.0) is not None:
            out["models"][model] = out["models"].get(model, 0.0) + cost
    for model, cost in out["models"].items():
        if cost is None:
            print("routing: no price for %s in %s" % (model, os.path.join(ROUTING_DIR, "prices.json")),
                  file=sys.stderr)
            out["cost_usd"] = None
    if out["cost_usd"] is not None:
        out["cost_usd"] = sum(out["models"].values())
    return out


def carries_alias(ident, alias):
    """Whether a model identifier carries the alias as a dash segment (`b-model` in `b-model-1`)."""
    return bool(re.search(r"(^|-)%s(-|$)" % re.escape(alias), ident))


def resolve_alias(alias, models):
    """The identifier an alias resolved to: the one carrying the alias as a dash segment,
    else the costliest. None when nothing was reported.
    """
    if not alias or not models:
        return None
    named = [m for m in sorted(models) if carries_alias(m, alias)]
    return named[0] if named else max(models, key=lambda m: models[m] or 0)


def note_alias(alias, models):
    """Record which identifier an alias resolved to, when one of `models` carries it. A session
    that ran other models says nothing about the alias: the costliest of them is not its
    identifier, and recording it would fold the trials of two models under one pair. A stale
    table entry is read against this.
    """
    if not alias or not any(carries_alias(m, alias) for m in models or {}):
        return
    path = os.path.join(ROUTING_DIR, "aliases.json")
    data = read_json(path, {})
    data[alias] = resolve_alias(alias, models)
    write_json(path, data)


def cmd_cost(argv):
    p = argparse.ArgumentParser(prog="cost")
    p.add_argument("transcript", nargs="?")
    p.add_argument("--session")
    p.add_argument("--alias")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    if bool(a.transcript) == bool(a.session):
        die("cost: give a transcript path or --session <id>, exactly one of them")
    if a.transcript and not os.path.isfile(a.transcript):
        die("cost: no transcript at %s" % a.transcript)
    paths = session_transcripts(a.session) if a.session else [a.transcript]
    m = measure(paths)
    note_alias(a.alias, m["models"])
    if a.json:
        print(json.dumps(m, sort_keys=True))
        return
    cost = "unknown" if m["cost_usd"] is None else "%.6f" % m["cost_usd"]
    print("cost_usd=%s models=%s tokens_in=%d tokens_out=%d cache_read=%d cache_write=%d"
          % (cost, ",".join(sorted(m["models"])), m["tokens_in"], m["tokens_out"],
             m["cache_read"], m["cache_write"]))


# The size rule and the trials a rung needs, read by `pick` and by the calibration alike.
MIN_TRIALS = 6  # graded trials a pair needs in a class with no bench task, record rows only
SMALL_FILES = 3
SMALL_LINES = 50


def size_bucket(files, lines):
    """The bucket of a piece of work: `small` at most SMALL_FILES files and SMALL_LINES lines,
    `large` beyond. The one rule a measured task and a phase given to `pick` are both read by.
    """
    return "small" if files <= SMALL_FILES and lines <= SMALL_LINES else "large"


# --- classes, tables, pick --------------------------------------------------------

# The tier table the skill ships, as data: where `pick` lands when nothing is measured.
CLASS_TIERS = {
    "orchestrator": "deep", "successor": "deep", "decision-round": "deep",
    "contract-phase": "deep", "final-verification": "deep",
    "behaviour-phase": "standard", "conversion-phase": "standard", "corrective": "standard",
    "review-collector": "standard", "comments": "standard", "review-lens": "standard",
    "search": "light",
}
# Work nothing downstream re-checks: never explored online, held offline to a pair that never failed.
NEVER_EXPLORED = {"orchestrator", "successor", "decision-round", "contract-phase", "final-verification"}
EXPLORE_AFTER = 3
# A class's former name, still read wherever data written under it lives: the dispatch record's
# rows, the trials, the tables (a table holding both keys reads the current one), the command line.
FORMER_CLASSES = {"n-bis": "corrective"}


def class_name(name):
    """The class a name read in data or on the command line stands for; a value that is not a
    string is no class name and is returned unchanged, for its row to be passed over.
    """
    return FORMER_CLASSES.get(name, name) if isinstance(name, str) else name


def table_entries(table):
    """A table's entries, each keyed by its current class name."""
    entries = dict(table.get("entries", {}))
    for former, current in FORMER_CLASSES.items():
        if former in entries:
            entries.setdefault(current, entries[former])
            del entries[former]
    return entries


def git_top(repo):
    r = subprocess.run(["git", "-C", repo, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return os.path.realpath(r.stdout.strip() if r.returncode == 0 else repo)


def project_slug(repo):
    """The manifest whose repo is this path or its checkout, else the directory's name. The
    path is matched first: a project nested in another checkout is still its own project.
    """
    here, top = os.path.realpath(repo), git_top(repo)
    for want in (here, top):
        for path in sorted(glob.glob(os.path.join(ROUTING_DIR, "projects", "*", "manifest.json"))):
            m = read_json(path, {})
            if m.get("repo") and m.get("slug") and os.path.realpath(m["repo"]) == want:
                return m["slug"]
    return re.sub(r"[^A-Za-z0-9._-]", "-", os.path.basename(here))


def manifest_path(slug):
    return os.path.join(ROUTING_DIR, "projects", slug, "manifest.json")


LANG_MARKERS = (("composer.json", "php"), ("pyproject.toml", "python"), ("setup.py", "python"),
                ("go.mod", "go"), ("Cargo.toml", "rust"), ("Gemfile", "ruby"),
                ("pom.xml", "java"), ("build.gradle", "java"))
EXTENSIONS = {".sh": "shell", ".py": "python", ".php": "php", ".js": "javascript",
              ".ts": "typescript", ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java"}


def infer_profile(repo):
    top = os.path.realpath(repo)  # the root the caller names, never a checkout above it
    has = lambda p: os.path.exists(os.path.join(top, p))
    language = next((lang for marker, lang in LANG_MARKERS if has(marker)), "")
    if not language and has("package.json"):
        language = "typescript" if has("tsconfig.json") else "javascript"
    # A plugin's manifest names no language: its scripts do.
    if not language or has(".claude-plugin"):
        counts = {}
        for root, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "vendor")]
            for f in files:
                lang = EXTENSIONS.get(os.path.splitext(f)[1])
                if lang:
                    counts[lang] = counts.get(lang, 0) + 1
        language = max(sorted(counts), key=counts.get) if counts else (language or "unknown")
    if has("artisan"):
        kind = "laravel-app"
    elif has(".claude-plugin"):
        kind = "plugin"
    elif has("bin") or has("console") or has("cli.py") or has("__main__.py"):
        kind = "cli"
    elif has("Dockerfile") or has("public") or has("app"):
        kind = "app"
    else:
        kind = "library"
    return "%s/%s" % (language, kind)


def project_profile(repo):
    m = read_json(manifest_path(project_slug(repo)), {})
    return m.get("profile") or infer_profile(repo)


def table_path(scope, shipped=False):
    """scope: "project:<slug>", "profile:<language>/<kind>" or "global"."""
    kind, _, name = scope.partition(":")
    base = "global" if kind == "global" else "%s-%s" % (kind, name.replace("/", "-"))
    return os.path.join(DEFAULTS_DIR if shipped else os.path.join(ROUTING_DIR, "tables"), base + ".json")


def read_map():
    """{tier: (model, effort)} from the operator's map; unbound tiers are absent."""
    data = read_json(MODELS_MAP, {})
    out = {}
    for tier in TIERS:
        v = data.get(tier) if isinstance(data, dict) else None
        if isinstance(v, dict) and v.get("model"):
            out[tier] = (v["model"], v.get("effort") or "")
        elif isinstance(v, str) and v:
            m, _, e = v.partition("/")
            out[tier] = (m, e)
    return out


def tier_order():
    """The bound families, heaviest first, read from the map so no code names a family."""
    bound, seen = read_map(), []
    for tier in TIERS:
        m = bound.get(tier)
        if m and m[0] not in seen:
            seen.append(m[0])
    return seen


def failed_rung(rung, entry):
    """A rung measured and found wanting: covered, and not equivalent to the best pair. A rung
    that is not covered is not failed, only unmeasured - the pair an exploration tests. A rung
    of an older table, written before equivalence, is read by the floor it was selected with:
    a rung with no `equivalent`, or a null one, is such a rung.
    """
    if rung.get("equivalent") is not None:
        return bool(rung.get("covered")) and rung["equivalent"] is False
    return (rung.get("n") or 0) >= MIN_TRIALS and (rung.get("pass_rate") or 0) < entry.get("floor", 0)


def ladder_down(pair, entry=None):
    """One notch below a pair: the IMMEDIATE cheaper rung of the entry's ladder; without a
    ladder to read it from, effort down a level on the same family; at the lowest effort, the
    next lighter family at the same effort. A notch the ladder measured and found wanting is no
    notch: the measurement already answered what an exploration would ask. None when there is
    nothing below.
    """
    entry = entry or {}
    ladder = entry.get("ladder") or []
    pairs = [r.get("pair") for r in ladder]
    if pair in pairs and pairs.index(pair) > 0:
        rung = ladder[pairs.index(pair) - 1]
        return None if failed_rung(rung, entry) else rung["pair"]
    model, effort = parse_pair(pair)
    i = EFFORTS.index(effort)
    order = tier_order()
    if i > 0:
        notch = "%s/%s" % (model, EFFORTS[i - 1])
    elif model in order and order.index(model) + 1 < len(order):
        notch = "%s/%s" % (order[order.index(model) + 1], effort)
    else:
        return None
    if any(r.get("pair") == notch and failed_rung(r, entry) for r in ladder):
        return None
    return notch


def corrective_pair(pair):
    """The pair a phase's corrective round runs at: the same family one effort level up, the
    same pair at the top. The round is the retry - cheap first, escalate on failure. None for a
    pair with no effort to raise: the host's default, a bare model, an effort the list lacks.
    """
    model, _, effort = pair.partition("/")
    if effort not in EFFORTS:
        return None
    return "%s/%s" % (model, EFFORTS[min(EFFORTS.index(effort) + 1, len(EFFORTS) - 1)])


def resolve_shipped(pair):
    tier, _, effort = pair.partition("/")
    bound = read_map().get(tier)
    return "%s/%s" % (bound[0], effort) if bound else None


def resolve_ladder(entry):
    """A shipped entry with its tier-form rungs read through the map, so the ladder compares
    with the dispatched pair; a rung on an unbound tier is dropped.
    """
    ladder = []
    for r in entry.get("ladder") or []:
        pair = resolve_shipped(r["pair"]) if isinstance(r, dict) and isinstance(r.get("pair"), str) else None
        if pair:
            ladder.append(dict(r, pair=pair))
    return dict(entry, ladder=ladder)


def lookup(repo, cls, size=None):
    """(pair, source, entry, beyond) from the most specific table that has one. For a `large`
    phase an entry that was not measured on large work does not serve it (a table written
    before the stamp has no size and reads as unknown): the order goes on, and `beyond` is the
    source of the first entry skipped that way. A shipped entry whose tier the map does not
    bind is skipped as ever and is never a `beyond`.
    """
    slug = project_slug(repo)
    profile = project_profile(repo)
    beyond = None
    for scope, shipped in (("project:" + slug, False), ("profile:" + profile, False), ("global", False),
                           ("profile:" + profile, True), ("global", True)):
        entry = table_entries(read_json(table_path(scope, shipped), {})).get(cls)
        if not entry or not entry.get("pair"):
            continue
        source = "shipped:" + scope if shipped else scope
        if shipped:
            pair = resolve_shipped(entry["pair"])
            if not pair:
                continue
            entry = resolve_ladder(entry)
        else:
            pair = entry["pair"]
        if size == "large" and entry.get("size") != "large":
            beyond = beyond or source
            continue
        return pair, source, entry, beyond
    bound = read_map().get(CLASS_TIERS[cls])
    if not bound:
        return "host-default", "tier-table", None, beyond
    return (bound[0] + ("/" + bound[1] if bound[1] else "")), "tier-table", None, beyond


def is_stale(pair, entry):
    if not entry or not entry.get("models") or "/" not in pair:
        return False
    now = read_json(os.path.join(ROUTING_DIR, "aliases.json"), {}).get(pair.split("/")[0])
    return bool(now) and now not in entry["models"]


def read_rows(record):
    """The record's rows; a line that does not read is skipped with a warning, never fatal."""
    rows = []
    with open(record) as fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                row = None
            if isinstance(row, dict):
                if "class" in row:
                    row["class"] = class_name(row["class"])
                rows.append(row)
            else:
                warn("%s:%d does not read as a record row, skipped" % (record, n))
    return rows


def may_explore(record, cls, pair):
    """Three one-round closes at the class's pair, no escaped defect there, and no failed
    exploration of the class in this record: one that cost a corrective round or let a
    defect escape freezes the class for the build, as the summary's `frozen=` says.
    """
    if cls in NEVER_EXPLORED or not record or not os.path.isfile(record) or "/" not in pair:
        return False
    rows = [r for r in read_rows(record) if r.get("class") == cls]
    if any(r.get("explore") and r.get("state") == "closed"
           and ((r.get("rounds") or 0) > 1 or r.get("escaped")) for r in rows):
        return False
    model, effort = pair.split("/", 1)
    mine = [r for r in rows if r.get("state") == "closed"
            and r.get("model") == model and r.get("effort") == effort]
    if any(r.get("escaped") for r in mine):
        return False
    return sum(1 for r in mine if (r.get("rounds") or 0) <= 1) >= EXPLORE_AFTER


def cmd_profile(argv):
    if len(argv) != 1:
        die("profile: exactly one repository path is required")
    if not os.path.isdir(argv[0]):
        die("profile: no directory at %s" % argv[0])
    print(infer_profile(argv[0]))


def phase_size(files, lines):
    """The bucket of the phase `pick` was given, or None when it was given none. Both counts or
    neither: a bucket needs both, and a count is a whole number, 0 or more.
    """
    if files is None and lines is None:
        return None
    if files is None or lines is None:
        die("pick: --files and --lines go together")
    if not all(re.fullmatch(r"[0-9]+", c) for c in (files, lines)):
        die("pick: --files and --lines are counts, 0 or more")
    return size_bucket(int(files), int(lines))


def cmd_pick(argv):
    p = argparse.ArgumentParser(prog="pick")
    p.add_argument("--repo", required=True)
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--record")
    p.add_argument("--files")
    p.add_argument("--lines")
    a = p.parse_args(argv)
    a.cls = class_name(a.cls)
    if a.cls not in CLASS_TIERS:
        die("pick: unknown class: %s (expected one of %s)" % (a.cls, ", ".join(sorted(CLASS_TIERS))))
    size = phase_size(a.files, a.lines)
    pair, source, entry, beyond = lookup(a.repo, a.cls, size)
    line = "pair=%s source=%s%s" % (pair, source, " stale" if is_stale(pair, entry) else "")
    if size:
        line += " size=%s%s" % (size, " beyond=" + beyond if beyond else "")
    print(line)
    if may_explore(a.record, a.cls, pair):
        below = ladder_down(pair, entry)
        if below:
            print("explore=%s" % below)
    up = corrective_pair(pair)
    if up:
        print("corrective=%s" % up)


# The calibration engine's subcommands live in calibration.py, which reads this file's map,
# cost rule and tables: imported here only when one of them runs, under this module's name so
# both read one copy of its state.
CALIBRATION = ("calibrate", "harvest", "ready", "void", "trial", "bench", "generalize", "show", "export")
COMMANDS = {"cost": cmd_cost, "profile": cmd_profile, "pick": cmd_pick}


def main():
    names = sorted(COMMANDS) + sorted(CALIBRATION)
    if len(sys.argv) < 2 or sys.argv[1] not in names:
        die("usage: routing.py {%s} ..." % "|".join(sorted(names)))
    if sys.argv[1] in COMMANDS:
        COMMANDS[sys.argv[1]](sys.argv[2:])
        return
    sys.modules.setdefault("routing", sys.modules[__name__])
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import calibration
    calibration.COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
