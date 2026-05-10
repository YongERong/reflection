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

  U -->|"Text message"| TEXT["Get or create student"]
  TEXT --> OPEN{"Open reflection exists?"}
  OPEN -->|"No"| HOME["Reply with home message<br/>No reflection created"]
  OPEN -->|"Yes"| STUDENT_TURN["Assign reflection model if needed<br/>Persist student turn<br/>Load memory, config, recent turns"]

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

  PROBE --> PERSIST["Save reflection session<br/>Persist bot reply turn(s)<br/>Capture LangWatch trace output"]
  DANGER_REPLY --> PERSIST
  CRISIS_REPLY --> PERSIST
  NEXT_REPLY --> PERSIST
  NO_SUMMARY --> PERSIST
  COMPLETE --> PERSIST

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
- Safety pauses do not advance, complete, or discard the reflection. They still create an open `safety_concerns` record and mark the reflection `safetyFlagged`.
- The deterministic controller owns stage movement, answer storage, safety, loop repair, and summary eligibility. The model only helps judge sufficiency or phrase guarded replies.
- Bot turns are persisted after the updated session is saved, so bot reply turns use the resulting stage.

## Main Trace Attributes

- `reflection.stage`: stage before processing the student message.
- `reflection.next_stage`: stage after processing the turn.
- `reflection.reply_kind`: `normal` or `safety_followup`.
- `reflection.safety_flagged`: whether the current turn had a safety concern.
- `reflection.safety_pause`: true when a safety follow-up paused the reflection.
- `reflection.model.variant`: assigned model for the reflection.
- `reflection.model.assignment_source`: `manual` or `default`.
- `reflection.model.comparison_group`: currently `in_situ_manual`.
