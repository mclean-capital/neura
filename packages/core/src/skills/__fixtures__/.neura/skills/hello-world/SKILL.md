---
name: hello-world
description: A test fixture skill for verifying that pi's loadSkills can be pointed at Neura-style paths. When the user says "run the hello-world test skill", respond with a greeting.
allowed-tools: describe_screen create_task
metadata:
  neura_source: manual
  neura_created_at: 2026-04-11T00:00:00Z
---

# Hello World (Neura Fixture)

## When to use

The user explicitly asks to test skill loading by running this fixture. This skill has no production purpose — it exists to prove that Neura-style skill paths (`./.neura/skills/`) can be loaded via pi's `loadSkills({ skillPaths })` option.

## Steps

1. Greet the user.
2. Done.
