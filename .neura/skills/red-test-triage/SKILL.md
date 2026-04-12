---
name: red-test-triage
description: When the user says "help me fix this" or "what broke" while looking at failing test output, create a triage task capturing the failing test name, error message, suspected file, and repro command. The orchestrator captures the on-screen test output via its own describe_screen call and passes the extracted details into this worker's task description — this worker does not access the screen itself. Use this for any test-failure triage flow initiated via voice.
version: 0.1.0
disable-model-invocation: false
allowed-tools: create_task recall_memory read
metadata:
  neura_source: manual
  neura_created_by: phase6-kickoff
  neura_created_at: 2026-04-11T00:00:00Z
---

# Red Test Triage

## When to use

The orchestrator (Grok) dispatches you with a task description containing
details about a failing test that the user is looking at. Your job is to
create a tracked task for fixing it so the user can come back to it later,
optionally enriching the task with any prior context from memory about the
same file or test.

You do NOT have screen access. The orchestrator already captured what's
on screen via its own `describe_screen` tool call before dispatching you,
and passed the relevant details into your task description. If the task
description is empty or doesn't mention a failing test, treat that as a
dispatch error — the orchestrator should have populated it. In that case,
create a generic "investigate failing test" task and flag the missing
context in the task description.

## Expected task description shape

The orchestrator will pass in something like:

> "Failing test: `billing.test.ts` > `calculates tax on line items`. Error:
> `AssertionError: expected 220 to equal 200`. Suspected file:
> `src/billing/tax.ts`. Runner: vitest. User wants this triaged."

Parse out:

- Test name (required)
- Error message (required if present)
- Suspected file path (optional but preferred)
- Test runner (to derive the repro command — vitest, jest, bun test, etc.)

## Steps

1. Read the task description carefully and extract the failing test
   name, the error message, the suspected root-cause file, and the
   test runner.

2. Optionally call `recall_memory` with the suspected file path or
   test name to surface any prior context Neura has about the same
   file (recent edits, known flaky tests, related bugs). Skip this
   step if the test name makes it obvious there's no prior history —
   don't pad with a memory query just because the tool is available.

3. Call `create_task` with:
   - `title`: "Fix failing test: <test name>"
   - `description`: the error message verbatim plus the suspected
     root-cause file path, and a repro command derived from the test
     runner (e.g. `npm run test -- --filter "<test name>"`, or
     `bun test <file> -t "<test name>"` for bun test, or whatever
     matches the runner named in the task description)
   - `priority`: "high" if the error mentions a regression, prod
     break, or deployment blocker. "medium" otherwise.

4. Done. Respond with a one-sentence confirmation telling the user
   what the task title is and what you think the likely cause is
   (if the error message makes it clear). Keep it short.

## Notes for the worker

- This skill must not edit source code and must not run any shell
  commands. The `allowed-tools` field enforces that at the runtime
  level (only `create_task` and `recall_memory` are in the allowlist).

- If the task description contains NO test information at all, call
  `create_task` with a generic investigation prompt and note in the
  description that the orchestrator did not pass test context.
