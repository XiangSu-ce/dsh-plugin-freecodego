---
name: engineering-verification
description: Produce evidence for build, types, lint, tests, security, and diff scope before declaring work complete.
metadata:
  origin: FreeCodeGo Engineering Enhancement Pack
  version: 2
---

# Verification Loop

Before declaring a meaningful code change complete, run the smallest relevant verification stages: build, type checks, lint, tests, security scan, and diff review. Report each stage as pass, fail, skipped, unavailable, or cancelled.

Unavailable checks are not passes. Keep output summaries bounded and retain the commands or evidence needed to reproduce the result.

## The iron law

**No completion claim without fresh verification evidence.**

If the verification command did not run in this turn, the claim "it passes" is not available — the previous run, the last commit, or the confidence that the change is correct are all equally not evidence. This applies to paraphrases and implications of success, not just the exact phrase "it works".

## The gate

Before any status claim, satisfaction, or commit:

1. **Identify** what command proves the claim.
2. **Run** the full command, fresh.
3. **Read** the whole output: exit code, failure count, which stage failed.
4. **Compare** the output against the claim.
   - Does not confirm → report the actual state with its evidence.
   - Confirms → make the claim *with* that evidence.
5. Only then speak.

Skipping any step is not verification, it is a guess wearing the clothes of a report.

## Claim → required evidence

| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | Test run output: 0 failures | an earlier run, "should pass now" |
| Lint clean | Lint output: 0 errors | a partial check, extrapolation from the diff |
| Build succeeds | Build output: exit 0 | lint passing, "no errors in the log" |
| Type check passes | Type checker exit 0 | the editor showing no squiggles |
| Bug fixed | The original symptom's reproduction now passes | the code changed, the fix "obviously" works |
| Regression test proves it | The red→green cycle observed | the test passing once |
| A subagent finished | The VCS diff shows the change | the subagent's own success report |
| Requirements met | A line-by-line checklist against the request | tests passing in unrelated areas |
| Nothing else broke | The full changed surface re-checked | only the touched file re-checked |

## Rationalization table

| The thought | The reality |
|---|---|
| "Should work now" | RUN the verification |
| "I'm confident in this one" | Confidence is not evidence |
| "Just this once" | No exceptions; the exception is the failure mode |
| "The linter passed" | A linter is not a compiler |
| "The subagent said it succeeded" | Verify the diff independently |
| "I'm low on budget" | A wrong "done" costs more than the check |
| "A partial check is enough" | A partial check proves nothing about the rest |
| "Different words, so the rule doesn't apply" | Spirit over letter |

## Scope discipline

- **Smallest relevant set, run fully.** Skipping the stage whose subject you touched is the classic miss: a type-only change still needs the type check, not just tests.
- **Say which stages you did not run and why.** `skipped` and `unavailable` are honest outcomes; a silent omission is not.
- **Backend and frontend are separate claims.** "The change is verified" is only true for the surfaces you actually ran.
- **Environment drift is not a pass.** A check that failed on a pre-existing, unrelated failure must be reported as such, with the evidence that it pre-existed — not folded into your own green summary.
