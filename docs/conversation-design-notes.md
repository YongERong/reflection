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
- Safety pauses the reflection. Crisis, self-harm, abuse, immediate danger, and dangerous instructions are not stored as Gibbs answers and do not advance the stage.
- Admin review still happens on safety. The bot writes an open `safety_concerns` row and marks the reflection `safetyFlagged`.

## Research-Shaped Findings

- Commercial assistants usually separate routing, policy, and response generation. This repo follows that pattern through lane classification, deterministic controller decisions, and guarded reply composition.
- Natural chatbots recover from breakdowns instead of repeating the same prompt. This is why same-stage probes are counted by intent and loop repair advances after repeated failed probes.
- Good reflective agents acknowledge context without over-interpreting it. The reply composer may paraphrase meaningful context, but filler, meme text, and unsafe text should not be echoed.
- Personalization should be useful but bounded. Memory updates are proposed only from meaningful, non-safety reflections, and unsafe content is sanitized from summaries/actionables.
- Evaluation needs both isolated component checks and full transcript regressions. The sufficiency suite tests the judge alone; reflection and bot-flow evals test end-to-end behavior.

## Testing And Eval Map

- `npm run test`: unit tests for core controller behavior, Telegram command flow, model routing, and observability helpers.
- `npm run eval:sufficiency`: isolated sufficiency evaluator cases, especially semantic answers and hard rejects.
- `npm run eval:reflection`: end-to-end core reflection transcripts, including screenshot regressions, safety pauses, loop repair, and contextual wording.
- `npm run eval:bot-flow`: Telegram-level command and state routing, including home, `/new`, `/model`, and safety admin-review persistence.
- LangWatch experiment links are printed by eval commands. Artifact JSON files are also written under `better-agents/evals/artifacts/`.

## Current Known Friction

- `/continue` replies with the raw stage prompt. It may feel like a reset after a contextual conversation.
- Dangerous-instruction copy is safe but still jumps quickly back to the current stage prompt.
- Safety-paused reflections keep `/model` blocked, which is correct for state consistency but may need gentler wording.
- Some fallback phrases such as `Got the event` still exist as guardrails and can feel stiff when the composer output is rejected.
- `TODO.md` is historical and contains items that have since been implemented. Treat tests and evals as the source of truth.
