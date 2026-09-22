---
name: engineering-code-review
description: Review changed code for concrete behavioral failures, regressions, security risks, and missing tests.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 2
---

# Code Review

Start with concrete findings ordered by severity. Each finding needs an exact location, a realistic failure mode, and enough surrounding context to prove it is actionable. Focus on correctness, behavioral regressions, security boundaries, race conditions, error handling, and missing verification.

Returning no findings is valid when the reviewed evidence supports it. Do not manufacture style concerns to appear rigorous.

## Run the review with the review tools

The plugin owns a review pipeline. Prefer it over re-deriving a review by reading the diff yourself — the pipeline covers every changed file and you do not, and it pays that cost in one call instead of dozens.

| Tool | Use it when |
| --- | --- |
| `engineering_code_review` | You need the findings. Reviews staged, unstaged **and** untracked changes by default; pass `mode: "range"` with `from`/`to` for a branch comparison, or `mode: "commit"` for one commit. `format: "json"` or `"sarif"` for machine output. |
| `engineering_review_rules` | You need to know what *would* be reviewed and which rule applies to each file. Costs no model call — use it to check an exclude pattern or a project rule file, or to get the file list so you can review a subset yourself. |
| `engineering_review_status` | A review is running, or you want to know what the last one covered. |
| `engineering_review_report` | Re-read an earlier review, in text, JSON, or SARIF, without paying for it again. |

Pass a short `background` describing what the change was *meant* to do. It is the difference between flagging a deleted branch as a regression and recognising it as the point of the change.

## Read the coverage before you report

A review accounts for every file it entered, and the three states are not interchangeable:

- **reviewed** — a reviewer read it.
- **skipped** — nothing was read, and the reason is stated: excluded by a rule layer, binary, oversized, unreadable, past the file limit, or refused by the run budget.
- **failed** — a reviewer was supposed to read it and did not; the error is stated.

`reviewed` is not `total`. Saying "the change is clean" when half the files were skipped is a claim the review did not make, so check the skip list before you repeat it. When the interesting files are the skipped ones, narrow the run (`exclude`, or review a specific range) until they are inside it.

`exclude` takes gitignore-style patterns, and a brace list counts as one: `**/*.{gen,min}.ts` drops both, in the same three places a rule file may write it (a system rule, a rule-document entry, and an `exclude` list). `**` crosses directories, a pattern with no slash matches at any depth, and matching is case-sensitive.

Findings arrive with a severity, a category, a location, and sometimes a replacement. A finding at line `0` means the reviewer could not place it on a line — treat it as a claim about the change rather than about a specific line, and do not restate it as though it had coordinates.

## When you disagree with a finding

Say so, and say what would have to be true for it to be wrong. A finding the diff disproves is worth reporting as such — the pipeline records filtered findings and adjudicated ones separately from published ones, so a disagreement with evidence is more useful than silence, and much more useful than editing the code to satisfy a finding that was never right.
