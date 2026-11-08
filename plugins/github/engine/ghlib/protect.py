"""Force-push protection on the forge: the default branch refuses a force-push and a deletion.

The protection lives on GitHub, not in a guard of a session: a ruleset holds for every client,
every token and every administrator. `protect-check` reads what holds on the default branch;
`protect-apply` puts the repository's ruleset in place when something is missing.
"""

from . import errors, fmt, http, repo

RULESET_NAME = "protect the default branch"
_RULES = ("non_fast_forward", "deletion")
_WHAT = {"non_fast_forward": "force-push", "deletion": "deletion"}


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
    return {
        "non_fast_forward": (data.get("allow_force_pushes") or {}).get("enabled") is False,
        "deletion": (data.get("allow_deletions") or {}).get("enabled") is False,
    }


def assess(owner, name):
    """The default branch, and for each refused act, what refuses it (or None when nothing does)."""
    branch = _default_branch(owner, name)
    rules = http.rest("GET", "/repos/%s/%s/rules/branches/%s" % (owner, name, branch), paginate=True) or []
    from_rules = {rule.get("type") for rule in rules if isinstance(rule, dict)}
    classic = _classic(owner, name, branch) or {}
    held = {}
    for rule in _RULES:
        if rule in from_rules:
            held[rule] = "ruleset"
        elif classic.get(rule):
            held[rule] = "branch protection"
        else:
            held[rule] = None
    return branch, held


def _lines(branch, held):
    missing = [_WHAT[rule] for rule in _RULES if held[rule] is None]
    head = ("protected %s" % branch) if not missing else ("unprotected %s: %s allowed" % (branch, " and ".join(missing)))
    detail = ["%s: %s" % (_WHAT[rule], ("refused by the " + held[rule]) if held[rule] else "allowed") for rule in _RULES]
    return [head] + detail


def protect_check(args):
    owner, name = repo.owner_repo()
    branch, held = assess(owner, name)
    return fmt.Lines("\n".join(_lines(branch, held)))


def _ruleset_body():
    return {
        "name": RULESET_NAME,
        "target": "branch",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
        "rules": [{"type": rule} for rule in _RULES],
    }


def protect_apply(args):
    owner, name = repo.owner_repo()
    branch, held = assess(owner, name)
    if all(held[rule] for rule in _RULES):
        return fmt.Lines("\n".join(["already " + _lines(branch, held)[0]] + _lines(branch, held)[1:]))
    rulesets = http.rest("GET", "/repos/%s/%s/rulesets" % (owner, name), paginate=True) or []
    mine = next((r for r in rulesets if isinstance(r, dict) and r.get("name") == RULESET_NAME), None)
    if mine:
        http.rest("PUT", "/repos/%s/%s/rulesets/%s" % (owner, name, mine["id"]), _ruleset_body())
        done = "updated the ruleset « %s »" % RULESET_NAME
    else:
        http.rest("POST", "/repos/%s/%s/rulesets" % (owner, name), _ruleset_body())
        done = "created the ruleset « %s »" % RULESET_NAME
    return fmt.Lines("\n".join([done] + _lines(branch, {rule: held[rule] or "ruleset" for rule in _RULES})))


def register(subparsers):
    parser = subparsers.add_parser("protect-check", help="whether the default branch refuses a force-push and a deletion")
    parser.set_defaults(handler=protect_check)
    parser = subparsers.add_parser("protect-apply", help="put the ruleset that refuses them in place, when one is missing")
    parser.set_defaults(handler=protect_apply)
