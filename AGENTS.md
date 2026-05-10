
# Agent Instructions

- Treat `docs/` as living project context. Read the relevant docs before changing related bot flow, conversation design, safety, evaluation, or observability behavior.
- Keep docs updated when implementation behavior, product decisions, eval strategy, or important contributor context changes. In particular, update `docs/telegram-chat-flow.md` when Telegram command/state flow changes and `docs/conversation-design-notes.md` when conversation-control decisions or known friction change.
- Prefer tests and evals as the source of truth when docs and code disagree, then update the stale docs as part of the same work.
- For web design or frontend styling tasks, always use the shadcn skill when it is available in the current Codex session.
