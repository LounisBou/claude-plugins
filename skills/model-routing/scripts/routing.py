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
import glob
import json
import os
import re
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


COMMANDS = {"cost": cmd_cost}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("usage: routing.py {%s} ..." % "|".join(sorted(COMMANDS)))
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
