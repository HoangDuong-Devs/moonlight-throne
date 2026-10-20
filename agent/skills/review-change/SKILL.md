---
name: review-change
description: Independent review of a code change (diff, branch or working tree) for spec fit, correctness, security, repo conventions and tests. Review only; does not edit code.
---

# Review a change

Review only. Do not edit code. Output a categorised issue list the author can act on.

## Gather
- The diff: `git diff` (working tree), `git diff <base>...HEAD` (branch), or the files the task names.
- The requirement the change should satisfy (task text, issue, plan). Review against it, not in isolation.
- For big changes, delegate to the `reviewer` subagent with only the diff and the requirement, so it is not biased by your reasoning.

## Check
| Dimension | Question |
|---|---|
| Spec fit | Does the diff deliver what was asked, and nothing else? |
| Minimal diff | Drive-by renames, reformatting or unrelated edits? |
| Correctness | Edge cases, empty or null input, off-by-one, async ordering, error paths. |
| Security | Injection, leaked secrets, missing authorization, unsafe deserialization, path traversal. |
| Conventions | Style, reuse of helpers, speculative abstraction, import hygiene. |
| Tests | New behavior covered? Failure paths tested? Do the tests really assert something? |
| Compatibility | Public interfaces, env vars, schemas: any breaking change flagged? |

Run the tests if you can. Read the test diff, not just the source diff. Check callers of changed functions for silent breakage.

## Output
Per issue:
- **[Critical | Important | Minor]** `path:line` short title
  - Problem: one sentence.
  - Impact: why it matters.
  - Fix: one line or snippet.

Critical: security, data loss, broken core path. Important: wrong behavior at the edges, missing tests for changed behavior, broken convention. Minor: naming, style.

End with one verdict line: `Approve`, `Approve with fixes`, or `Request changes`. Do not mark everything Minor to avoid friction, and do not block on refactors unrelated to the task.
