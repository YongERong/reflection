
# Agent Instructions

## Docs

- Treat `docs/` as living project context. Read the relevant docs before changing related bot flow, conversation design, safety, evaluation, or observability behavior.
- Keep docs updated when implementation behavior, product decisions, eval strategy, or important contributor context changes. In particular, update `docs/telegram-chat-flow.md` when Telegram command/state flow changes and `docs/conversation-design-notes.md` when conversation-control decisions or known friction change.
- Prefer tests and evals as the source of truth when docs and code disagree, then update the stale docs as part of the same work.

## Operating Notes

- Start from current docs, but verify behavior in code, tests, and evals.
- Turn real chat failures and screenshots into transcript regressions.
- Keep conversation state deterministic; use models only for bounded judging or phrasing.
- Avoid phrase-based control gates such as relying on `Got it`, `No stress`, or `That helps`.
- Safety pauses reflection and still creates admin-review records.
- Update docs and eval expectations when behavior changes.
- Do not commit local config, generated eval artifacts, or secrets.

## Skills

- For web design or frontend styling tasks, always use the shadcn skill when it is available in the current Codex session.
