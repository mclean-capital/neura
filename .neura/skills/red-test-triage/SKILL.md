---
name: red-test-triage
description: When the user says "help me fix this" or "what broke" while looking at failing test output, inspect the visible screen to identify the failing test and most likely root cause, recall prior context about the codebase from memory if relevant, then create a task with a repro command and the suspected file path. Use this for any test-failure triage flow initiated via voice.
version: 0.1.0
disable-model-invocation: false
allowed-tools: describe_screen create_task recall_memory
metadata:
  neura_source: manual
  neura_created_by: phase6-kickoff
  neura_created_at: 2026-04-11T00:00:00Z
---

# Red Test Triage

## When to use

The user is looking at a terminal, test runner, or CI dashboard showing failing
tests and asks for help (phrases like "help me fix this", "what broke",
"why did this fail", "look at this error"). This skill exists so the user can
delegate the repetitive triage step ("copy the error message, figure out which
file is implicated, open a task") without leaving voice.

Do NOT use this skill when:

- The user wants you to actually fix the test. This skill triages; it does not
  edit code.
- The failing output is not on screen. If `describe_screen` returns something
  other than test output, ask a clarifying question instead of guessing.

## Steps

1. Call `describe_screen` to capture the current visible context. Look for
   framework-specific patterns: `FAIL`, `AssertionError`, `expect`, stack
   traces, and file paths that end in `.test.ts` / `.test.tsx` / `.spec.ts`.
2. Identify the single most recent failing test. If multiple tests failed,
   pick the one with the shortest stack trace (usually the root cause).
3. Optionally call `recall_memory` with the failing test's file path to check
   whether Neura has prior context about this file (recent edits, known flaky
   tests, related bugs). Only do this if the name doesn't make the failure
   obviously new.
4. Call `create_task` with:
   - `title`: "Fix failing test: <test name>"
   - `description`: the error message verbatim plus the suspected root-cause
     file path, and a repro command derived from the test runner (e.g.
     `npm run test -- --filter <test name>`)
   - `priority`: "high" if the error mentions a regression or production
     break, "medium" otherwise.
5. Briefly tell the user what you created and what the likely cause is
   (~1-2 sentences). Do not lecture.

## Notes for the worker

- If `describe_screen` fails or returns nothing recognizable, stop and ask one
  clarifying question: "I don't see test output on your screen right now —
  can you switch to the terminal or give me the test name?"
- This skill must not edit source code and must not run any shell commands.
  The `allowed-tools` field enforces that at the runtime level.
