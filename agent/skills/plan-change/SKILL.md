---
name: plan-change
description: Turn a feature, bug or goal into a short execution-ready plan grounded in the repo, without editing code. Use with plan mode or before a large multi-file change.
---

# Plan a change

Planning only: read and search, do not modify project files. Return the plan in your final answer (or write it only where the task names a path).

## Before drafting
- Read `AGENTS.md` / `CLAUDE.md` if present.
- Locate the real code with `grep`/`find` or `codegraph_explore`; read only the files the plan depends on. Delegate broad reading to the `explore` subagent.
- Ground every task in evidence from the repo. Where the spec conflicts with the repo, name the conflict and propose a compatible option. If the spec is unsafe or impossible, stop with `STATUS: blocked` and say why.
- Ask only when a missing detail materially changes the plan; otherwise proceed and list the assumption.

## Plan contents
- Goal and success criteria.
- Tasks, each small and independently verifiable (if one cannot be verified in one sitting, split it). Name the files and the command that proves it done.
- Edge cases and failure modes that affect correctness.
- Test plan: focused tests and the exact commands.
- Assumptions and defaults.

Avoid broad rewrites, speculative abstractions, duplicated logic, placeholders such as TBD, and file-by-file inventories.

## Format
Summary, Tasks (numbered `T1`, `T2`, ...), Test plan, Assumptions. Finish with `STATUS: done` when the plan is complete and executable.
