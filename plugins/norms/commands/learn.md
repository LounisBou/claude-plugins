---
description: "Use after a PR is merged or reviewed to hand its resolved review threads to the learning distiller as evidence for project code norms"
argument-hint: "<PR-number> [PR-number...]"
allowed-tools: []
---

# Norms Learn

**PR numbers:** $ARGUMENTS

The norms hooks module answers this command by itself: it reads the pull requests' resolved threads, keeps those code shows acted on by an author who can write, and writes them into its journal for the learning distiller. A rule comes from a candidate the learning retrospective judges, and enters `CONTRIBUTING.md` only after the person says **add**.

When this text reaches you, the hooks module did not answer: the pull requests could not be read, no GitHub repository is the origin, or modules do not load in this session. Tell the user so in one line, and stop. Write nothing to `CONTRIBUTING.md` and propose no rule.
