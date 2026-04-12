---
name: wiki-upload
description: When the user says "upload this to the wiki" or "put these notes in the team wiki", upload content to the internal team wiki at wiki.example.com via its /api/pages endpoint. The orchestrator captures whatever the user is looking at via its own describe_screen call and passes the extracted content into this worker's task description — this worker does not access the screen itself. Use when the user wants published, durable notes that live outside Neura's memory.
version: 0.1.0
disable-model-invocation: false
allowed-tools: recall_memory get_current_time
metadata:
  neura_source: manual
  neura_created_by: phase6-kickoff
  neura_created_at: 2026-04-11T00:00:00Z
  neura_status: placeholder
---

# Wiki Upload

> **Phase 6 status**: this skill is a placeholder demonstrating the three
> canonical skill locations loading correctly. The real upload path needs
> an HTTP tool that doesn't exist in Neura's registry yet. Until that lands,
> the worker will acknowledge the request and describe what it would upload,
> but not actually POST anything. The `allowed-tools` list reflects that
> reduced scope.

## When to use

The orchestrator (Grok) dispatches you with a task description containing
the content the user wants published to the team wiki — typically captured
from their screen or from earlier conversation context. Your job is to
format that content as a wiki page payload and (once the HTTP tool lands)
POST it to `https://wiki.example.com/api/pages`.

You do NOT have screen access. The orchestrator already captured what the
user was looking at via its own `describe_screen` tool call and passed the
relevant content into your task description. If the description is empty
or doesn't contain publishable content, treat that as a dispatch error —
tell the user you didn't receive any content to publish.

## Expected task description shape

The orchestrator will pass in something like:

> "Upload to wiki: Notes on the Q4 billing migration. Body: ..."

Parse out:

- Page title (required — infer from the content or the user's request)
- Page body in Markdown (required)
- Tags (optional — extract from context or recent memory)

## Steps (placeholder flow — upgrade when HTTP tool lands)

1. Read the task description and extract the title + body.
2. Call `get_current_time` to timestamp the upload. Wiki pages are
   timestamped by default.
3. Optionally call `recall_memory` with the title or body to check
   whether the user has uploaded similar content before (look for a
   `wiki_upload` tag). If yes, surface that in your response so the
   user can decide whether to update the existing page.
4. Build the wiki page payload in your head (title, body, timestamp,
   tags).
5. Because the HTTP tool is not yet available, respond to the user
   with a one-sentence confirmation of what you WOULD upload and
   pause. Do not claim the upload succeeded.

## Steps (future flow, once HTTP tool lands)

1. Read the task description and extract the content.
2. POST to `https://wiki.example.com/api/pages` with:
   - `title`: inferred from the task description's primary heading
     or the user's prompt
   - `body`: the content formatted as Markdown
   - `tags`: extracted from recent memory context
3. Confirm success with the wiki's returned URL.

## Notes for the worker

- This skill is deliberately conservative about side effects. The wiki
  is shared, so a mistaken upload is user-visible. If the task
  description is ambiguous about what to publish, call
  `request_clarification` before proceeding.
