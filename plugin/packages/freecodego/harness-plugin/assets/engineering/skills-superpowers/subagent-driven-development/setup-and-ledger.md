# Setup: the workspace, the ledger, and the pre-flight scan

Read this at skill start, and again after any compaction. Everything here exists so a
controller that lost its place does not re-dispatch work it already finished — the
single most expensive failure observed in real sessions.

## The workspace

Each plan owns a workspace: at skill start, run this skill's
`scripts/sdd-workspace PLAN_FILE` — it prints the plan's git-ignored
directory (`<repo-root>/.superpowers/sdd/<plan-basename>/`), home to
every artifact for THIS plan: ledger, briefs, reports, review packages.
Another plan's directory is never yours to read or write.

## The ledger

- Check for this plan's ledger at `<workspace>/progress.md`. If its first
  line names your plan file, tasks with a `Task <N>: complete` line are DONE
  — do not re-dispatch them; resume at the first task without one. A task
  whose last line is a fix round is mid-loop: resume the loop at the next
  round. A ledger whose first line names a different plan file — or a stray
  ledger at the old flat path `.superpowers/sdd/progress.md` — is another
  plan's progress: leave it in place and start your own, fresh.
- Create the ledger with its identity as the first line:
  `# SDD ledger — plan: <plan file path>`.
- The ledger is your recovery map: the commits it names exist in git even
  when your context no longer remembers creating them. After compaction,
  trust the ledger and `git log` over your own recollection.
- `git clean -fdx` will destroy the workspace (it's git-ignored scratch); if
  that happens, recover from `git log`.

The lines you will append, in the order you will write them:

| Line | When |
|---|---|
| Pre-flight scan table (below) | before Task 1 |
| `Task <N>: complete (commits <base7>..<head7>, review clean)` | clean review |
| `Task <N>: complete (commits <base7>..<head7>, <K> parked)` | after a tripped breaker |
| `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)` | after each fix round |
| `Task <N>: minor (deferred): <one-liner>` | as Minor findings arrive |
| `Task <N>: parked — <finding> — Ruling: <why the code stands>` | adjudication at the cap |
| `Task <N>: Ruling: <finding> — <what you decided and why>` | load-bearing adjudication |
| `Ruling: <what you decided> — <why> — <what it costs if wrong>` | any other decision the plan or spec did not answer |

## Reading the plan

Read the plan once, note its context and Global Constraints, and create a
todo per task. If the plan names a Spec, read that too: the spec is the
authority the plan argues from, and conflicts inside the plan resolve
against it. A plan with no reachable spec gets a ledger note saying so —
rulings made without one are provisional.

## The pre-flight conflict scan

Before dispatching Task 1, scan the plan once for conflicts, writing down
what you checked as you check it:

- tasks that contradict each other or the plan's Global Constraints
- anything the plan explicitly mandates that the review rubric treats as a
  defect (a test that asserts nothing, verbatim duplication of a logic block)

The scan's output is a table, not a verdict. One row for every pair of tasks
that share a file or an interface: the two tasks, what one produces against
what the other consumes, and what you found. One row for every task: whether
its own text agrees with itself — the tests it specifies against the code it
specifies, the files it creates against the files it later touches. "The scan
is clean" without those rows is not a scan you ran.

Write the table to the ledger. Rule on everything you find before execution
begins — each finding against the plan text that mandates it — and record
each ruling in the ledger. If the scan is clean, proceed without comment.
Rule on each conflict it surfaces — the spec is the binding authority, the
plan is its argument — record the ruling beside its row, and dispatch
Task 1. The review loop remains the net for conflicts that only emerge from
implementation.
