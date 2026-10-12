---
name: release-guard
description: Release the implement guards on push, merge, pull request, subagent and check edits until an implement skill starts again
---

The guards live in this plugin's hooks module, which answers this command itself
without reaching this text. Reading it means the module is not loaded here, and
then no guard is armed: tell the user so in one line and do nothing else.
