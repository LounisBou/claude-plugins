"""Force-push protection on the forge: the default branch refuses a force-push and a deletion.

The protection lives on GitHub, not in a guard of a session: a ruleset holds for every client,
every token and every administrator. `protect-check` reads what holds on the default branch;
`protect-apply` puts the repository's ruleset in place when something is missing. With
`--require-ci`, the default branch also requires the CI check core's readiness contract names
(`core/readiness.json`, `conditions.ci.check`), so GitHub refuses a merge until it is green.
"""

import json
import os

from . import errors, fmt, http, repo

RULESET_NAME = "protect the default branch"
_RULES = ("non_fast_forward", "deletion")
_WHAT = {"non_fast_forward": "force-push", "deletion": "deletion"}
_CHECKS = "required_status_checks"

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "core", "readiness.json"), encoding="utf-8") as _fh:
    CI_CHECK = json.load(_fh)["conditions"]["ci"]["check"]


def _default_branch(owner, name):
    return http.rest("GET", "/repos/%s/%s" % (owner, name)).get("default_branch") or "main"


def _classic(owner, name, branch):
    """The classic branch protection's two switches, or None when the branch has none."""
    try:
        data = http.rest("GET", "/repos/%s/%s/branches/%s/protection" % (owner, name, branch))
    except errors.NotFound:
        return None
    if not data:
        return None
    status = data.get("required_status_checks") or {}
    contexts = set(status.get("contexts") or []) | {c.get("context") for c in status.get("checks") or [] if isinstance(c, dict)}
    return {
        "non_fast_forward": (data.get("allow_force_pushes") or {}).get("enabled") is False,
        "deletion": (data.get("allow_deletions") or {}).get("enabled") is False,
        _CHECKS: CI_CHECK in contexts,
    }


def _required(rule):
    """The status check contexts a ruleset's rule requires."""
    checks = ((rule.get("parameters") or {}).get("required_status_checks")) or []
    return {c.get("context") for c in checks if isinstance(c, dict)}


def _wanted(require_ci):
    return _RULES + ((_CHECKS,) if require_ci else ())


def _what(rule):
    return _WHAT.get(rule) or ("the %s check" % CI_CHECK)


def assess(owner, name, require_ci=False):
    """The default branch, and for each refused act (and the CI check, when asked), what holds it (or None)."""
    branch = _default_branch(owner, name)
    rules = [rule for rule in http.rest("GET", "/repos/%s/%s/rules/branches/%s" % (owner, name, branch), paginate=True) or []
             if isinstance(rule, dict)]
    from_rules = {rule.get("type") for rule in rules if rule.get("type") != _CHECKS}
    if any(rule.get("type") == _CHECKS and CI_CHECK in _required(rule) for rule in rules):
        from_rules.add(_CHECKS)
    classic = _classic(owner, name, branch) or {}
    held = {}
    for rule in _wanted(require_ci):
        if rule in from_rules:
            held[rule] = "ruleset"
        elif classic.get(rule):
            held[rule] = "branch protection"
        else:
            held[rule] = None
    return branch, held


def _lines(branch, held):
    acts = [rule for rule in held if rule in _WHAT]
    missing = [_WHAT[rule] for rule in acts if held[rule] is None]
    head = ("protected %s" % branch) if not missing else ("unprotected %s: %s allowed" % (branch, " and ".join(missing)))
    if _CHECKS in held and not held[_CHECKS]:
        head += "; the %s check not required" % CI_CHECK
    detail = ["%s: %s" % (_WHAT[rule], ("refused by the " + held[rule]) if held[rule] else "allowed") for rule in acts]
    if _CHECKS in held:
        detail.append("%s: %s" % (_what(_CHECKS), ("required by the " + held[_CHECKS]) if held[_CHECKS] else "not required"))
    return [head] + detail


def protect_check(args):
    owner, name = repo.owner_repo()
    branch, held = assess(owner, name, getattr(args, "require_ci", False))
    return fmt.Lines("\n".join(_lines(branch, held)))


def _ruleset_body(require_ci):
    rules = [{"type": rule} for rule in _RULES]
    if require_ci:
        rules.append({"type": _CHECKS, "parameters": {
            "strict_required_status_checks_policy": False, "required_status_checks": [{"context": CI_CHECK}]}})
    return {
        "name": RULESET_NAME,
        "target": "branch",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
        "rules": rules,
    }


def protect_apply(args):
    owner, name = repo.owner_repo()
    branch, held = assess(owner, name, True)
    # The CI check the ruleset already requires stays required when the ruleset is rewritten.
    require_ci = getattr(args, "require_ci", False) or held[_CHECKS] == "ruleset"
    if not require_ci:
        del held[_CHECKS]
    if all(held.values()):
        return fmt.Lines("\n".join(["already " + _lines(branch, held)[0]] + _lines(branch, held)[1:]))
    rulesets = http.rest("GET", "/repos/%s/%s/rulesets" % (owner, name), paginate=True) or []
    mine = next((r for r in rulesets if isinstance(r, dict) and r.get("name") == RULESET_NAME), None)
    if mine:
        http.rest("PUT", "/repos/%s/%s/rulesets/%s" % (owner, name, mine["id"]), _ruleset_body(require_ci))
        done = "updated the ruleset « %s »" % RULESET_NAME
    else:
        http.rest("POST", "/repos/%s/%s/rulesets" % (owner, name), _ruleset_body(require_ci))
        done = "created the ruleset « %s »" % RULESET_NAME
    return fmt.Lines("\n".join([done] + _lines(branch, {rule: held[rule] or "ruleset" for rule in held})))


def register(subparsers):
    ci = "also require the %s check (core's readiness contract), so GitHub refuses a merge until it is green" % CI_CHECK
    parser = subparsers.add_parser("protect-check", help="whether the default branch refuses a force-push and a deletion")
    parser.add_argument("--require-ci", action="store_true", help="also read whether the %s check is required" % CI_CHECK)
    parser.set_defaults(handler=protect_check)
    parser = subparsers.add_parser("protect-apply", help="put the ruleset that refuses them in place, when one is missing")
    parser.add_argument("--require-ci", action="store_true", help=ci)
    parser.set_defaults(handler=protect_apply)
