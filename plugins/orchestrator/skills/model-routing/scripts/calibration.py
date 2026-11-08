#!/usr/bin/env python3
"""calibration.py - the calibration engine routing.py's calibration subcommands run.

What replayed pull requests say each pair delivers: the bench of merged pull requests, the
trials and their judge, the tables a class is picked from, their generalization and export.
routing.py keeps the tier-to-alias map, the cost rule and `pick`; it hands every other
subcommand here (`routing.py <subcommand>` is the one entry point).
"""

import argparse
import concurrent.futures as cf
import datetime
import fnmatch
import glob
import json
import os
import random
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time

# routing.py beside this file, whether it runs this module or a reader loads it by its path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from routing import (  # noqa: E402
    CLASS_TIERS, DEFAULTS_DIR, EFFORTS, MIN_TRIALS,
    ROUTING_DIR, carries_alias, cost_rule, count_at, die,
    git_top, infer_profile, is_stale, manifest_path, note_alias, parse_pair,
    project_slug, read_json, read_map, read_rows, resolve_alias, size_bucket,
    table_path, tier_order, warn, write_json,
)


HOST_CLI = os.environ.get("ORCHESTRATOR_HOST_CLI", "claude")
GH_CLI = os.environ.get("ORCHESTRATOR_GH", "gh")
# Work nothing downstream re-checks, held offline to a pair that never failed.
STRICT_CLASSES = {"contract-phase", "final-verification"}


# --- calibration --------------------------------------------------------------------

MIN_TASKS = 3  # tasks a class needs before any pair of it is covered
DRAWS = 4000  # posterior draws per pair
RESAMPLES = 1000  # bootstrap resamples of a pair's costs
SIZES = ("unknown", "small", "large")  # smallest first
SELECTION = {"delta": 0.10, "bar": 0.8}
STATUSES = ("pass", "fail", "error")


def selection():
    """`delta` and `bar` from config.json's "selection", else the defaults. A value that is not
    a number (a boolean is not one), is not finite or lies outside [0, 1] is refused: a mistyped
    threshold would otherwise select on nonsense without a word.
    """
    cfg = read_json(os.path.join(ROUTING_DIR, "config.json"), {}).get("selection") or {}
    out = []
    for key in ("delta", "bar"):
        v = cfg.get(key, SELECTION[key])
        # NaN fails every comparison and infinity lies outside the range: the range check alone
        # refuses a value that is not finite.
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1:
            die("selection: %s must be a number from 0 to 1, got %s" % (key, json.dumps(v)))
        out.append(float(v))
    return tuple(out)


def main_model(models):
    """The identifier a trial spent most on; None when it reported none."""
    if not models:
        return None
    return max(sorted(models), key=lambda m: models[m] or 0)


def is_identifier(model):
    """Whether a pair's model names a release (`b-model-1`: a dash and a last segment that is a
    number or a date) rather than a family alias (`b-model`).
    """
    return bool(re.search(r"-\d+$", model))


def on_model(pair, models):
    """Whether a trial ran on its pair's model. A pair that names a full identifier is on-model
    only when the main model is that identifier, a bracketed suffix on the reported one
    (`[1m]`) ignored: an identifier that merely starts or ends with it is another model. A pair
    that names an alias is on-model when the main model carries it as a dash segment. A trial
    that reports no model (a record row, an old trial) is not checked.
    """
    main = main_model(models)
    if main is None:
        return True
    model = pair.split("/")[0]
    if is_identifier(model):
        return re.sub(r"\[[^\]]*\]$", "", main) == model
    return carries_alias(main, model)


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


def counted(m, trials):
    """The trials a table may count, and the number left out per task. A trial of a task the
    manifest holds as anything but ready (void, or still a draft) measures no pair: nothing
    could pass that task. A trial naming no task (a record row) or a task the manifest does not
    know is kept: the manifest says nothing against it.
    """
    status = {t.get("id"): t.get("status") for t in m.get("tasks") or []}
    kept, left = [], {}
    for t in trials:
        tid = t.get("task")
        if tid and tid in status and status[tid] != "ready":
            left[tid] = left.get(tid, 0) + 1
        else:
            kept.append(t)
    return kept, left


def note_excluded(slug, left):
    """What `counted` left out of a project, said once per command and project."""
    if left:
        warn("%s: excluded %d trial(s) of task(s) not ready: %s"
             % (slug, sum(left.values()), " ".join(sorted(left))))


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


def read_aliases():
    """aliases.json as a mapping; empty when the file is absent or holds anything else."""
    data = read_json(os.path.join(ROUTING_DIR, "aliases.json"), {})
    return data if isinstance(data, dict) else {}


def canonical_pair(pair, aliases):
    """The pair one model's trials are counted under: a pair naming the identifier an alias
    resolved to is that alias's (`b-model-1/low` is `b/low` once aliases.json maps `b` to
    `b-model-1`), so one model is one pair. With several aliases on the identifier, the first in
    name order. A pair no alias resolves to stays as it is: an older release of the family is
    another model, and an alias that maps to itself yields to the others.
    """
    family, sep, effort = pair.partition("/")
    names = sorted(a for a, ident in aliases.items() if ident == family and a != family)
    return "%s/%s" % (names[0], effort) if sep and names else pair


def stats_of(trials, aliases):
    """Per pair: the graded trials (`n`, `passes`, and `per_task`, each task's [passes, graded],
    a trial with no task filed under "record") and the cost of every trial, errors included -
    an error is paid for, it just says nothing about the pair's reliability. A trial whose cost
    could not be read holds the ceiling it was launched with, not what it cost: it stays out of
    the pair's costs. A trial that ran on another model than its pair's (an alias resolved to
    an older release, a fallback) measures that model: it is only counted in `off_model`. A
    trial counts under its canonical pair, the name its model has in `aliases`; whether it ran
    on its model is still read from the pair it was recorded under.
    """
    stats = {}
    for t in trials:
        s = stats.setdefault(canonical_pair(t["pair"], aliases),
                             {"n": 0, "passes": 0, "costs": [], "models": set(),
                              "per_task": {}, "off_model": 0})
        if not on_model(t["pair"], t.get("models") or {}):
            s["off_model"] += 1
            continue
        if not t.get("cost_incomplete"):
            s["costs"].append(float(t.get("cost_usd") or 0))
        s["models"].update((t.get("models") or {}).keys())
        if t.get("status") in ("pass", "fail"):
            ok = t["status"] == "pass"
            s["n"] += 1
            s["passes"] += ok
            cell = s["per_task"].setdefault(t.get("task") or "record", [0, 0])
            cell[0] += ok
            cell[1] += 1
    return stats


def median_ci(costs, rng):
    """The median cost, and the 5th and 95th percentiles of the median over RESAMPLES
    bootstrap resamples of the costs.
    """
    if not costs:
        return None, None, None
    meds = sorted(statistics.median(rng.choices(costs, k=len(costs))) for _ in range(RESAMPLES))
    return statistics.median(costs), meds[round(0.05 * (RESAMPLES - 1))], meds[round(0.95 * (RESAMPLES - 1))]


def task_sizes(m):
    """Each task's size from its merged diff, the test files left out: the hidden tests are not
    the agent's work. `small` at most SMALL_FILES files and SMALL_LINES lines added and
    deleted, `large` beyond, `unknown` with a warning when the diff cannot be read. A binary
    file counts as a file of no line. Git's output is read as bytes: a path that is not UTF-8
    is still a path. Renames are detected (`-M`) whatever the user's configuration says, so a
    rename is one file.
    """
    repo, globs, out = m.get("repo") or "", m.get("test_globs") or [], {}
    for t in m.get("tasks") or []:
        tid = t.get("id")
        if not tid:
            continue
        r = None
        if os.path.isdir(repo):
            r = subprocess.run(["git", "-C", repo, "diff", "-M", "--numstat", "-z", t.get("base") or "",
                                t.get("merged") or ""], capture_output=True)
        if r is None or r.returncode != 0:
            warn("routing: the size of task %s cannot be read: %s"
                 % (tid, r.stderr.decode("utf-8", errors="replace").strip() if r
                    else "no repository at %s" % (repo or "''")))
            out[tid] = "unknown"
            continue
        files = lines = 0
        parts = r.stdout.decode("utf-8", errors="replace").split("\0")
        while parts:
            record = parts.pop(0)
            if not record:
                continue
            added, deleted, path = record.split("\t", 2)
            if not path:  # a rename: the old path, then the new one
                path = parts[1] if len(parts) > 1 else ""
                del parts[:2]
            if any(fnmatch.fnmatch(path, g) for g in globs):
                continue
            files += 1
            lines += sum(int(x) for x in (added, deleted) if x != "-")
        out[tid] = size_bucket(files, lines)
    return out


def class_tasks(stats):
    return sorted({k for s in stats.values() for k in s["per_task"] if k != "record"})


def compare(cls, stats, delta):
    """Every pair's rung, cheapest first; the best covered pair (None when no pair is covered);
    and the median of the best pair's posterior.

    A pair is covered when it was graded on every task of the class, and the class has at
    least MIN_TASKS of them; in a class with no bench task (record rows only) when it has
    MIN_TRIALS graded trials. A stat carrying its own `covered`, as a fold sets it, keeps it.
    Its pass rate is the mean of its per-task rates. Each covered pair's success probability is
    Beta(1 + passes, 1 + fails): DRAWS draws, then the bootstrap of its costs, both from a
    generator of the pair's own seeded by the class and the pair, so its draws depend on its
    own trials only: a pair added without being covered, or a trial of another class, moves no
    figure of the others. A covered pair's `p_equiv` is the share of paired draws where its draw
    is at least the best's minus `delta` (None on a pair that is not covered); it is equivalent
    when that share reaches a half.
    """
    tasks = class_tasks(stats)
    pairs = sorted(stats)
    draws, rungs = {}, {}
    for p in pairs:
        s = stats[p]
        cells = s["per_task"]
        if "covered" in s:
            covered = s["covered"]
        elif tasks:
            covered = len(tasks) >= MIN_TASKS and all(t in cells for t in tasks)
        else:
            covered = s["n"] >= MIN_TRIALS
        rng = random.Random("%s|%s" % (cls, p))
        if covered and s["n"]:
            draws[p] = [rng.betavariate(1 + s["passes"], 1 + s["n"] - s["passes"]) for _ in range(DRAWS)]
        med, lo, hi = median_ci(s["costs"], rng)
        rate = sum(a / b for a, b in cells.values()) / len(cells) if cells else 0.0
        rungs[p] = {"pair": p, "n": s["n"], "tasks": sum(1 for k in cells if k != "record"),
                    "per_task": {k: list(v) for k, v in sorted(cells.items())},
                    "pass_rate": round(rate, 4), "p_best": None, "p_equiv": None,
                    "cost_usd": round(sum(s["costs"]) / len(s["costs"]), 6) if s["costs"] else 0.0,
                    "median_usd": None if med is None else round(med, 6),
                    "median_ci": None if lo is None else [round(lo, 6), round(hi, 6)],
                    "off_model": s["off_model"], "covered": bool(covered and s["n"]),
                    "equivalent": False, "eligible": False}
    ladder = sorted(rungs.values(), key=lambda r: (r["cost_usd"], r["pair"]))
    for i, r in enumerate(ladder):
        # A failure in production is paid by an escalation: the next pair up, or a retry.
        up = ladder[i + 1]["cost_usd"] if i + 1 < len(ladder) else r["cost_usd"]
        r["expected_usd"] = round(r["cost_usd"] + (1 - r["pass_rate"]) * up, 6)
    covered = [p for p in pairs if rungs[p]["covered"]]
    if not covered:
        return ladder, None, None
    # The best: the highest pass rate, ties to the more passes, then to the cheaper pair.
    best = min(covered, key=lambda p: (-rungs[p]["pass_rate"], -stats[p]["passes"], rungs[p]["cost_usd"], p))
    wins = dict.fromkeys(covered, 0.0)
    for i in range(DRAWS):
        top = max(draws[p][i] for p in covered)
        winners = [p for p in covered if draws[p][i] == top]
        for p in winners:
            wins[p] += 1.0 / len(winners)
    for p in covered:
        rungs[p]["p_best"] = round(wins[p] / DRAWS, 4)
        near = sum(1 for x, b in zip(draws[p], draws[best]) if x >= b - delta)
        rungs[p]["p_equiv"] = round(near / DRAWS, 4)
        rungs[p]["equivalent"] = near / DRAWS >= 0.5
    return ladder, best, statistics.median(draws[best])


def select_entry(cls, stats, strict, sizes):
    """The class's entry: the cheapest pair, by expected cost, among the covered pairs
    equivalent to the best one; a strict class also needs every graded trial passed. None, with
    the reason, when no pair is covered, when the best pair's posterior median is below `bar`,
    or when no pair is equivalent. A pair a fold held back stays on the ladder, never chosen.
    """
    delta, bar = selection()
    ladder, best, best_median = compare(cls, stats, delta)
    if best is None:
        return None, "no covered pair"
    for r in ladder:
        s = stats[r["pair"]]
        r["eligible"] = (r["equivalent"] and bool(s["costs"]) and not s.get("held_back")
                         and (not strict or s["passes"] == s["n"]))
    if best_median < bar:
        return None, "best %s weak" % best
    eligible = [r for r in ladder if r["eligible"]]
    if not eligible:
        return None, "no equivalent pair"
    chosen = min(eligible, key=lambda r: (r["expected_usd"], -r["pass_rate"], r["pair"]))
    buckets = [sizes.get(t, "unknown") for t in class_tasks(stats)]
    return {"pair": chosen["pair"], "pass_rate": chosen["pass_rate"], "n": chosen["n"],
            "tasks": chosen["tasks"], "p_best": chosen["p_best"], "cost_usd": chosen["cost_usd"],
            "median_usd": chosen["median_usd"], "expected_usd": chosen["expected_usd"], "best": best,
            "delta": delta, "bar": bar, "strict": strict,
            "size": max(buckets, key=SIZES.index, default="unknown"),
            "sizes": {b: buckets.count(b) for b in SIZES},
            "models": sorted(stats[chosen["pair"]]["models"]), "ladder": ladder}, ""


def entry_line(cls, entry, note):
    if not entry:
        return "class=%s no eligible pair (%s)" % (cls, note)
    return ("class=%s pair=%s pass_rate=%s n=%d expected_usd=%s p_best=%s size=%s"
            % (cls, entry["pair"], entry["pass_rate"], entry["n"], round(entry["expected_usd"], 4),
               entry["p_best"], entry["size"]))


def build_table(scope, trials, sizes, aliases):
    """The same trials give the same file: every random figure is seeded by its class and pair."""
    entries, lines = {}, []
    for cls in sorted({t["class"] for t in trials}):
        entry, note = select_entry(cls, stats_of([t for t in trials if t["class"] == cls], aliases),
                                   cls in STRICT_CLASSES, sizes)
        if entry:
            entries[cls] = entry
        lines.append(entry_line(cls, entry, note))
    return {"scope": scope, "generated": datetime.date.today().isoformat(), "entries": entries}, lines


def cmd_calibrate(argv):
    p = argparse.ArgumentParser(prog="calibrate")
    p.add_argument("slug")
    p.add_argument("--from-record", dest="records", action="append", default=[])
    a = p.parse_args(argv)
    m = read_json(manifest_path(a.slug), {}) or {}
    trials, left = counted(m, read_trials(os.path.join(ROUTING_DIR, "projects", a.slug, "trials.jsonl")))
    note_excluded(a.slug, left)
    for rec in a.records:
        trials += record_trials(rec)
    if not trials:
        if not left:
            die("calibrate: no trial and no record row for %s" % a.slug)
        # Nothing is left to count: the table written while those trials counted would go on
        # serving the entry their exclusion removes, so it goes too.
        try:
            os.unlink(table_path("project:" + a.slug))
            removed = "; its table removed"
        except FileNotFoundError:
            removed = ""
        die("calibrate: no counted trial for %s (%d excluded)%s" % (a.slug, sum(left.values()), removed))
    sizes = task_sizes(m)
    table, lines = build_table("project:" + a.slug, trials, sizes, read_aliases())
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
    # One pull request that cannot be replayed is skipped and named: it must never cost the
    # tasks harvested before it, which are written whatever happens to the rest.
    skipped = []
    for pr in a.pr:
        try:
            r = subprocess.run([GH_CLI, "pr", "view", str(pr), "--json", "title,body,mergeCommit"],
                               cwd=repo, capture_output=True, text=True)
            info = json.loads(r.stdout) if r.returncode == 0 else None
        except (OSError, ValueError):
            r, info = None, None
        if not isinstance(info, dict):
            warn("harvest: the forge did not answer for pull request %d, skipped: %s"
                 % (pr, (r.stderr.strip() if r else "") or "no readable answer"))
            skipped.append(pr)
            continue
        merged = (info.get("mergeCommit") or {}).get("oid")
        if not merged:
            warn("harvest: pull request %d is not merged, skipped" % pr)
            skipped.append(pr)
            continue
        r = subprocess.run(["git", "-C", repo, "rev-parse", "--verify", "-q", merged + "^1"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            warn("harvest: the merge commit %s of pull request %d is not in %s (fetch it), skipped"
                 % (merged, pr, repo))
            skipped.append(pr)
            continue
        base = r.stdout.strip()
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
    if len(skipped) < len(a.pr):
        write_json(manifest_path(slug), m)
    if skipped:
        die("harvest: %d pull request(s) skipped: %s" % (len(skipped), " ".join(str(n) for n in skipped)))


def cmd_ready(argv):
    """Prove each task passable, in the order given: the merged commit's own tests run on the
    merged tree, and a task they fail is void. The manifest is written after each task, so a
    run killed midway keeps the tasks proved before it.
    """
    if len(argv) < 2:
        die("ready: a project and at least one task id are required")
    m = load_manifest(argv[0])
    need_tests(m)
    by_id = {t["id"]: t for t in m["tasks"]}
    ids = list(dict.fromkeys(argv[1:]))
    for tid in ids:
        if tid not in by_id:
            die("ready: no task %s in %s" % (tid, argv[0]))
    voided = []
    for tid in ids:
        t = by_id[tid]
        try:
            c = t["control"] = control(m, t, tempfile.gettempdir())
        except subprocess.CalledProcessError as exc:
            die("ready: the merged commit of task %s cannot be read: %s"
                % (tid, (exc.stderr or b"").decode("utf-8", errors="replace").strip() or exc))
        if c["exit"] == 0:
            t["status"] = "ready"
            t.pop("void", None)
            print("ready: %s (control passed in %ss)" % (tid, c["duration_s"]))
        else:
            t["status"] = "void"
            t["void"] = ("control: the merged commit's own tests time out" if c["exit"] is None
                         else "control: the merged commit's own tests fail (exit %d)" % c["exit"])
            print("void: %s %s" % (tid, t["void"]))
            for line in c["tests_failed"][:5]:
                print(line, file=sys.stderr)
            voided.append(tid)
        write_json(manifest_path(argv[0]), m)
    if voided:
        die("ready: voided %s" % " ".join(voided))


def cmd_void(argv):
    """Set tasks aside with a reason, no control run: a task whose merged commit passes but whose
    tests assert what the brief never states. A voided task returns only through `ready`, which
    proves it again.
    """
    p = argparse.ArgumentParser(prog="void")
    p.add_argument("slug")
    p.add_argument("tasks", nargs="+")
    p.add_argument("--reason", required=True)
    a = p.parse_args(argv)
    reason = a.reason.strip()
    if not reason:
        die("void: --reason must not be empty")
    m = load_manifest(a.slug)
    by_id = {t["id"]: t for t in m["tasks"]}
    ids = list(dict.fromkeys(a.tasks))
    for tid in ids:
        if tid not in by_id:
            die("void: no task %s in %s" % (tid, a.slug))
    for tid in ids:
        by_id[tid].update(status="void", void=reason)
    write_json(manifest_path(a.slug), m)
    for tid in ids:
        print("void: %s %s" % (tid, reason))


# --- bench: one trial -----------------------------------------------------------------

RUBRIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "references", "judge-rubric.md")
TRIAL_TIMEOUT = int(os.environ.get("ORCHESTRATOR_TRIAL_TIMEOUT", "1800"))
JUDGE_CEILING = 2.0
RECORDED_CHARS = 2000  # what a trial keeps of a failed test run or of an unreadable judge answer
FAIL_LINES = 40  # how many failing test lines a failed trial keeps, each cut at FAIL_LINE_CHARS
FAIL_LINE_CHARS = 300
FAIL_WORD = re.compile(r"\b(?:FAIL|FAILED|ERROR)\b")


def isolate(repo, base, root):
    """The tree at base and NO history: an agent that can read the merged commit is
    grading itself against the answer.
    """
    d = tempfile.mkdtemp(prefix="trial-", dir=root)
    try:
        archive = subprocess.run(["git", "-C", repo, "archive", base], capture_output=True, check=True)
        subprocess.run(["tar", "-x", "-C", d], input=archive.stdout, check=True)
        # Every archived file was tracked at base: no ignore rule, the user's or the repository's,
        # may leave one out of the base commit.
        for args in (["init", "-q"], ["-c", "core.excludesFile=", "add", "-A", "--force"],
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
           "--output-format", "json", "--no-session-persistence", "--setting-sources", "project",
           "--max-budget-usd", "%.2f" % budget]
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
    rule = cost_rule()
    tokens = {rule["tokens"][k][0]: count_at(usage, rule["tokens"][k]) for k in rule["counted"]} if usage else None
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


def control(m, task, root):
    """The merged commit's own tests, run on the merged tree and on nothing else - never the
    base, never an agent's diff. A task whose reference solution fails its own tests can be
    passed by no pair: it says nothing about any of them. `exit` is None when the tests time
    out; a run that did not pass keeps the failing lines and the tail of the output, as a
    failed trial does. A merged commit that cannot be archived raises: that is no verdict on
    the task.
    """
    at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    d = isolate(m["repo"], task["merged"], root)
    try:
        started = time.time()
        try:
            code, out, err = run_group(["bash", "-c", m["test_command"]], TRIAL_TIMEOUT, d)
        except subprocess.TimeoutExpired:
            code, out, err = None, "", ""
        took = round(time.time() - started, 1)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    res = {"at": at, "exit": code, "duration_s": took}
    if code != 0:
        tests = out + err
        failed = [line[:FAIL_LINE_CHARS] for line in tests.splitlines() if FAIL_WORD.search(line)]
        res.update(tests_failed=failed[:FAIL_LINES], tests_tail=tests[-RECORDED_CHARS:])
    return res


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
    # The rubric asks for one object, but a fence or a line of prose around it is still that object.
    text = out["text"]
    try:
        answer = json.loads(text[text.index("{"):text.rindex("}") + 1])
        verdict = answer["verdict"]
        if verdict not in ("pass", "fail"):
            raise ValueError
        return {"verdict": verdict, "scores": answer.get("scores"), "reasons": answer.get("reasons"),
                "cost": out["cost"]}
    except (ValueError, KeyError, TypeError):
        return {"verdict": None, "scores": None, "reasons": None, "cost": out["cost"],
                "raw": text[:RECORDED_CHARS], "ok": out["ok"]}


def trial_ceiling(m):
    """The most one agent run of the manifest may spend: the host's --max-budget-usd."""
    return float(m.get("budget_usd") or 2.0)


def trial_worst(m):
    """The most one trial may cost: its agent's ceiling and its judge's."""
    return trial_ceiling(m) + JUDGE_CEILING


def run_trial(m, task, pair, rep, root, keep=False):
    """One trial, recorded whatever happens: an exception becomes an `error` trial keeping
    the cost measured before it, so a worker that raises never loses what was paid.
    """
    repo = m["repo"]
    ceiling = trial_ceiling(m)
    d = None
    trial = {"task": task["id"], "class": task["class"], "pair": pair, "rep": rep,
             "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "quota_before": quota_reading(), "judge": None, "judge_cost_usd": 0,
             "judge_scores": None, "judge_reasons": None, "models": {}, "model": None, "cost_usd": 0.0}
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
                     duration_s=agent["duration"], model=resolve_alias(pair.split("/")[0], agent["models"]))
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
            tests = t_out + t_err
            failed = [line[:FAIL_LINE_CHARS] for line in tests.splitlines() if FAIL_WORD.search(line)]
            trial.update(status="fail", tests_tail=tests[-RECORDED_CHARS:], tests_failed=failed[:FAIL_LINES])
            return trial
        # Past this point the host ran for the judge: a failure of the judge's own cost is its ceiling.
        trial["judge_cost_usd"] = JUDGE_CEILING
        j = judge(brief, agent_diff, git(repo, "diff", task["base"], task["merged"]), t_out + t_err, d)
        trial.update(judge=j["verdict"], judge_cost_usd=round(j["cost"], 6), judge_scores=j["scores"],
                     judge_reasons=j["reasons"], status="error" if j["verdict"] is None else j["verdict"])
        if j["verdict"] is None:
            trial.update(judge_raw=j["raw"], judge_ok=j["ok"])
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


def need_tests(m):
    """A manifest that names no test command or no test globs can grade no trial and prove no task."""
    if not m.get("test_command") or not m.get("test_globs"):
        die("bench: project %s has no test_command or test_globs in its manifest" % m["slug"])


def runnable(m, tid):
    need_tests(m)
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
    warn_release("trial", a.pair.split("/")[0], trial.get("model"), set())
    print("trial %s %s rep %d: %s cost_usd=%s" % (a.task, a.pair, a.rep, trial["status"], trial["cost_usd"]))


def release_of(alias, ident):
    """The release an identifier names within the alias's family: its numeric dash segments
    after the alias, a date-like one (eight digits or more) only breaking a tie between equal
    versions. None when the identifier carries no release of that family.
    """
    base = re.sub(r"\[[^\]]*\]$", "", ident or "")
    m = re.search(r"(^|-)%s(-|$)" % re.escape(alias), base)
    if not m:
        return None
    nums = [p for p in base[m.end():].split("-") if p.isdigit()]
    if not nums:
        return None
    return (tuple(int(p) for p in nums if len(p) < 8), tuple(int(p) for p in nums if len(p) >= 8))


def known_releases(alias):
    """Every identifier of the family the host has reported - in any project's trials, and in
    the alias record `cost` and every trial keep - and every one the map names, with where it
    was seen. No family or release is written in the code: each is read from what was observed.
    """
    seen = {}
    for path in glob.glob(os.path.join(ROUTING_DIR, "projects", "*", "trials.jsonl")):
        with open(path) as fh:
            for line in fh:
                try:
                    t = json.loads(line)
                except ValueError:
                    continue
                if isinstance(t, dict) and isinstance(t.get("models"), dict):
                    for ident in t["models"]:
                        seen.setdefault(ident, "reported by the host")
    recorded = read_json(os.path.join(ROUTING_DIR, "aliases.json"), {}).get(alias)
    if isinstance(recorded, str):
        seen.setdefault(recorded, "reported by the host")
    for model, _ in read_map().values():
        seen[model] = "named by the map"
    return {i: src for i, src in seen.items() if release_of(alias, i)}


def warn_release(prog, alias, resolved, warned):
    """The spec runs each family on its latest release, and the host's alias can lag behind
    it: warn, once per family and run, when the alias resolved to an older release than one the
    host reported or the map names. The trial still counts; the operator decides.
    """
    have = release_of(alias, resolved)
    if alias in warned or not have:
        return
    known = known_releases(alias)
    newest = max(known, key=lambda i: (release_of(alias, i), i), default=None)
    if newest and release_of(alias, newest) > have:
        warned.add(alias)
        warn("%s: %s resolved to %s, an older release than %s (%s): the trials do not measure "
             "the family's latest release" % (prog, alias, resolved, newest, known[newest]))


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


def stage_split(tasks):
    """A class's tasks, in manifest order, cut into the bench's two stages: stage A is the
    first half rounded up, stage B the rest. A class of one task is all stage A.
    """
    half = (len(tasks) + 1) // 2
    return list(tasks[:half]), list(tasks[half:])


def prune(pairs, results, stage_a):
    """(survivors, pruned) among `pairs` once stage A has run. `results` maps (task, pair) to
    the trial, its `status` and `cost_usd`. A pair is pruned when it passed no stage-A task,
    or when another pair of `pairs` costs no more on average (errors are paid for; a cost
    that could not be read is no figure) and passed every task it passed, and beats it on
    one of the two: cheaper, or one more task passed. A pair the caller left out of `pairs`,
    a dropped one, is in neither list and dominates nobody. `pruned` comes cheapest first,
    then by name: the order the bench re-admits them in.
    """
    passed, cost = {}, {}
    for p in pairs:
        trials = [results[(t, p)] for t in stage_a if (t, p) in results]
        passed[p] = {t for t in stage_a if results.get((t, p), {}).get("status") == "pass"}
        costs = [r["cost_usd"] for r in trials if not r.get("cost_incomplete")]
        cost[p] = statistics.fmean(costs) if costs else None

    def beats(y, x):
        return (cost[y] is not None and cost[x] is not None and cost[y] <= cost[x]
                and passed[y] >= passed[x] and (cost[y] < cost[x] or passed[y] > passed[x]))

    survivors = [p for p in pairs if passed[p] and not any(beats(y, p) for y in pairs if y != p)]
    pruned = sorted((p for p in pairs if p not in survivors),
                    key=lambda p: (float("inf") if cost[p] is None else cost[p], p))
    return survivors, pruned


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
    need_tests(m)
    aliases = read_aliases()
    # One model is one pair: the grid is read through the aliases once, so a trial recorded under
    # the identifier an alias resolves to is the alias's, and a model named twice runs once.
    pairs = list(dict.fromkeys(canonical_pair(pr, aliases) for pr in grid_of(a)))
    judge_pair("bench")
    done = {(t["task"], canonical_pair(t["pair"], aliases), t.get("rep", 1)): t
            for t in read_trials(os.path.join(ROUTING_DIR, "projects", a.slug, "trials.jsonl"))}
    state = {"spent": 0.0, "reserved": 0.0, "trials": 0, "errors": {}, "dropped": set(),
             "warned": set(), "unmeasured": 0, "pruned": 0}
    worst = trial_worst(m)

    def fits():
        """Whether one more trial, at the most it may cost, stays within the cap with what is
        spent and what the trials in flight may still spend: the cap holds during the run.
        """
        return state["spent"] + state["reserved"] + worst <= a.max_usd + 1e-9

    delta = selection()[0]  # read before anything is spent: a mistyped threshold stops the run here
    # Errors drop a pair for this run only: one host outage must not strike a pair for good.

    def run(jobs):
        """Jobs in order; a job already in trials.jsonl is reused, never re-paid. A trial
        starts only when its worst cost fits under the cap beside the worst cost of those in
        flight, so the trials in flight can never carry the run past it.
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
                while queue and len(running) < workers and fits():
                    task_id, pair, rep = queue.pop(0)
                    if pair in state["dropped"]:
                        continue
                    task = runnable(m, task_id)
                    state["reserved"] += worst
                    running[pool.submit(run_trial, m, task, pair, rep, tempfile.gettempdir())] = (task_id, pair, rep)
                if not running:
                    break
                fut = next(cf.as_completed(running))
                job = running.pop(fut)
                state["reserved"] -= worst
                t = fut.result()
                append_trial(a.slug, t)
                note_alias(job[1].split("/")[0], t["models"])
                warn_release("bench", job[1].split("/")[0], t.get("model"), state["warned"])
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

    def go(jobs):
        """Run a stage's jobs: (results, whether the cap left some of them unmeasured, which
        ends the class: a stage the cap interrupted is the last one planned).
        """
        results, left = run(jobs)
        state["unmeasured"] += left
        return results, bool(left) and not fits()

    def bench_class(cls, tasks):
        """The class's stages; the number of pairs pruned after stage A and never re-admitted.
        The trials of those pairs stay out of the selection until they re-enter, so a restart,
        which finds the trials of an earlier re-admission, reads the class as the first run did.
        """
        stage_a, stage_b = stage_split(tasks)
        res, stopped = go([(tid, pr, 1) for pr in pairs for tid in stage_a])
        if stopped:
            return 0
        survivors, pruned = prune([pr for pr in pairs if pr not in state["dropped"]],
                                  {(tid, pr): t for (tid, pr, _), t in res.items()}, stage_a)
        out = set(pruned)

        def class_stats():
            return stats_of([t for (tid, pr, _), t in done.items()
                             if tid in tasks and t["class"] == cls and pr not in out], aliases)

        def selected():
            return select_entry(cls, class_stats(), cls in STRICT_CLASSES, {})

        def repeat(only=None):
            """Reps 2..--reps on every task for the best pair and for each covered pair of the
            grid that is equivalent to it in between three and seven tenths of the draws:
            the pairs a repetition can move. True when the cap ended the stage.
            """
            if a.reps < 2:
                return False
            ladder, best, _ = compare(cls, class_stats(), delta)
            want = [r["pair"] for r in ladder
                    if r["covered"] and r["pair"] in pairs and r["pair"] not in state["dropped"]
                    and (r["pair"] == best or 0.3 <= r["p_equiv"] <= 0.7) and (only is None or r["pair"] in only)]
            return go([(tid, pr, rep) for pr in want for tid in tasks for rep in range(2, a.reps + 1)])[1]

        if go([(tid, pr, 1) for pr in survivors for tid in stage_b])[1] or repeat():
            return len(out)
        entry, note = selected()
        # Cheapest first, until one gives an entry; a class with no covered pair has nothing a
        # pruned pair could change.
        for pr in pruned:
            if entry or note == "no covered pair":
                break
            if pr in state["dropped"]:
                continue
            if go([(tid, pr, 1) for tid in stage_b])[1]:
                break
            out.discard(pr)
            if repeat({pr}):
                break
            entry, note = selected()
        return len(out)

    by_class = {}
    for t in m["tasks"]:
        if a.cls and t["class"] != a.cls:
            continue
        if t["status"] == "ready":
            by_class.setdefault(t["class"], []).append(t["id"])
        else:
            warn("bench: task %s is %s, skipped" % (t["id"], "void" if t["status"] == "void" else "still a draft"))
    for cls, tasks in sorted(by_class.items()):
        state["pruned"] += bench_class(cls, tasks)
    print("bench: spent=%.2f trials=%d unmeasured=%d pruned=%d"
          % (state["spent"], state["trials"], state["unmeasured"], state["pruned"]))


# --- generalisation and export --------------------------------------------------------

def all_projects():
    out = {}
    for path in sorted(glob.glob(os.path.join(ROUTING_DIR, "projects", "*", "manifest.json"))):
        m = read_json(path, {})
        trials, left = counted(m, read_trials(os.path.join(os.path.dirname(path), "trials.jsonl")))
        if m.get("slug"):
            note_excluded(m["slug"], left)
        if trials and m.get("slug"):
            out[m["slug"]] = (m.get("profile") or "unknown/unknown", trials, task_sizes(m))
    return out


def fold(scope, projects, aliases):
    """Pool the projects' trials, class by class. A pair qualifies when it is covered in at
    least two of the fold's projects having the class (one, for a fold of one project); its
    pooled trials are those of the projects where it is covered, each task named by its
    project so two projects' tasks never merge. A pair is held back when, in a project where it
    is covered, it is not equivalent to that project's best, so one easy project cannot carry a
    profile: it keeps its pooled figures on the ladder, measured, never chosen.
    """
    delta, _ = selection()
    need = 1 if len(projects) == 1 else 2
    entries = {}
    classes = sorted({t["class"] for _, trials, _ in projects.values() for t in trials})
    for cls in classes:
        where, held, pooled_trials, sizes = {}, set(), [], {}
        for slug in sorted(projects):
            _, trials, task_size = projects[slug]
            mine = [t for t in trials if t["class"] == cls]
            if not mine:
                continue
            ladder, _, _ = compare(cls, stats_of(mine, aliases), delta)
            for r in ladder:
                if r["covered"]:
                    where.setdefault(r["pair"], []).append(slug)
                    if not r["equivalent"]:
                        held.add(r["pair"])
            for t in mine:
                pooled_trials.append((slug, canonical_pair(t["pair"], aliases),
                                      dict(t, task="%s:%s" % (slug, t["task"]) if t.get("task") else None)))
            sizes.update(("%s:%s" % (slug, tid), b) for tid, b in task_size.items())
        pooled = {}
        for pair in sorted({pair for _, pair, _ in pooled_trials}):
            qualifies = len(where.get(pair, [])) >= need
            own = [t for slug, p, t in pooled_trials
                   if p == pair and (not qualifies or slug in where[pair])]
            pooled[pair] = dict(stats_of(own, aliases)[pair], covered=qualifies, held_back=pair in held)
        entry, _ = select_entry(cls, pooled, cls in STRICT_CLASSES, sizes)
        if entry:
            entries[cls] = entry
    return {"scope": scope, "generated": datetime.date.today().isoformat(), "entries": entries}


def cmd_generalize(argv):
    if argv:
        die("generalize: takes no argument")
    projects = all_projects()
    if not projects:
        die("generalize: no project has trials")
    aliases = read_aliases()
    profiles = {}
    for slug, (profile, _, _) in projects.items():
        profiles.setdefault(profile, []).append(slug)
    for profile, slugs in sorted(profiles.items()):
        # An unknown language is no profile: pooling such projects would serve one table to
        # repositories that share nothing. They count toward the global table only.
        if len(slugs) < 2 or profile.startswith("unknown/"):
            continue
        table = fold("profile:" + profile, {s: projects[s] for s in slugs}, aliases)
        write_json(table_path("profile:" + profile), table)
        print("profile=%s projects=%d classes=%d" % (profile, len(slugs), len(table["entries"])))
    table = fold("global", projects, aliases)
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
            # Only the figures a rung or an entry has are written, never a null in their place: a
            # table written before the selection by equivalence stays one, and a rung that was
            # never covered has no p_best to write.
            ladder = [dict({k: r[k] for k in ("tasks", "pass_rate", "p_best", "covered", "equivalent",
                                                "eligible") if r.get(k) is not None}, pair=tiered(r["pair"]))
                      for r in e.get("ladder") or [] if is_pair(r.get("pair")) and tiered(r["pair"])]
            entries[cls] = dict({k: e[k] for k in ("pass_rate", "n", "delta", "bar", "strict", "size")
                                 if e.get(k) is not None}, pair=pair, ladder=ladder)
        out = os.path.join(a.to, os.path.basename(path))
        if not entries:
            warn("export: %s has no class in tier form, not written" % os.path.basename(path))
            continue
        write_json(out, {"scope": table.get("scope"), "generated": table.get("generated"), "entries": entries})
        print("exported %s (%d classes)" % (out, len(entries)))


def rung_line(rung, chosen):
    """One rung of a ladder for `show --detail`; a figure an older table lacks reads `-`."""
    f = lambda k: "-" if rung.get(k) is None else rung[k]
    ci = rung.get("median_ci") or ["-", "-"]
    return ("  rung pair=%s tasks=%s pass_rate=%s p_best=%s median_usd=%s ci=%s..%s expected_usd=%s off_model=%s%s%s"
            % (rung.get("pair"), f("tasks"), f("pass_rate"), f("p_best"), f("median_usd"), ci[0], ci[1],
               f("expected_usd"), f("off_model"), " equivalent" if rung.get("equivalent") else "",
               " chosen" if rung.get("pair") == chosen else ""))


def cmd_show(argv):
    detail = "--detail" in argv
    argv = [a for a in argv if a != "--detail"]
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
            if detail and cls in tables[0]:
                for rung in tables[0][cls].get("ladder") or []:
                    print(rung_line(rung, tables[0][cls]["pair"]))


COMMANDS = {"calibrate": cmd_calibrate, "harvest": cmd_harvest, "ready": cmd_ready, "void": cmd_void,
            "trial": cmd_trial, "bench": cmd_bench, "generalize": cmd_generalize, "show": cmd_show,
            "export": cmd_export}
