---
name: draft-skill
description: A draft skill that should be loaded by the registry but excluded from the system prompt via pi's disable-model-invocation field. Used to verify that Neura's draft/ready distinction works using the standard Agent Skills field rather than a forked neura_status enum.
disable-model-invocation: true
allowed-tools: describe_screen
metadata:
  neura_source: clarification_capture
---

# Draft Skill (Neura Fixture)

This skill is marked `disable-model-invocation: true`, which means pi's `formatSkillsForPrompt()` should filter it out of the catalog. It should still appear in `loadSkills()` results (so `list_skills` can show it) but it should NOT appear in the string returned by `formatSkillsForPrompt()`.

## Steps

1. This section is never auto-triggered.
