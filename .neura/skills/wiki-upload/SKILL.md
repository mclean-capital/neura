---
name: wiki-upload
description: When the user says "upload this to the wiki" or "put these notes in the team wiki", upload one or more local files or the current screen contents to the internal team wiki at wiki.example.com via its /api/pages endpoint. Use this whenever the user wants published, durable notes that live outside Neura's memory.
version: 0.1.0
disable-model-invocation: false
allowed-tools: describe_screen recall_memory get_current_time
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

The user is looking at a document, note, or screen they want captured in the
team wiki. Example phrases: "upload this to the wiki", "put these notes in
the team wiki", "save this page to wiki". The user expects the content to be
written to a durable shared location, not just Neura's private memory.

## Steps (placeholder flow — upgrade when HTTP tool lands)

1. Call `describe_screen` to capture what's visible. If the screen is empty
   or irrelevant, ask the user what they want uploaded.
2. Call `get_current_time` to timestamp the upload — wiki pages are timestamped
   by default.
3. Call `recall_memory` with the screen context to check whether the user
   has uploaded similar content before (look for `wiki_upload` metadata).
   If yes, ask whether to update the existing page instead of creating a new
   one.
4. Build the wiki page payload in your head (title, body, timestamp, tags).
5. Because the HTTP tool is not yet available, respond to the user with a
   one-sentence confirmation of what you WOULD upload and pause. Do not
   claim the upload succeeded.

## Steps (future flow, once HTTP tool lands)

1. Call `describe_screen` to capture the content.
2. POST to `https://wiki.example.com/api/pages` with:
   - `title`: inferred from the screen's primary heading or the user's prompt
   - `body`: the captured content formatted as Markdown
   - `tags`: extracted from recent memory context
3. Confirm success with the wiki's returned URL.

## Notes for the worker

- This skill is deliberately conservative about side effects. The wiki is
  shared, so a mistaken upload is user-visible. If anything is ambiguous,
  ask one clarifying question before proceeding.
