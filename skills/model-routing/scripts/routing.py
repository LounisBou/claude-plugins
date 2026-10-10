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
import concurrent.futures as cf
import datetime
import fnmatch
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

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
                return pair, "shipped:" + scope, resolve_ladder(entry)
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
    included - an error is paid for, it just says nothing about the pair's reliability. A
    trial whose cost could not be read holds the ceiling it was launched with, not what it
    cost: it stays out of the pair's costs.
    """
    stats = {}
    for t in trials:
        s = stats.setdefault(t["pair"], {"n": 0, "passes": 0, "costs": [], "models": set()})
        if not t.get("cost_incomplete"):
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
                       "eligible": (s["n"] >= MIN_TRIALS and rate >= floor and not s.get("held_back")
                     and bool(s["costs"])),
                       "models": sorted(s["models"])})
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


# --- bench: manifest ----------------------------------------------------------------

FENCE = re.compile(r"```.*?```", re.S)


def load_manifest(slug):
    m = read_json(manifest_path(slug), None)
    if m is None:
        die("no manifest for project %s (harvest one first)" % slug)
    return m


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        die("git %s failed in %s: %s" % (" ".join(args), repo, r.stderr.strip()))
    return r.stdout.strip()


def cmd_harvest(argv):
    p = argparse.ArgumentParser(prog="harvest")
    p.add_argument("repo")
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--pr", action="append", type=int, required=True)
    p.add_argument("--test-command")
    p.add_argument("--test-glob", action="append", default=[])
    p.add_argument("--budget-usd", type=float)
    a = p.parse_args(argv)
    if a.cls not in CLASS_TIERS:
        die("harvest: unknown class: %s" % a.cls)
    repo = git_top(a.repo)
    slug = project_slug(repo)
    m = read_json(manifest_path(slug), None) or {
        "slug": slug, "repo": repo, "profile": infer_profile(repo), "test_command": "",
        "test_globs": [], "budget_usd": 2.0, "tasks": []}
    if a.test_command:
        m["test_command"] = a.test_command
    if a.test_glob:
        m["test_globs"] = a.test_glob
    if a.budget_usd:
        m["budget_usd"] = a.budget_usd
    for pr in a.pr:
        try:
            r = subprocess.run([GH_CLI, "pr", "view", str(pr), "--json", "title,body,mergeCommit"],
                               cwd=repo, capture_output=True, text=True)
            info = json.loads(r.stdout) if r.returncode == 0 else None
        except (OSError, ValueError):
            r, info = None, None
        if not isinstance(info, dict):
            die("harvest: the forge did not answer for pull request %d: %s"
                % (pr, r.stderr.strip() if r else "no readable answer"))
        merged = (info.get("mergeCommit") or {}).get("oid")
        if not merged:
            die("harvest: pull request %d is not merged" % pr)
        base = git(repo, "rev-parse", merged + "^1")
        tid = "pr-%d" % pr
        brief = "briefs/%s.md" % tid
        body = FENCE.sub("", info.get("body") or "").strip()
        path = os.path.join(ROUTING_DIR, "projects", slug, brief)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("# %s\n\n%s\n\nWork in the current directory. Run the project's tests "
                     "before you finish.\n" % (info.get("title", ""), body))
        m["tasks"] = [t for t in m["tasks"] if t["id"] != tid] + [{
            "id": tid, "pr": pr, "class": a.cls, "base": base, "merged": merged,
            "brief": brief, "status": "draft"}]
        print("harvested %s (draft)" % tid)
    write_json(manifest_path(slug), m)


def cmd_ready(argv):
    if len(argv) < 2:
        die("ready: a project and at least one task id are required")
    m = load_manifest(argv[0])
    ids = {t["id"] for t in m["tasks"]}
    for tid in argv[1:]:
        if tid not in ids:
            die("ready: no task %s in %s" % (tid, argv[0]))
    for t in m["tasks"]:
        if t["id"] in argv[1:]:
            t["status"] = "ready"
    write_json(manifest_path(argv[0]), m)
    print("ready: %s" % " ".join(argv[1:]))


# --- bench: one trial -----------------------------------------------------------------

RUBRIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "references", "judge-rubric.md")
TRIAL_TIMEOUT = int(os.environ.get("ORCHESTRATOR_TRIAL_TIMEOUT", "1800"))
JUDGE_CEILING = 2.0


def isolate(repo, base, root):
    """The tree at base and NO history: an agent that can read the merged commit is
    grading itself against the answer.
    """
    d = tempfile.mkdtemp(prefix="trial-", dir=root)
    try:
        archive = subprocess.run(["git", "-C", repo, "archive", base], capture_output=True, check=True)
        subprocess.run(["tar", "-x", "-C", d], input=archive.stdout, check=True)
        for args in (["init", "-q"], ["add", "-A"],
                     ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qm", "base"]):
            subprocess.run(["git", "-C", d] + args, check=True, capture_output=True)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return d


def mode_for(alias):
    return read_json(os.path.join(ROUTING_DIR, "config.json"), {}).get("modes", {}).get(alias, "auto")


def judge_pair(prog):
    """The judge runs at the deep tier's pair; with no effort bound, at `high`."""
    deep = read_map().get("deep")
    if not deep:
        die("%s: the deep tier is unbound: the judge has no model" % prog)
    return "%s/%s" % (deep[0], deep[1] or "high")


def run_group(cmd, timeout, cwd=None, text_in=None):
    """Run `cmd` in a session of its own and, on a timeout, kill the whole group: the
    direct child alone would leave whatever it started running, and paying.
    """
    proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE if text_in is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            start_new_session=True)
    try:
        out, err = proc.communicate(text_in, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        raise
    return proc.returncode, out, err


def number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def host(pair, prompt, cwd, budget, mode):
    """One headless run. A timeout, a host that cannot start or an answer that does not
    read is not ok; the cost is the host's own per-model figure. A cost that cannot be read
    is never zero: the trial is charged the ceiling it was launched with and marked
    `incomplete`, or the cap would undercount what was spent.
    """
    model, effort = parse_pair(pair)
    cmd = [HOST_CLI, "-p", "--model", model, "--effort", effort, "--permission-mode", mode,
           "--output-format", "json", "--no-session-persistence", "--max-budget-usd", "%.2f" % budget]
    started = time.time()
    failed = {"ok": False, "models": {}, "cost": budget, "incomplete": True, "text": "", "tokens": None}
    try:
        _, stdout, _ = run_group(cmd, TRIAL_TIMEOUT, cwd, prompt)
        res = json.loads(stdout.strip().splitlines()[-1])
        if not isinstance(res, dict):
            raise ValueError
    except (subprocess.TimeoutExpired, OSError, ValueError, IndexError):
        return dict(failed, duration=round(time.time() - started, 1))
    usage_by_model = {k: v for k, v in (res.get("modelUsage") or {}).items() if isinstance(v, dict)}
    models = {k: float(v["costUSD"]) if number(v.get("costUSD")) else 0.0 for k, v in usage_by_model.items()}
    total = res.get("total_cost_usd")
    if usage_by_model and all(number(v.get("costUSD")) for v in usage_by_model.values()):
        cost, incomplete = sum(models.values()), False
    elif number(total):
        cost, incomplete = float(total), False
    else:
        cost, incomplete = budget, True
    usage = res.get("usage") if isinstance(res.get("usage"), dict) else {}
    tokens = {k: usage.get(k, 0) or 0 for k in TOKEN_KEYS} if usage else None
    ok = not res.get("is_error") and res.get("subtype") == "success"
    return {"ok": ok, "models": models, "cost": cost, "incomplete": incomplete,
            "text": res.get("result") or "", "tokens": tokens, "duration": round(time.time() - started, 1)}


def overlay_hidden_tests(repo, base, merged, d, globs):
    """Copy the merged diff's test files over the agent's tree. The agent owns that tree: a
    link it planted must never carry a write, or a delete, outside it.
    """
    root = os.path.realpath(d)
    for line in git(repo, "diff", "--name-status", base, merged).splitlines():
        status, path = line.split("\t", 1)
        path = path.split("\t")[-1]
        if not any(fnmatch.fnmatch(path, g) for g in globs):
            continue
        target = os.path.join(d, path)
        parent = os.path.realpath(os.path.dirname(target))
        if os.path.commonpath([root, parent]) != root:
            warn("bench: overlay skipped %s, it resolves outside the trial" % path)
            continue
        if status.startswith("D"):
            if os.path.lexists(target):
                os.unlink(target)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        blob = subprocess.run(["git", "-C", repo, "show", "%s:%s" % (merged, path)], capture_output=True, check=True)
        if os.path.islink(target):
            os.unlink(target)
        with open(target, "wb") as fh:
            fh.write(blob.stdout)


def judge(brief, agent_diff, ref_diff, tests_out, d):
    """The verdict with the scores and reasons the rubric's JSON gives, and the judge's cost
    (the ceiling it ran under when its cost could not be read).
    """
    pair = judge_pair("bench")
    with open(RUBRIC) as fh:
        rubric = fh.read()
    prompt = "%s\n\n## Brief\n%s\n\n## Agent diff\n%s\n\n## Reference diff\n%s\n\n## Test output\n%s\n" % (
        rubric, brief, agent_diff, ref_diff, tests_out[-4000:])
    out = host(pair, prompt, d, JUDGE_CEILING, mode_for(pair.split("/")[0]))
    try:
        answer = json.loads(out["text"])
        verdict = answer["verdict"]
        if verdict not in ("pass", "fail"):
            raise ValueError
        return {"verdict": verdict, "scores": answer.get("scores"), "reasons": answer.get("reasons"),
                "cost": out["cost"]}
    except (ValueError, KeyError, TypeError):
        return {"verdict": None, "scores": None, "reasons": None, "cost": out["cost"]}


def run_trial(m, task, pair, rep, root, keep=False):
    """One trial, recorded whatever happens: an exception becomes an `error` trial keeping
    the cost measured before it, so a worker that raises never loses what was paid.
    """
    repo = m["repo"]
    ceiling = float(m.get("budget_usd") or 2.0)
    d = None
    trial = {"task": task["id"], "class": task["class"], "pair": pair, "rep": rep,
             "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "quota_before": quota_reading(), "judge": None, "judge_cost_usd": 0,
             "judge_scores": None, "judge_reasons": None, "models": {}, "cost_usd": 0.0}
    try:
        with open(os.path.join(ROUTING_DIR, "projects", m["slug"], task["brief"])) as fh:
            brief = fh.read()
        d = isolate(repo, task["base"], root)
        base_hash = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True,
                                   check=True).stdout.strip()
        # Until the host has answered, what it cost is unknown: an exception here leaves the ceiling.
        trial.update(cost_usd=ceiling, cost_incomplete=True)
        agent = host(pair, brief, d, ceiling, mode_for(pair.split("/")[0]))
        trial.update(models=agent["models"], cost_usd=round(agent["cost"], 6), tokens=agent["tokens"],
                     duration_s=agent["duration"])
        if not agent["incomplete"]:
            del trial["cost_incomplete"]
        if not agent["ok"]:
            trial.update(mech="error", status="error")
            return trial
        subprocess.run(["git", "-C", d, "add", "-A"], check=True)
        # Against the base it started from: an agent that commits leaves HEAD at its own work.
        agent_diff = subprocess.run(["git", "-C", d, "diff", "--cached", base_hash], capture_output=True,
                                    text=True).stdout
        overlay_hidden_tests(repo, task["base"], task["merged"], d, m["test_globs"])
        try:
            t_code, t_out, t_err = run_group(["bash", "-c", m["test_command"]], TRIAL_TIMEOUT, d)
        except subprocess.TimeoutExpired:
            # Tests that never finish say nothing about the change: an error, not a fail.
            trial.update(mech="error", status="error")
            return trial
        trial["mech"] = "pass" if t_code == 0 else "fail"
        if trial["mech"] == "fail":
            trial["status"] = "fail"
            return trial
        # Past this point the host ran for the judge: a failure of the judge's own cost is its ceiling.
        trial["judge_cost_usd"] = JUDGE_CEILING
        j = judge(brief, agent_diff, git(repo, "diff", task["base"], task["merged"]), t_out + t_err, d)
        trial.update(judge=j["verdict"], judge_cost_usd=round(j["cost"], 6), judge_scores=j["scores"],
                     judge_reasons=j["reasons"], status="error" if j["verdict"] is None else j["verdict"])
        return trial
    except Exception as exc:
        warn("bench: trial %s %s rep %d failed: %s" % (task["id"], pair, rep, exc))
        trial.update(mech="error", status="error")
        return trial
    finally:
        trial["quota_after"] = quota_reading()
        if d:
            if keep:
                trial["dir"] = d
            else:
                shutil.rmtree(d, ignore_errors=True)


def quota_reading():
    """The subscription gauge, as a control only: recorded, never acted on. Null unless a
    source file is named and readable.
    """
    path = os.environ.get("ORCHESTRATOR_QUOTA_FILE")
    return read_json(path, None) if path else None


def append_trial(slug, trial):
    path = os.path.join(ROUTING_DIR, "projects", slug, "trials.jsonl")
    # A run killed mid-write leaves a torn last line: the next trial starts on a line of its own.
    torn = False
    if os.path.isfile(path) and os.path.getsize(path):
        with open(path, "rb") as fh:
            fh.seek(-1, os.SEEK_END)
            torn = fh.read(1) != b"\n"
    with open(path, "a") as fh:
        fh.write(("\n" if torn else "") + json.dumps(trial, sort_keys=True) + "\n")


def runnable(m, tid):
    if not m.get("test_command") or not m.get("test_globs"):
        die("bench: project %s has no test_command or test_globs in its manifest" % m["slug"])
    task = next((t for t in m["tasks"] if t["id"] == tid), None)
    if task is None:
        die("trial: no task %s in %s" % (tid, m["slug"]))
    if task["status"] != "ready":
        die("trial: task %s is still a draft" % tid)
    return task


def cmd_trial(argv):
    p = argparse.ArgumentParser(prog="trial")
    p.add_argument("slug")
    p.add_argument("task")
    p.add_argument("pair")
    p.add_argument("--rep", type=int, default=1)
    p.add_argument("--keep", action="store_true")
    a = p.parse_args(argv)
    parse_pair(a.pair)
    m = load_manifest(a.slug)
    task = runnable(m, a.task)
    judge_pair("trial")
    trial = run_trial(m, task, a.pair, a.rep, tempfile.gettempdir(), a.keep)
    append_trial(a.slug, trial)
    note_alias(a.pair.split("/")[0], trial["models"])
    print("trial %s %s rep %d: %s cost_usd=%s" % (a.task, a.pair, a.rep, trial["status"], trial["cost_usd"]))


# --- bench: the grid ------------------------------------------------------------------

def grid_of(a):
    if a.grid:
        pairs = a.grid.split(",")
        for pr in pairs:
            parse_pair(pr)
        return pairs
    families = a.families.split(",") if a.families else tier_order()
    if not families:
        die("bench: no family bound in the tier map; name them with --families")
    return ["%s/%s" % (f, e) for f in families for e in EFFORTS]


def cmd_bench(argv):
    p = argparse.ArgumentParser(prog="bench")
    p.add_argument("slug")
    p.add_argument("--max-usd", type=float, required=True)
    p.add_argument("--grid")
    p.add_argument("--families")
    p.add_argument("--reps", type=int, default=2)
    p.add_argument("--concurrency", type=int, default=2)
    p.add_argument("--class", dest="cls")
    a = p.parse_args(argv)
    m = load_manifest(a.slug)
    if not m.get("test_command") or not m.get("test_globs"):
        die("bench: project %s has no test_command or test_globs in its manifest" % m["slug"])
    pairs = grid_of(a)
    judge_pair("bench")
    done = {(t["task"], t["pair"], t.get("rep", 1)): t
            for t in read_trials(os.path.join(ROUTING_DIR, "projects", a.slug, "trials.jsonl"))}
    state = {"spent": 0.0, "trials": 0, "errors": {}, "dropped": set()}
    # Errors drop a pair for this run only: one host outage must not strike a pair for good.

    def run(jobs):
        """Jobs in order; a job already in trials.jsonl is reused, never re-paid. The cap
        stops new trials only: those in flight finish and are recorded.
        """
        results = {}
        queue = []
        for job in jobs:
            if job in done:
                results[job] = done[job]
            else:
                queue.append(job)
        workers = max(1, a.concurrency)
        with cf.ThreadPoolExecutor(max_workers=workers) as pool:
            running = {}
            while queue or running:
                while queue and len(running) < workers and state["spent"] < a.max_usd:
                    task_id, pair, rep = queue.pop(0)
                    if pair in state["dropped"]:
                        continue
                    task = runnable(m, task_id)
                    running[pool.submit(run_trial, m, task, pair, rep, tempfile.gettempdir())] = (task_id, pair, rep)
                if not running:
                    break
                fut = next(cf.as_completed(running))
                job = running.pop(fut)
                t = fut.result()
                append_trial(a.slug, t)
                note_alias(job[1].split("/")[0], t["models"])
                done[job] = results[job] = t
                state["spent"] += t["cost_usd"] + t.get("judge_cost_usd", 0)
                state["trials"] += 1
                print("trial %s %s rep %d: %s cost_usd=%s" % (job[0], job[1], job[2], t["status"], t["cost_usd"]),
                      flush=True)
                # A judge that answered nothing says nothing about the pair: the agent ran and passed.
                judge_silent = t.get("mech") == "pass" and t.get("judge") is None
                if t["status"] == "error" and not judge_silent:
                    state["errors"][job[1]] = state["errors"].get(job[1], 0) + 1
                    if state["errors"][job[1]] >= 3 and job[1] not in state["dropped"]:
                        state["dropped"].add(job[1])
                        warn("bench: dropping %s after 3 errors" % job[1])
        # Unmeasured: every job with no trial, whether the cap or a dropped pair left it.
        return results, len(set(jobs) - set(results))

    unmeasured = 0
    by_class = {}
    for t in m["tasks"]:
        if a.cls and t["class"] != a.cls:
            continue
        if t["status"] == "ready":
            by_class.setdefault(t["class"], []).append(t["id"])
        else:
            warn("bench: task %s is still a draft, skipped" % t["id"])
    for cls, tasks in sorted(by_class.items()):
        screen = [(tid, pr, 1) for pr in pairs for tid in tasks[:2]]
        res, left = run(screen)
        unmeasured += left
        passing = [pr for pr in pairs
                   if all(res.get((tid, pr, 1), {}).get("status") == "pass" for tid in tasks[:2])]
        if not passing:
            continue
        cost = lambda pr: sum(res[(tid, pr, 1)]["cost_usd"] for tid in tasks[:2])
        cheapest = min(cost(pr) for pr in passing)
        confirmed = [pr for pr in passing if cost(pr) <= 1.5 * cheapest]
        jobs = [(tid, pr, rep) for pr in confirmed for tid in tasks for rep in range(1, a.reps + 1)]
        _, left = run(jobs)
        unmeasured += left
    print("bench: spent=%.2f trials=%d unmeasured=%d" % (state["spent"], state["trials"], unmeasured))


# --- generalisation and export --------------------------------------------------------

def all_projects():
    out = {}
    for path in sorted(glob.glob(os.path.join(ROUTING_DIR, "projects", "*", "manifest.json"))):
        m = read_json(path, {})
        trials = read_trials(os.path.join(os.path.dirname(path), "trials.jsonl"))
        if trials and m.get("slug"):
            out[m["slug"]] = (m.get("profile") or "unknown/unknown", trials)
    return out


def fold(scope, projects):
    """Pool the projects' trials; a pair qualifies only when it also meets the floor in
    every project where it was measured, so one easy project cannot carry a profile. A pair
    held back that way keeps its pooled figures on the ladder: it was measured, not unmeasured.
    """
    default, strict = floors()
    entries = {}
    classes = sorted({t["class"] for _, trials in projects.values() for t in trials})
    for cls in classes:
        floor = strict if cls in STRICT_CLASSES else default
        pooled = stats_of([t for _, ts in projects.values() for t in ts if t["class"] == cls])
        for _, ts in projects.values():
            for pair, s in stats_of([t for t in ts if t["class"] == cls]).items():
                # One weak trial is no verdict on a project: it needs a sample before it holds a pair back.
                if s["n"] >= MIN_TRIALS and s["passes"] / s["n"] < floor:
                    pooled[pair]["held_back"] = True
        entry = select_entry(cls, pooled, floor)
        if entry:
            entries[cls] = entry
    return {"scope": scope, "generated": datetime.date.today().isoformat(), "entries": entries}


def cmd_generalize(argv):
    if argv:
        die("generalize: takes no argument")
    projects = all_projects()
    if not projects:
        die("generalize: no project has trials")
    profiles = {}
    for slug, (profile, _) in projects.items():
        profiles.setdefault(profile, []).append(slug)
    for profile, slugs in sorted(profiles.items()):
        # An unknown language is no profile: pooling such projects would serve one table to
        # repositories that share nothing. They count toward the global table only.
        if len(slugs) < 2 or profile.startswith("unknown/"):
            continue
        table = fold("profile:" + profile, {s: projects[s] for s in slugs})
        write_json(table_path("profile:" + profile), table)
        print("profile=%s projects=%d classes=%d" % (profile, len(slugs), len(table["entries"])))
    table = fold("global", projects)
    write_json(table_path("global"), table)
    print("global projects=%d classes=%d" % (len(projects), len(table["entries"])))


def cmd_export(argv):
    p = argparse.ArgumentParser(prog="export")
    p.add_argument("--to", default=DEFAULTS_DIR)
    a = p.parse_args(argv)
    tier_of = {}
    for tier, (model, _) in read_map().items():
        tier_of.setdefault(model, tier)

    def tiered(pair):
        model, effort = parse_pair(pair)
        return "%s/%s" % (tier_of[model], effort) if model in tier_of else None

    for path in sorted(glob.glob(os.path.join(ROUTING_DIR, "tables", "profile-*.json"))
                       + glob.glob(os.path.join(ROUTING_DIR, "tables", "global.json"))):
        table = read_json(path, {})
        entries = {}
        for cls, e in sorted(table.get("entries", {}).items()):
            pair = tiered(e["pair"])
            if not pair:
                warn("export: %s is bound to no tier, %s skipped" % (e["pair"].split("/")[0], cls))
                continue
            # The ladder keeps its order and its measured reliability; a rung on an unbound
            # family has no tier to be written in, and costs and identifiers never ship.
            ladder = [{"pair": tiered(r["pair"]), "n": r.get("n"), "pass_rate": r.get("pass_rate"),
                       "eligible": r.get("eligible")}
                      for r in e.get("ladder") or [] if is_pair(r.get("pair")) and tiered(r["pair"])]
            entries[cls] = {"pair": pair, "pass_rate": e["pass_rate"], "n": e["n"], "floor": e["floor"],
                            "ladder": ladder}
        out = os.path.join(a.to, os.path.basename(path))
        if not entries:
            warn("export: %s has no class in tier form, not written" % os.path.basename(path))
            continue
        write_json(out, {"scope": table.get("scope"), "generated": table.get("generated"), "entries": entries})
        print("exported %s (%d classes)" % (out, len(entries)))


def cmd_show(argv):
    projects = os.path.join(ROUTING_DIR, "projects")
    slugs = argv or (sorted(os.listdir(projects)) if os.path.isdir(projects) else [])
    if not slugs:
        die("show: no project under %s" % projects)
    for slug in slugs:
        m = load_manifest(slug)
        tables = [read_json(table_path(s), {}).get("entries", {})
                  for s in ("project:" + slug, "profile:" + (m.get("profile") or ""), "global")]
        print("project=%s profile=%s" % (slug, m.get("profile")))
        for cls in sorted(set().union(*tables)):
            cells = [t[cls]["pair"] if cls in t else "-" for t in tables]
            stale = any(cls in t and is_stale(t[cls]["pair"], t[cls]) for t in tables)
            print("class=%s project=%s profile=%s global=%s%s" % (cls, cells[0], cells[1], cells[2],
                                                                   " stale" if stale else ""))


COMMANDS = {"cost": cmd_cost, "profile": cmd_profile, "pick": cmd_pick, "calibrate": cmd_calibrate,
            "harvest": cmd_harvest, "ready": cmd_ready, "trial": cmd_trial,
            "bench": cmd_bench, "generalize": cmd_generalize, "show": cmd_show,
            "export": cmd_export}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: routing.py {%s} ..." % "|".join(sorted(COMMANDS)))
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
