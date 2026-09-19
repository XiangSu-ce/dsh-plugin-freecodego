---
name: engineering-plan
description: Plan complex multi-file engineering work with explicit scope, risks, phases, and validation before making changes.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 2
---

# Engineering Plan

Use this Skill for multi-file features, migrations, architecture changes, or changes with unclear dependencies.

State the objective, constraints, affected components, failure risks, incremental implementation phases, and exact validation before editing. Inspect the repository before proposing changes. Keep the plan proportional to the task and update it when evidence invalidates an assumption.

Do not claim implementation or verification until the relevant commands, tests, or source evidence have completed.

## Ledger for long-running work

A todo list lives in the session; conversation memory does not survive compaction. When a plan has more than a handful of steps, or the work is expected to outlast one session, write progress to a file as well:

- Keep it next to the plan (for example `<plan>.progress.md`, or the harness's own scratch directory), one line per event: the task, its state (`started` / `done` / `blocked`), and the commit or file that proves it.
- The file's first line names the plan it belongs to, so a resumed session never reads another plan's ledger as its own progress.
- On resume, trust the ledger and the VCS log over recollection of the conversation: a `done` line backed by a commit is real work, and a missing line is work that may need repeating. Re-dispatching finished steps is the most expensive failure this convention exists to prevent.
- Record decisions that were made without asking, with their reason and the cost of being wrong. A decision that exists only in the conversation dies with it.

A ledger is for state, not narration. Keep it short enough that a fresh reader can see in one screen what is done, what is next, and what is unresolved.
