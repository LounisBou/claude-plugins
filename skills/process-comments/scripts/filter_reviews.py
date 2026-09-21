"""Filter review-body comments to those still open (non-empty, not the PR
author's own review, not already minimized on GitHub).

Usage: python3 filter_reviews.py <USER_LOGIN>
"""

import json
import os
import sys

user = sys.argv[1] if len(sys.argv) > 1 else ""
TMP = os.environ.get("PR_REVIEW_TMP", "/tmp/claude")

reviews = json.load(open(os.path.join(TMP, "reviews.json")))


def load_resolved_batch():
    """Load the node_id -> comments-resolved-batch entries, tolerating a
    missing file -- the batch step is optional context, not every caller of
    this script runs it first."""
    path = os.path.join(TMP, "reviews-resolved-batch.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as handle:
            return json.load(handle) or {}
    except (ValueError, OSError):
        return {}


def is_minimized(review, resolved_batch):
    # Same shape as the issue-comment check in SKILL.md Step 0 Phase 3:
    # ".get" only substitutes its default for an ABSENT key, so an entry
    # present with a null "node" (an id the batch could not resolve) must be
    # guarded the same way as a null "user" below.
    entry = resolved_batch.get(review.get("node_id")) or {}
    node = entry.get("node") or {}
    return bool(node.get("isMinimized"))


resolved_batch = load_resolved_batch()

# ".get" only substitutes its default for an ABSENT key. GitHub sends
# "body": null for a review submitted with no comment text, and "user": null
# for a review left by a since-deleted account -- both survive an unguarded
# ".get(..., default)" and raise AttributeError on ".strip()" / a second
# ".get()" instead of being treated as "no body" / "no login".
open_reviews = [
    r
    for r in reviews
    if (r.get("body") or "").strip()
    and (r.get("user") or {}).get("login", "") != user
    and not is_minimized(r, resolved_batch)
]
json.dump(open_reviews, open(os.path.join(TMP, "open-reviews.json"), "w"), indent=2)
print(f"Open review body comments: {len(open_reviews)}")
