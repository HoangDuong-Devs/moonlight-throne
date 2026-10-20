---
name: debug-root-cause
description: Find the root cause of a bug, failing test, build error or unexpected behavior before changing code. Use at the first sign of a failure.
---

# Debug to the root cause

No fix before the root cause is found. A symptom patch hides the real bug, even when the fix looks obvious.

## Phase 1: investigate
1. Read the exact error, stack trace and inputs.
2. Reproduce it reliably with a command. If you cannot reproduce it, you cannot confirm a fix.
3. Find who reaches the failing code (`grep` for callers, or `codegraph_explore` on an indexed repo) and what else depends on it.
4. Check recent changes on the path: `git log -p -- <file>`, `git blame` on the failing line.
5. Trace the data backward from the failure to where the bad value first appears. Add temporary logging at boundaries if state is unclear, and remove it afterwards.

Result of this phase: one sentence stating cause then effect, not the symptom.

## Phase 2: compare
Find a working case nearby, read it completely, and list every difference from the broken path: config, types, ordering, error handling, versions.

## Phase 3: test one hypothesis
State one hypothesis ("X causes Y because Z"). Test it with the smallest possible change (a print, a guard, one value swap). Do not bundle changes. A rejected hypothesis is useful data; say so.

## Phase 4: fix
Write a failing test that captures the bug, make the minimal fix (follow the `make-change` skill), then run the whole suite, not just the new test.

## Stop signs
- "Quick fix now, clean up later", random edits hoping one works, several edits in one attempt, skipping the failing test.
- After 3 failed fix attempts, stop. Report what is known (cause candidates, evidence, what was ruled out) with `STATUS: partial` instead of trying more variants.
- If the cause truly is environmental (flaky network, external race), document the evidence and add a timeout or retry at the boundary.
