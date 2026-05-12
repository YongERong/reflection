# Conversation Design Notes

This project has moved from a fixed prompt chain toward a guarded conversation
controller. These notes capture the decisions that matter most for future
contributors.

## Core Principles

- Keep the modified Gibbs stage order, but treat it as a flexible scaffold rather than a rigid script.
- Let deterministic code own safety, stage movement, answer storage, loop repair, summary eligibility, and model assignment.
- Use the LLM for bounded jobs: sufficiency judgement and natural wording. Do not let it decide persistence, stage movement, or safety escalation.
- Prefer semantic sufficiency over keyword gates. Short natural answers can be valid when they clearly satisfy the current stage.
- Do not summarize junk. Completion requires enough meaningful answers, not merely reaching the final stage.

## Key Product Decisions

- Home is neutral. Free text outside an open reflection returns the home message and does not create records.
- `/reflect` is the explicit entry point into a reflection.
- `/new` abandons open reflections and returns home. This keeps model switching and restarts clear.
- `/model` is a testing harness, not a student-facing coaching feature. Preferences are process-memory only, and the assignment is fixed for a whole reflection.
- `/calendar` starts a browser-based Google OAuth handoff using a short-lived one-time link tied to the Telegram student profile. Telegram identifies the local student record, but Google only becomes connected after the callback returns with the matching state.
- `/disconnect_calendar` removes stored Google Calendar access for the student. Calendar refresh tokens are app-encrypted before persistence, and reconnect is required when Google returns token-refresh failures.
- Normal Telegram reflection text is buffered briefly so double/triple texts can be processed as one coherent turn. `BOT_RESPONSE_DELAY` defaults to 5 seconds and supports 0-30 seconds; 0 keeps immediate processing. The worker also waits a short grace after the flush time before claiming a batch to avoid edge-of-window double prompts, runs only one flush at a time per bot process, and uses a 60-second processing lease so process crashes do not strand batches in `processing`.
- While normal text is buffered, the bot sends and refreshes Telegram `typing` actions as immediate feedback. Follow-up texts briefly pause the refresh before resuming, which makes the debounce feel like the bot is revising instead of ignoring the user.
- Deterministic code owns batching, freshness checks, stale command collapse, and safety bypass. The LLM only receives safe combined turns after the debounce worker flushes them.
- Telegram can make eligible normal replies feel less blocky by splitting delivery into at most two message bubbles, but this is a send-time formatting choice only. The database, LangWatch logical traces, loop detection, and eval transcripts keep the single logical bot reply.
- Delivery splitting is deterministic and configurable through `BOT_REPLY_SPLIT_RATE`, defaults to `0.2`, and only splits at sentence boundaries. Safety, summaries/actionables, commands, home/stale replies, command prompts, and loop-repair copy stay unsplit.
- Commands bypass text batching. If Telegram redelivers an old burst after downtime, stale commands are collapsed so only the latest meaningful command runs with a catch-up note.
- Exact repeated bot replies are treated as output hygiene failures and are rewritten with deterministic alternates before persistence. This is separate from semantic loop repair, which still counts same-stage probes even when they use different wording.
- Safety pauses the reflection. Crisis, self-harm, abuse, immediate danger, and dangerous instructions are not stored as Gibbs answers and do not advance the stage.
- Admin review still happens on safety. The bot writes an open `safety_concerns` row and marks the reflection `safetyFlagged`.

## Research-Shaped Findings

- Commercial assistants usually separate routing, policy, and response generation. This repo follows that pattern through lane classification, deterministic controller decisions, and guarded reply composition.
- Natural chatbots recover from breakdowns instead of repeating the same prompt. This is why same-stage probes are counted by intent and loop repair advances after repeated failed probes.
- Repetition checks intentionally distinguish surface repeats from deeper loops: no exact duplicate bot copy should ship, but differently phrased same-stage probes must still be visible to the loop detector.
- Good reflective agents acknowledge context without over-interpreting it. The reply composer may paraphrase meaningful context, but filler, meme text, and unsafe text should not be echoed.
- Personalization should be useful but bounded. Memory updates are proposed only from meaningful, non-safety reflections, and unsafe content is sanitized from summaries/actionables.
- Evaluation needs both isolated component checks and full transcript regressions. The sufficiency suite tests the judge alone; reflection and bot-flow evals test end-to-end behavior.

## Testing And Eval Map

- `npm run test`: unit tests for core controller behavior, Telegram command flow, model routing, and observability helpers.
- `npm run eval:sufficiency`: isolated sufficiency evaluator cases, especially semantic answers and hard rejects.
- `npm run eval:reflection`: end-to-end core reflection transcripts, including screenshot regressions, safety pauses, loop repair, exact-repeat guards, and contextual wording.
- `npm run eval:bot-flow`: Telegram-level command and state routing, including home, `/new`, `/model`, and safety admin-review persistence.
- LangWatch experiment links are printed by eval commands. Artifact JSON files are also written under `better-agents/evals/artifacts/`.

## Development Lessons

- Debounce, freshness, safety bypass, leases, and delivery splitting are separate concerns. Fixes should preserve those boundaries instead of collapsing them into one queue rule.
- The pending-batch processing lease is a durability tool for process death. The same-process flush guard is a scheduling tool that prevents interval overlap while the lease is active.
- Supabase RPC signatures are part of the runtime contract. When code starts calling a new RPC shape, verify the live project schema through Supabase MCP and add a forward migration if production already has an older migration version.
- Google Calendar linking depends on `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_TOKEN_ENCRYPTION_KEY`. Keep the OAuth redirect URI aligned with `PUBLIC_BASE_URL`; in development, Google OAuth test-mode refresh tokens for calendar scopes expire after 7 days.
- LangWatch and eval transcripts should continue to describe logical conversation turns. Telegram typing and split-message delivery are UX layers and should not rewrite the stored transcript.

## Current Known Friction

- `/continue` replies with the raw stage prompt. It may feel like a reset after a contextual conversation.
- Dangerous-instruction copy is safe but still jumps quickly back to the current stage prompt.
- Safety-paused reflections keep `/model` blocked, which is correct for state consistency but may need gentler wording.
- Some fallback phrases such as `Got the event` still exist as guardrails and can feel stiff when the composer output is rejected.
- A claimed pending batch can still finish a normal reply if safety or `/new` cancels it while model work is in flight. A future fix should re-check live batch/reflection state before worker persistence and delivery.
- A delayed stale-command collapse timer can still fire after a fresh command arrives in the same chat. A future fix should clear pending stale timers before executing fresh commands.
- `TODO.md` is historical and contains items that have since been implemented. Treat tests and evals as the source of truth.
