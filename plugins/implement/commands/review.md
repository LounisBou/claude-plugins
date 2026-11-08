---
name: review
description: Launch the review of this branch's pull request in another session, as the method requires
---

This plugin's hooks module answers this command itself. Reading this text means the module is
not loaded here: tell the user to run the review from another session (`/pr-review:auto-fix-loop`
with the loop's `review_only`), in one line, and do nothing else.
