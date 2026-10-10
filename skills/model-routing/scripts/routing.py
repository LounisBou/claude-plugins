#!/usr/bin/env python3
"""routing.py - measure, calibrate and pick the model/effort pair a dispatch runs on.

The routing skill chose a tier from a table written by judgment, and nothing measured what
a dispatch cost or whether a lighter pair would have closed it. Every subcommand here turns
one part of that judgment into a reading: what a session cost, which pair a table names for
a class, what replayed pull requests say each pair delivers.

Measured data lives in <state dir>/routing/ and names model identifiers; it never enters
the plugin. Only `export` writes into the plugin, in tier/effort form.
"""

import argparse
import datetime
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
HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "claude")
GH_CLI = os.environ.get("ORCHESTRATOR_GH", "gh")
DEFAULTS_DIR = os.environ.get("ORCHESTRATOR_ROUTING_DEFAULTS") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "defaults")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
TIERS = ("deep", "standard", "light")
TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


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


def message_usages(paths):
    """One usage per message id: the host writes one line per content block, and every one
    of them repeats the whole message's usage. A message whose four token counts are all
    zero is the host's own placeholder, not a model's work: it is neither priced nor named.
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
                if not isinstance(usage, dict) or not model or not any(
                        usage.get(k) for k in TOKEN_KEYS):
                    continue
                if msg.get("id"):
                    seen[msg["id"]] = (model, usage)
                else:
                    anonymous.append((model, usage))
    return list(seen.values()) + anonymous


def message_cost(usage, price):
    """A tiered price switches to its upper rates when the message's whole prompt - fresh
    input, cache reads and cache writes - passes the threshold.
    """
    inp = usage.get("input_tokens", 0) or 0
    out = usage.get("output_tokens", 0) or 0
    read = usage.get("cache_read_input_tokens", 0) or 0
    write = usage.get("cache_creation_input_tokens", 0) or 0
    split = usage.get("cache_creation") or {}
    hour = split.get("ephemeral_1h_input_tokens", 0) or 0
    five = write - hour
    rate = dict(price)
    above = price.get("above")
    if above and inp + read + write > above["tokens"]:
        rate.update(above)
    return (inp * rate["input"] + out * rate["output"] + read * rate["cache_read"]
            + five * rate["cache_write_5m"] + hour * rate["cache_write_1h"]) / 1e6


def measure(paths):
    prices = read_json(os.path.join(ROUTING_DIR, "prices.json"), {})
    out = {"cost_usd": 0.0, "models": {}, "tokens_in": 0, "tokens_out": 0,
           "cache_read": 0, "cache_write": 0}
    usages = message_usages(paths)
    if not usages:
        die("cost: no message carries usage in %s" % ", ".join(paths))
    for model, usage in usages:
        out["tokens_in"] += usage.get("input_tokens", 0) or 0
        out["tokens_out"] += usage.get("output_tokens", 0) or 0
        out["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
        out["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
        price = prices.get(model)
        if price is None:
            out["models"][model] = None
            continue
        if out["models"].get(model, 0.0) is not None:
            out["models"][model] = out["models"].get(model, 0.0) + message_cost(usage, price)
    for model, cost in out["models"].items():
        if cost is None:
            print("routing: no price for %s in %s" % (model, os.path.join(ROUTING_DIR, "prices.json")),
                  file=sys.stderr)
            out["cost_usd"] = None
    if out["cost_usd"] is not None:
        out["cost_usd"] = sum(out["models"].values())
    return out


def note_alias(alias, models):
    """The identifier an alias resolved to: the one carrying the alias as a dash segment,
    else the costliest. A stale table entry is read against this.
    """
    if not alias or not models:
        return
    seg = re.compile(r"(^|-)%s(-|$)" % re.escape(alias))
    named = [m for m in sorted(models) if seg.search(m)]
    pick = named[0] if named else max(models, key=lambda m: models[m] or 0)
    path = os.path.join(ROUTING_DIR, "aliases.json")
    data = read_json(path, {})
    data[alias] = pick
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


# --- classes, tables, pick --------------------------------------------------------

# The tier table the skill ships, as data: where `pick` lands when nothing is measured.
CLASS_TIERS = {
    "orchestrator": "deep", "successor": "deep", "decision-round": "deep",
    "contract-phase": "deep", "final-verification": "deep",
    "behaviour-phase": "standard", "conversion-phase": "standard", "n-bis": "standard",
    "review-collector": "standard", "comments": "standard", "review-lens": "standard",
    "search": "light",
}
# Work nothing downstream re-checks: never explored online, held to a floor of 1.0 offline.
NEVER_EXPLORED = {"orchestrator", "successor", "decision-round", "contract-phase", "final-verification"}
STRICT_CLASSES = {"contract-phase", "final-verification"}
EXPLORE_AFTER = 3


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
    """A rung measured and found wanting: enough trials, and a pass rate below the entry's floor.
    A rung with too few trials is not failed, only unmeasured - the pair an exploration tests.
    """
    return (rung.get("n") or 0) >= MIN_TRIALS and (rung.get("pass_rate") or 0) < entry.get("floor", 0)


def ladder_down(pair, entry=None):
    """One notch below a pair: the IMMEDIATE cheaper rung of the entry's ladder; without a
    ladder to read it from, effort down a level on the same family; at the lowest effort, the
    next lighter family at the same effort. A notch the ladder measured below the floor is no
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


def resolve_shipped(pair):
    tier, _, effort = pair.partition("/")
    bound = read_map().get(tier)
    return "%s/%s" % (bound[0], effort) if bound else None


def lookup(repo, cls):
    slug = project_slug(repo)
    profile = project_profile(repo)
    for scope, shipped in (("project:" + slug, False), ("profile:" + profile, False), ("global", False),
                           ("profile:" + profile, True), ("global", True)):
        entry = read_json(table_path(scope, shipped), {}).get("entries", {}).get(cls)
        if not entry or not entry.get("pair"):
            continue
        if shipped:
            pair = resolve_shipped(entry["pair"])
            if pair:
                return pair, "shipped:" + scope, entry
            continue
        return entry["pair"], scope, entry
    bound = read_map().get(CLASS_TIERS[cls])
    if not bound:
        return "host-default", "tier-table", None
    return (bound[0] + ("/" + bound[1] if bound[1] else "")), "tier-table", None


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


def cmd_pick(argv):
    p = argparse.ArgumentParser(prog="pick")
    p.add_argument("--repo", required=True)
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--record")
    a = p.parse_args(argv)
    if a.cls not in CLASS_TIERS:
        die("pick: unknown class: %s (expected one of %s)" % (a.cls, ", ".join(sorted(CLASS_TIERS))))
    pair, source, entry = lookup(a.repo, a.cls)
    print("pair=%s source=%s%s" % (pair, source, " stale" if is_stale(pair, entry) else ""))
    if may_explore(a.record, a.cls, pair):
        below = ladder_down(pair, entry)
        if below:
            print("explore=%s" % below)


# --- calibration --------------------------------------------------------------------

MIN_TRIALS = 6
STATUSES = ("pass", "fail", "error")


def floors():
    cfg = read_json(os.path.join(ROUTING_DIR, "config.json"), {}).get("floor", {})
    return float(cfg.get("default", 0.9)), float(cfg.get("strict", 1.0))


def is_pair(text):
    model, sep, effort = text.partition("/") if isinstance(text, str) else ("", "", "")
    return bool(model and sep and effort in EFFORTS)


def read_trials(path):
    """A trial line that is torn, or names no class, no pair, no status or no numeric cost, is
    skipped with a warning: a run interrupted mid-write must never cost the trials before it.
    """
    out = []
    if not os.path.isfile(path):
        return out
    with open(path) as fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                t = json.loads(line)
                ok = (isinstance(t, dict) and isinstance(t.get("class"), str) and is_pair(t.get("pair"))
                      and t.get("status") in STATUSES)
                # A trial with no cost is not a free one: it would rank its pair cheaper than it is.
                ok = ok and isinstance(t.get("cost_usd"), (int, float)) and not isinstance(t["cost_usd"], bool)
            except (ValueError, TypeError, AttributeError):
                ok = False
            if ok:
                out.append(t)
            else:
                warn("%s:%d does not read as a trial, skipped" % (path, n))
    return out


def record_trials(record):
    """A closed pair row graded by the record's own signals: one round and no escaped
    defect is a pass. Rows without a complete measured cost are left out.
    """
    if not os.path.isfile(record):
        die("calibrate: no record at %s" % record)
    out = []
    for r in read_rows(record):
        if r.get("state") != "closed" or not r.get("class") or not is_pair("%s/%s" % (r.get("model"), r.get("effort"))):
            continue
        if r.get("cost_incomplete") or not r.get("cost_usd"):
            continue
        ok = (r.get("rounds") or 0) <= 1 and not r.get("escaped")
        out.append({"class": r["class"], "pair": "%s/%s" % (r["model"], r["effort"]),
                    "cost_usd": r["cost_usd"], "models": {}, "status": "pass" if ok else "fail"})
    return out


def stats_of(trials):
    """Per pair: the graded trials (`n`, `passes`) and the cost of every trial, errors
    included - an error is paid for, it just says nothing about the pair's reliability.
    """
    stats = {}
    for t in trials:
        s = stats.setdefault(t["pair"], {"n": 0, "passes": 0, "costs": [], "models": set()})
        s["costs"].append(float(t.get("cost_usd") or 0))
        s["models"].update((t.get("models") or {}).keys())
        if t.get("status") in ("pass", "fail"):
            s["n"] += 1
            s["passes"] += t["status"] == "pass"
    return stats


def select_entry(cls, stats, floor):
    ladder = []
    for pair, s in stats.items():
        mean = sum(s["costs"]) / len(s["costs"]) if s["costs"] else 0.0
        rate = s["passes"] / s["n"] if s["n"] else 0.0
        ladder.append({"pair": pair, "n": s["n"], "pass_rate": round(rate, 4), "cost_usd": round(mean, 6),
                       "eligible": s["n"] >= MIN_TRIALS and rate >= floor, "models": sorted(s["models"])})
    ladder.sort(key=lambda r: (r["cost_usd"], r["pair"]))
    for i, r in enumerate(ladder):
        # A failure in production is paid by an escalation: the next pair up, or a retry.
        up = ladder[i + 1]["cost_usd"] if i + 1 < len(ladder) else r["cost_usd"]
        r["expected_usd"] = round(r["cost_usd"] + (1 - r["pass_rate"]) * up, 6)
    eligible = [r for r in ladder if r["eligible"]]
    if not eligible:
        return None
    best = min(eligible, key=lambda r: (r["expected_usd"], -r["pass_rate"]))
    return {"pair": best["pair"], "pass_rate": best["pass_rate"], "n": best["n"],
            "cost_usd": best["cost_usd"], "expected_usd": best["expected_usd"], "floor": floor,
            "models": best["models"],
            "ladder": [{k: v for k, v in r.items() if k != "models"} for r in ladder]}


def build_table(scope, trials):
    default, strict = floors()
    entries, lines = {}, []
    for cls in sorted({t["class"] for t in trials}):
        floor = strict if cls in STRICT_CLASSES else default
        entry = select_entry(cls, stats_of([t for t in trials if t["class"] == cls]), floor)
        if entry:
            entries[cls] = entry
            lines.append("class=%s pair=%s pass_rate=%s n=%d expected_usd=%s"
                         % (cls, entry["pair"], entry["pass_rate"], entry["n"],
                            round(entry["expected_usd"], 4)))
        else:
            lines.append("class=%s no eligible pair" % cls)
    return {"scope": scope, "generated": datetime.date.today().isoformat(), "entries": entries}, lines


def cmd_calibrate(argv):
    p = argparse.ArgumentParser(prog="calibrate")
    p.add_argument("slug")
    p.add_argument("--from-record", dest="records", action="append", default=[])
    a = p.parse_args(argv)
    trials = read_trials(os.path.join(ROUTING_DIR, "projects", a.slug, "trials.jsonl"))
    for rec in a.records:
        trials += record_trials(rec)
    if not trials:
        die("calibrate: no trial and no record row for %s" % a.slug)
    table, lines = build_table("project:" + a.slug, trials)
    write_json(table_path("project:" + a.slug), table)
    print("\n".join(lines))


COMMANDS = {"cost": cmd_cost, "profile": cmd_profile, "pick": cmd_pick, "calibrate": cmd_calibrate}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: routing.py {%s} ..." % "|".join(sorted(COMMANDS)))
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
