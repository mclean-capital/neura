---
name: over-compat-skill
description: Test fixture whose `compatibility` field exceeds the agentskills.io 500-character cap. Used to verify the loader emits an error diagnostic for spec violations.
allowed-tools: describe_screen
compatibility: This compatibility field is intentionally over-length to exercise the agentskills.io spec validation path. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
metadata:
  neura_source: manual
---

# Over-Compat Skill

Intentionally violates the `compatibility` length cap so tests can assert the
loader emits an error diagnostic.
