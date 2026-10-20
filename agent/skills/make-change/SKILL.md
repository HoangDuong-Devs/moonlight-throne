---
name: make-change
description: Careful, surgical code change with a minimal diff and verification. Use when implementing a feature, fix or refactor in an existing repo.
---

# Make a change

Priorities, in order: correctness, minimal diff, consistency with the repo, verifiable outcome, simplicity.

## Before editing
1. Read `AGENTS.md` / `CLAUDE.md` in the repo root if present. Follow them over these defaults.
2. Find the exact files: `grep`/`find`, or `codegraph_explore` if the repo is indexed. Read only what the change touches, plus one nearby example of the same pattern.
3. Check runtime constraints in manifests (language version, dependencies, scripts) and find the project's test and lint commands.
4. Turn a vague request into a verifiable outcome: a failing test, a command with expected output, or a log line.

## While editing
- Every changed line supports the request. Mention unrelated issues in the final answer; do not fix them.
- Match style, naming and patterns; reuse existing helpers; remove only imports your change made unused.
- Do not rename unrelated symbols, reformat unrelated files, or add dependencies, formatters or linters unless asked.
- Behavior changes get a focused test, following the repo's test layout.
- Multi-step work: reproduce or locate, smallest change, verify. Track with `todo` when there are 3 or more steps.

## Finish
- Run the targeted test first, then the wider suite or build that could be affected.
- Re-read the diff. Would a senior engineer call it overcomplicated? Does each line trace to the request? Are repo patterns respected?
- Final answer follows the `STATUS:` format from the system instructions, plus assumptions and unresolved risks.
