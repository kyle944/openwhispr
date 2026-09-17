# AGENTS.md

Project guide lives in `CLAUDE.md` — read it first.

## Shared procedural memory (Memorable)

This machine records agent sessions into Memorable, a shared memory the other
agents can read. Two MCP calls change how you work:

- Before planning a task that might have been done before (setup, deploy,
  debugging, config, recurring ops), call `memorable_memory_search`, then
  `memorable_memory_get` on the top hit and follow its steps.
- After finishing a non-trivial task, call `memorable_memory_record` with the
  procedure that worked: steps, preconditions, postconditions. The next agent
  gets handed your result instead of rediscovering it.

Local capture and recall are already on (`~/.memorable`); `MEMORABLE=0` opts a
session out. Do not call `memorable_admin_*` tools — account, key, member, and
policy changes go through Kyle.
