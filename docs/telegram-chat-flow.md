# Telegram Bot Chat Flow

This diagram reflects the current implementation in `apps/bot/src/bot.ts` and
`packages/core/src/agent.ts`.

```mermaid
flowchart TD
  A["Telegram update"] --> RUNTIME{"Runtime mode"}
  RUNTIME -->|"Webhook: POST /telegram/webhook"| WEBHOOK{"Bot configured?"}
  RUNTIME -->|"Polling: bot.start()"| BOT["grammY bot receives update"]
  WEBHOOK -->|"Missing token"| WEBHOOK_503["Return 503"]
  WEBHOOK -->|"Invalid secret token"| WEBHOOK_401["Return 401"]
  WEBHOOK -->|"OK"| BOT

  BOT --> U{"Update type"}

  U -->|"/start"| START["Get or create student<br/>Load active config<br/>Reply with starting message"]
  U -->|"/privacy"| PRIVACY["Reply with storage, dashboard visibility,<br/>memory, and safety note"]
  U -->|"/summary"| SUMMARY{"Latest summary exists?"}
  SUMMARY -->|"Yes"| SUMMARY_YES["Reply with latest summary<br/>and actionables"]
  SUMMARY -->|"No"| SUMMARY_NO["Reply: no completed summary yet"]

  U -->|"/continue"| CONTINUE{"Open reflection exists?"}
  CONTINUE -->|"Yes"| CONTINUE_YES["Reply with current Gibbs stage prompt"]
  CONTINUE -->|"No"| CONTINUE_NO["Reply: send /reflect to start"]

  U -->|"/reflect"| REFLECT{"Open reflection exists?"}
  REFLECT -->|"Yes"| REFLECT_OPEN["Reply: reflection already in progress<br/>Use /continue or /new"]
  REFLECT -->|"No"| CREATE["Create reflection at Description<br/>Assign current model preference<br/>Persist bot prompt turn<br/>Reply with Description prompt"]

  U -->|"/new"| NEW{"Open reflection exists?"}
  NEW -->|"Yes"| NEW_DISCARD["Abandon open reflections<br/>Reply: discarded, use /reflect or /model"]
  NEW -->|"No"| NEW_HOME["Reply with home message<br/>No reflection created"]

  U -->|"/model"| MODEL{"Open reflection exists?"}
  MODEL -->|"Yes"| MODEL_BLOCK["Reply: finish or /new<br/>before changing model"]
  MODEL -->|"No"| MODEL_PICK["Show inline buttons<br/>gpt-4o-mini / gpt-5-mini"]

  U -->|"model:* callback"| CALLBACK{"Open reflection exists?"}
  CALLBACK -->|"Yes"| CALLBACK_BLOCK["Answer callback: finish or discard first<br/>Do not change model"]
  CALLBACK -->|"No + valid model"| CALLBACK_SET["Save process-memory preference<br/>Reply: new reflections will use model"]
  CALLBACK -->|"No + invalid model"| CALLBACK_BAD["Reply: model unavailable"]

  U -->|"/calendar"| CALENDAR{"Google Calendar configured?"}
  CALENDAR -->|"No"| CALENDAR_OFF["Reply: linking is not configured"]
  CALENDAR -->|"Yes"| CALENDAR_LINK["Create short-lived one-time link<br/>Reply with connect/reconnect button"]
  CALENDAR_LINK --> OAUTH_CONNECT["GET /google-calendar/connect<br/>Validate token hash"]
  OAUTH_CONNECT --> GOOGLE["Redirect to Google OAuth<br/>Calendar events scope + offline access"]
  GOOGLE --> OAUTH_CALLBACK["GET /google-calendar/callback<br/>Verify state, exchange code,<br/>store encrypted refresh token"]
  OAUTH_CALLBACK --> CALENDAR_DONE["Browser success page<br/>Telegram confirmation if chat id exists"]

  U -->|"/disconnect_calendar"| CALENDAR_DISCONNECT["Mark connection disconnected<br/>Remove encrypted refresh token"]

  U -->|"Text message"| TEXT["Get or create student"]
  TEXT --> OPEN{"Open reflection exists?"}
  OPEN -->|"No"| HOME["Reply with home message<br/>No reflection created"]
  OPEN -->|"Yes"| COMMAND_BYPASS{"Command text?"}
  COMMAND_BYPASS -->|"Yes"| COMMAND_IGNORE["Command handlers own command replies<br/>Do not batch as reflection text"]
  COMMAND_BYPASS -->|"No"| PRECHECK["Immediate deterministic safety precheck"]
  PRECHECK -->|"Safety / danger"| SAFETY_BYPASS["Cancel pending normal batch<br/>Process this text immediately"]
  PRECHECK -->|"No safety + BOT_RESPONSE_DELAY > 0"| BUFFER["Append to durable pending batch<br/>Update flush_after<br/>Start / refresh typing indicator<br/>Return without bot reply"]
  PRECHECK -->|"No safety + BOT_RESPONSE_DELAY = 0"| STUDENT_TURN["Assign reflection model if needed<br/>Persist student turn<br/>Load memory, config, recent turns"]

  BUFFER --> WORKER["Bot worker claims ready batches<br/>after quiet window + short grace<br/>Set processing lease<br/>Stop typing indicator before reply"]
  WORKER --> STALE{"Batch older than 15 minutes?"}
  STALE -->|"Yes"| STALE_REPLY["Persist combined student text<br/>Reply with catch-up prompt<br/>Do not advance stage"]
  STALE -->|"No"| COMBINED["Combine messages with blank lines"]
  COMBINED --> STUDENT_TURN
  SAFETY_BYPASS --> STUDENT_TURN

  STUDENT_TURN --> LANE["Classify message lane<br/>stage answer, filler, navigation,<br/>short confirmation, safety, danger"]
  LANE --> SAFETY{"Safety result"}

  SAFETY -->|"Dangerous instruction"| DANGER["Save open safety concern<br/>Mark reflection safetyFlagged<br/>Do not store answer<br/>Do not advance stage"]
  DANGER --> DANGER_REPLY["Reply with refusal / safe redirect"]

  SAFETY -->|"Crisis, self-harm, abuse,<br/>or immediate danger"| CRISIS["Save open safety concern<br/>Mark reflection safetyFlagged<br/>Do not store answer<br/>Do not advance stage"]
  CRISIS --> CRISIS_REPLY["Send fixed safety support first<br/>Then safety pause follow-up"]

  SAFETY -->|"Ambiguous distress<br/>or no concern"| CONTROLLER["Controller decides reflection handling"]

  CONTROLLER -->|"Insufficient"| PROBE["Stay in same stage<br/>Generate guarded contextual probe"]
  CONTROLLER -->|"Skip / move-on intent"| SKIP["Advance without storing skip text<br/>Reply with skip acknowledgement"]
  CONTROLLER -->|"Sufficient answer"| STORE["Store current stage answer<br/>Advance"]
  CONTROLLER -->|"Repeated same-stage probes"| LOOP["Loop repair<br/>Use prior meaningful answer if available<br/>Advance"]

  STORE --> NEXT{"Next Gibbs stage exists?"}
  SKIP --> NEXT
  LOOP --> NEXT

  NEXT -->|"Yes"| NEXT_REPLY["Generate guarded contextual reply<br/>Must match next stage intent"]
  NEXT -->|"No"| SUMMARY_ELIGIBLE{"Enough meaningful answers?"}

  SUMMARY_ELIGIBLE -->|"No"| NO_SUMMARY["Complete reflection<br/>Reply: not enough real reflection to summarize"]
  SUMMARY_ELIGIBLE -->|"Yes"| SUMMARY_BUILD{"Safety flagged?"}
  SUMMARY_BUILD -->|"Yes"| SAFE_SUMMARY["Sanitize unsafe answers<br/>Use support-oriented actionable<br/>No memory updates"]
  SUMMARY_BUILD -->|"No"| NORMAL_SUMMARY["Generate summary<br/>Extract actionables<br/>Propose memory updates"]
  SAFE_SUMMARY --> COMPLETE["Save summary<br/>Reply with summary and actionables"]
  NORMAL_SUMMARY --> COMPLETE

  PROBE --> REPLY_GUARD["Reply quality guard<br/>Rewrite exact duplicate bot copy<br/>Keep semantic loop detection separate"]
  NEXT_REPLY --> REPLY_GUARD
  NO_SUMMARY --> REPLY_GUARD
  COMPLETE --> REPLY_GUARD
  REPLY_GUARD --> PERSIST["Save reflection session<br/>Persist logical bot reply turn(s)<br/>Capture LangWatch trace output"]
  DANGER_REPLY --> PERSIST
  CRISIS_REPLY --> PERSIST
  PERSIST --> DELIVERY["Telegram delivery formatter<br/>Optionally split eligible normal replies<br/>into at most two message bubbles"]

  subgraph GIBBS["Gibbs stage order"]
    G1["Description"] --> G2["People"]
    G2 --> G3["Feelings"]
    G3 --> G4["Evaluation"]
    G4 --> G5["Analysis"]
    G5 --> G6["Conclusion"]
    G6 --> G7["Action plan"]
  end
```

## Important Flow Invariants

- Free text in home never starts a reflection. The student must use `/reflect`.
- `/new` discards open reflections and returns home; it does not immediately create a replacement reflection.
- `/model` is available only when no reflection is open. Model assignment is fixed per reflection once it starts.
- `/calendar` starts Google Calendar account linking for the Telegram student. The bot creates a short-lived one-time OAuth link, stores only a hash of the link token, and binds the Google callback through OAuth `state`.
- Google Calendar linking requests offline access for Calendar event creation/editing. The stored refresh token is encrypted before persistence and is associated with the student's `student_profiles.id`.
- `/calendar` shows the current Calendar connection state: no connection creates a connect link, an active connection creates a reconnect/update-permissions link, and `needs_reauth` asks the student to reconnect.
- Telegram inline keyboard buttons are used only for HTTPS OAuth URLs. For local HTTP URLs such as `http://localhost:8787`, the bot sends the OAuth URL as plain text because Telegram rejects localhost URLs in inline buttons.
- `/disconnect_calendar` marks the student's Google Calendar connection disconnected and clears the stored encrypted refresh token.
- Commands bypass the normal text debounce. Stale command bursts are collapsed so the bot does not replay a wall of old command replies after downtime.
- Normal reflection text is debounced through `telegram_pending_batches` when `BOT_RESPONSE_DELAY` is greater than `0`. The default delay is `5` seconds, with supported values from `0` to `30`.
- Buffered normal text starts a best-effort Telegram `typing` indicator immediately. The bot refreshes it about every 4 seconds while the batch is pending.
- Follow-up normal text for the same chat/reflection briefly pauses typing refreshes for 2 seconds, then resumes, so the user sees the bot as revising the pending response.
- Typing indicators are process-local UX only. They stop when the batch flushes, safety bypasses the batch, `/new` cancels the reflection, stale catch-up replies are sent, or debounce is disabled.
- The worker waits a short extra grace after `flush_after` before claiming a batch, so messages that arrive exactly on the boundary can still join the batch.
- The same bot process runs only one pending-batch flush at a time. If a scheduled tick fires while a previous flush is still running, that tick is skipped.
- Claimed pending batches receive a 60-second processing lease. If the bot dies after claim but before completion, the expired `processing` row becomes claimable again on a later worker pass.
- Safety-looking text bypasses debounce, cancels any pending normal batch for that reflection, and is processed immediately.
- Stale normal batches older than 15 minutes receive a catch-up prompt instead of being treated as live reflection input.
- Safety pauses do not advance, complete, or discard the reflection. They still create an open `safety_concerns` record and mark the reflection `safetyFlagged`.
- The deterministic controller owns stage movement, answer storage, safety, loop repair, and summary eligibility. The model only helps judge sufficiency or phrase guarded replies.
- Exact repeated normal bot replies are rewritten before persistence. This guard is surface-level output hygiene; semantic loop detection still counts repeated same-stage probes even when wording differs.
- Bot turns are persisted after the updated session is saved, so bot reply turns use the resulting stage.
- Telegram reply splitting is delivery-only. Core handling, persistence, LangWatch logical outputs, loop detection, and eval transcripts still see one logical bot reply; only eligible normal reflection replies may be delivered as two Telegram bubbles.
- `BOT_REPLY_SPLIT_RATE` controls deterministic delivery splitting from `0` to `1`, defaults to `0.2`, and uses stable context-derived seeds so tests and replay behavior are reproducible.
- Delivery splitting only happens at sentence boundaries and never applies to safety, summary/actionable, command, home, stale backlog, `/reflect`, `/continue`, `/model`, `/new`, or loop-repair replies.

## Contributor Notes

- Google Calendar linking requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, and `PUBLIC_BASE_URL`. `PUBLIC_BASE_URL + /google-calendar/callback` must exactly match a Google OAuth authorized redirect URI.
- Keep the worker's processing lease and in-process scheduler guard paired: the lease recovers after crashes, while the guard prevents overlapping flushes in one bot process.
- Known follow-up: the worker should re-check live batch/reflection state before persisting and sending a claimed batch, so mid-flight safety or `/new` cancellation cannot be overwritten by an older normal reply.

## Main Trace Attributes

- `reflection.stage`: stage before processing the student message.
- `reflection.next_stage`: stage after processing the turn.
- `reflection.reply_kind`: `normal` or `safety_followup`.
- `reflection.safety_flagged`: whether the current turn had a safety concern.
- `reflection.safety_pause`: true when a safety follow-up paused the reflection.
- `reflection.model.variant`: assigned model for the reflection.
- `reflection.model.assignment_source`: `manual` or `default`.
- `reflection.model.comparison_group`: currently `in_situ_manual`.
- `reflection.reply_guard.exact_repeat`: whether the normal reply matched recent bot copy.
- `reflection.reply_guard.action`: guard outcome such as `none`, `alternate_probe`, or `stage_aligned_fallback`.
- `reflection.loop.semantic_probe_count`: same-stage probe count used for loop repair.
- `reflection.loop.semantic_loop`: whether the current turn is in loop-repair territory.
- `telegram.batch.message_count`: number of user messages combined into the processed turn.
- `telegram.batch.first_message_at`: timestamp of the first buffered message.
- `telegram.batch.last_message_at`: timestamp of the final buffered message.
- `telegram.batch.debounce_ms`: quiet-window delay used for the flushed batch.
- `telegram.batch.stale`: whether the batch was too old for normal reflection processing.
- `telegram.batch.cancelled_by_safety`: whether safety bypass cancelled pending normal text.
- `telegram.delivery.split`: whether Telegram delivery split a logical bot reply into multiple messages.
- `telegram.delivery.message_count`: number of Telegram messages delivered for the logical reply or replies.
- `telegram.delivery.split_rate`: configured deterministic split rate used for delivery planning.
