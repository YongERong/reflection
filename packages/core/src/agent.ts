import { defaultPromptConfig, type PromptConfig } from "./config.js";
import { gibbsStageSchema, nextStage, stagePrompts, type GibbsStage } from "./gibbs.js";
import type { ModelClient } from "./model.js";
import { buildReflectionPrompt } from "./prompts.js";
import { sanitizeUnsafeAnswers, skillRegistry } from "./skills.js";
import { createId } from "./storage.js";
import { z } from "zod";
import {
  safetyClassificationSchema,
  type ReflectionSession,
  type ReflectionSummary,
  type ReflectionTurn,
  type SafetyClassification,
  type StudentMemory,
  type StudentProfile
} from "./types.js";

export type AgentTurnInput = {
  profile: StudentProfile;
  memory?: StudentMemory;
  config?: PromptConfig;
  model?: ModelClient;
  recentTurns?: ReflectionTurn[];
  session: ReflectionSession;
  studentMessage: string;
};

export type AgentTurnOutput = {
  session: ReflectionSession;
  botMessage: string;
  completed: boolean;
  promptText: string;
  summary?: ReflectionSummary;
  proposedMemoryUpdates: Array<{ kind: string; value: string; reason: string }>;
  safetyConcern: SafetyClassification;
  replyKind: "normal" | "safety_support" | "safety_followup";
};

export type StageSufficiency = {
  stageComplete: boolean;
  confidence: number;
  missing: string[];
  probeQuestion: string;
  reason: string;
};

type TurnDecisionKind =
  | "valid_stage_answer"
  | "partial_stage_answer"
  | "short_contextual_answer"
  | "reaction_or_filler"
  | "off_topic_or_playful"
  | "skip_or_navigation"
  | "safety_or_danger";

type RepairAction =
  | "probe"
  | "accept_and_advance"
  | "auto_advance"
  | "skip_stage"
  | "safety_redirect"
  | "complete"
  | "no_summary";

type TurnDecision = {
  kind: TurnDecisionKind;
  shouldAdvance: boolean;
  shouldStore: boolean;
  answerToStore?: string;
  repairAction: RepairAction;
  replyIntent: string;
};

type ContextualReplyMode =
  | "probe_current_stage"
  | "transition_to_next_stage"
  | "loop_repair"
  | "skip_acknowledgement";

type MessageLane =
  | "stage_answer"
  | "low_effort"
  | "off_topic_or_playful"
  | "meta_navigation"
  | "short_confirmation"
  | "crisis_safety"
  | "dangerous_instruction"
  | "ambiguous_distress";

export const fixedSafetySupportMessage =
  "I am really sorry you are dealing with that. If you might be in immediate danger, please contact a trusted adult or local emergency support now. We can keep reflecting, but your safety matters first.";
export const safetyPauseFollowupMessage =
  "We can pause the reflection here. Reply when you're ready to continue, or send /new to start over.";
export const insufficientReflectionMessage =
  "I don't have enough real reflection to summarize yet. You can start again with /reflect when you're ready.";

export async function handleReflectionTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const memory = input.memory ?? {
    profileFacts: [],
    recurringThemes: [],
    strengths: [],
    goals: []
  };
  const config = input.config ?? defaultPromptConfig;
  const stage = gibbsStageSchema.parse(input.session.currentStage);
  const now = new Date().toISOString();
  const recentTurns = input.recentTurns ?? [];
  const lane = classifyMessageLane(input.studentMessage, stage, recentTurns);
  const safetyConcern = await classifySafety(input.studentMessage, input.model, lane);
  const promptText = buildReflectionPrompt({ config, profile: input.profile, memory, stage });

  if (safetyConcern.category === "dangerous_instruction") {
    return {
      session: {
        ...input.session,
        safetyFlagged: true,
        updatedAt: now
      },
      botMessage: dangerousContentRedirect(stage),
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: "safety_followup"
    };
  }

  if (isCrisisSafety(safetyConcern)) {
    return {
      session: {
        ...input.session,
        safetyFlagged: true,
        updatedAt: now
      },
      botMessage: safetyPauseFollowupMessage,
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: "safety_followup"
    };
  }

  const turnDecision = decideTurn({
    stage,
    studentMessage: input.studentMessage,
    recentTurns,
    safetyConcern,
    lane
  });
  const stageAnswer = turnDecision.answerToStore ?? normalizeCasualStageAnswer(stage, resolveStageAnswer({
    stage,
    studentMessage: input.studentMessage,
    recentTurns
  }));
  const hasMoveOnIntent = turnDecision.kind === "skip_or_navigation";
  const acceptedByController = turnDecision.repairAction === "accept_and_advance";
  const safetyBypassesSufficiency = isCrisisSafety(safetyConcern);
  const sufficiency = safetyBypassesSufficiency
    ? completeSufficiency(stage, "Safety concern path keeps the reflection moving after support.")
    : acceptedByController
      ? completeSufficiency(stage, turnDecision.replyIntent)
      : await evaluateStageSufficiency({
        stage,
        studentMessage: stageAnswer,
        answers: input.session.answers,
        recentTurns,
        model: input.model,
        promptText
      });
  const probeCount = countStageProbes(recentTurns, stage);
  const loopRepair = !sufficiency.stageComplete && probeCount >= 2;
  const shouldMoveOn = turnDecision.shouldAdvance || sufficiency.stageComplete || loopRepair || hasMoveOnIntent;
  const forcedMove = loopRepair;
  const independentlyAnsweredStage = sufficiency.stageComplete && !safetyBypassesSufficiency;
  const repairedAnswer = loopRepair ? findPreviousMeaningfulStageAnswer(stage, recentTurns) : undefined;
  const answerToStore = repairedAnswer ?? stageAnswer;
  const shouldStoreAnswer =
    !hasMoveOnIntent &&
    (turnDecision.shouldStore && independentlyAnsweredStage ||
      forcedMove && (repairedAnswer ? isMeaningfulStoredAnswer(answerToStore) : turnDecision.shouldStore && isStorableForcedAnswer(answerToStore, lane)));
  const session: ReflectionSession = {
    ...input.session,
    answers: shouldStoreAnswer
      ? {
          ...input.session.answers,
          [stage]: answerToStore.trim()
        }
      : { ...input.session.answers },
    updatedAt: now
  };
  session.safetyFlagged = input.session.safetyFlagged || safetyConcern.hasConcern;

  if (!shouldMoveOn) {
    const fallback = formatProbeReply({
      stage,
      studentMessage: input.studentMessage,
      sufficiency,
      probeCount,
      recentTurns,
      lane
    });
    const botMessage = await generateContextualReflectionReply({
      model: input.model,
      promptText,
      stage,
      mode: "probe_current_stage",
      studentMessage: input.studentMessage,
      fallback,
      recentTurns,
      answers: session.answers,
      requiredQuestionIntent: requiredQuestionIntent(stage),
      lane
    });
    return {
      session,
      botMessage,
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: "normal"
    };
  }

  const followingStage = nextStage(stage);
  if (followingStage) {
    session.currentStage = followingStage;
    const fallback = safetyConcern.hasConcern
      ? safetyFollowup(followingStage)
      : hasMoveOnIntent
        ? skipStageMessage(followingStage)
        : loopRepair
          ? loopRepairMessage({
              currentStage: stage,
              followingStage,
              repairedAnswer,
              recentTurns
            })
          : forcedMoveMessage(stage, followingStage, sufficiency.stageComplete);
    const botMessage = safetyConcern.hasConcern
      ? await generateAdaptiveReply({
          model: input.model,
          promptText,
          stage: followingStage,
          studentMessage: input.studentMessage,
          fallback,
          safetyConcern,
          recentTurns,
          answers: session.answers,
          preserveFallback: true
        })
      : await generateContextualReflectionReply({
          model: input.model,
          promptText,
          stage: followingStage,
          mode: hasMoveOnIntent ? "skip_acknowledgement" : loopRepair ? "loop_repair" : "transition_to_next_stage",
          studentMessage: input.studentMessage,
          fallback,
          recentTurns,
          answers: session.answers,
          requiredQuestionIntent: requiredQuestionIntent(followingStage),
          lane
        });
    return {
      session,
      botMessage,
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: safetyConcern.hasConcern ? "safety_followup" : "normal"
    };
  }

  session.status = "completed";
  if (!isSummaryEligible(session.answers)) {
    return {
      session,
      botMessage: insufficientReflectionMessage,
      completed: true,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: "normal"
    };
  }

  const hadSafetyConcern = session.safetyFlagged || !safetyConcern.allowNormalSummary;
  const safeAnswers = hadSafetyConcern ? sanitizeUnsafeAnswers(session.answers) : session.answers;
  const summaryResult = await generateSummary({
    model: input.model,
    answers: safeAnswers,
    safetyConcern
  });
  const actionResult = !hadSafetyConcern
    ? skillRegistry.extract_actionables.run({ answers: safeAnswers })
    : { actionables: ["Check in with a trusted adult or support person before deciding on next steps."] };
  const memoryResult = hadSafetyConcern
    ? { proposedUpdates: [] }
    : skillRegistry.propose_memory_update.run({ answers: safeAnswers });
  const summary: ReflectionSummary = {
    reflectionId: session.id,
    briefSummary: summaryResult.briefSummary,
    keyLearnings: summaryResult.keyLearnings,
    actionables: actionResult.actionables,
    teacherVisible: false,
    promptVersionId: config.id
  };

  return {
    session,
    botMessage: formatCompletionMessage(summary),
    completed: true,
    promptText,
    summary,
    proposedMemoryUpdates: memoryResult.proposedUpdates,
    safetyConcern,
    replyKind: "normal"
  };
}

async function classifySafety(text: string, model?: ModelClient, lane: MessageLane = "stage_answer"): Promise<SafetyClassification> {
  const deterministic = skillRegistry.detect_safety_concern.run({ text });
  if (deterministic.hasConcern || !model) return deterministic;
  if (["low_effort", "off_topic_or_playful", "meta_navigation", "short_confirmation"].includes(lane)) {
    return noSafetyConcern();
  }

  const modelSafety = await model.generateJson({
    task: "safety_classification",
    schema: safetyClassificationSchema,
    fallback: deterministic,
    responseContract: safetyClassificationContract,
    messages: [
      {
        role: "system",
        content:
          "Classify student reflection text for safety. Return JSON only. Be conservative for self-harm, suicide, abuse, immediate danger, and dangerous instructions for weapons or harm."
      },
      { role: "user", content: text }
    ]
  });

  return shouldUseModelSafety(modelSafety) ? modelSafety : noSafetyConcern();
}

async function generateAdaptiveReply(input: {
  model?: ModelClient;
  promptText: string;
  stage: GibbsStage;
  studentMessage: string;
  fallback: string;
  safetyConcern: SafetyClassification;
  recentTurns: ReflectionTurn[];
  answers: Partial<Record<string, string>>;
  preserveFallback?: boolean;
}): Promise<string> {
  const conversationalFallback = input.preserveFallback ? input.fallback : buildPeerCoachFallback(input);
  if (!input.model) return conversationalFallback;

  const schema = z.object({
    stageComplete: z.boolean(),
    reply: z.string().min(1),
    tone: z.enum(["peer_coach", "gentle", "concise", "safety_redirect"]),
    reason: z.string()
  });

  const output = await input.model.generateJson({
    task: "adaptive_reflection_reply",
    schema,
    fallback: {
      stageComplete: false,
      reply: conversationalFallback,
      tone: input.safetyConcern.hasConcern ? "safety_redirect" : "peer_coach",
      reason: "Fallback reply"
    },
    responseContract: adaptiveReplyContract,
    messages: [
      {
        role: "system",
        content: [
          input.promptText,
          "Write one peer-coach Telegram reply, under 320 characters.",
          "Sound warm, casual, and natural. Briefly acknowledge the student's vibe, then ask one focused question.",
          "Do not repeat the exact same wording used in recent turns.",
          "Do not skip the required stage order or ask multiple Gibbs stages at once.",
          "If safety is present, be grounded and gentle; do not sound cheerful or summarize the unsafe statement.",
          "Return JSON with exactly: stageComplete, reply, tone, reason."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          currentStage: input.stage,
          studentMessage: input.studentMessage,
          currentAnswers: input.answers,
          recentTurns: input.recentTurns.slice(-8).map((turn) => ({
            role: turn.role,
            stage: turn.stage,
            content: turn.content
          }))
        })
      }
    ]
  });

  const reply = output.reply?.slice(0, 500) || conversationalFallback;
  return enforceStageAlignedReply(reply, input.stage, conversationalFallback);
}

async function generateContextualReflectionReply(input: {
  model?: ModelClient;
  promptText: string;
  stage: GibbsStage;
  mode: ContextualReplyMode;
  studentMessage: string;
  fallback: string;
  recentTurns: ReflectionTurn[];
  answers: Partial<Record<string, string>>;
  requiredQuestionIntent: string;
  lane: MessageLane;
}): Promise<string> {
  if (!input.model) return input.fallback;

  const schema = z.object({
    reply: z.string().min(1),
    referencedUserContext: z.boolean(),
    questionIntent: z.string(),
    reason: z.string()
  });

  const output = await input.model.generateJson({
    task: "contextual_reflection_reply",
    schema,
    fallback: {
      reply: input.fallback,
      referencedUserContext: false,
      questionIntent: input.requiredQuestionIntent,
      reason: "Fallback reply"
    },
    responseContract: contextualReplyContract,
    messages: [
      {
        role: "system",
        content: [
          input.promptText,
          "You are only wording the bot's next Telegram message. Do not decide stage movement, storage, summary, or safety.",
          "Write under 320 characters. Briefly paraphrase meaningful user context, then ask exactly one focused question.",
          "The question must match the required stage intent. Do not ask a different Gibbs stage question.",
          "Avoid stiff flagposts like 'Got it', 'That helps', 'Okay, staying with that', and literal 'I hear ...' quoting.",
          "If the student text is filler, playful, or off-topic, redirect lightly without repeating the exact filler.",
          "Do not diagnose, moralize, summarize the whole reflection, or say the stage is complete.",
          "Return JSON with exactly: reply, referencedUserContext, questionIntent, reason."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          currentStage: input.stage,
          replyMode: input.mode,
          studentMessage: input.studentMessage,
          currentAnswers: input.answers,
          requiredQuestionIntent: input.requiredQuestionIntent,
          fallbackIfUnsure: input.fallback,
          recentTurns: input.recentTurns.slice(-8).map((turn) => ({
            role: turn.role,
            stage: turn.stage,
            content: turn.content
          })),
          forbiddenBehaviors: [
            "advance the stage",
            "ask multiple questions",
            "ask the wrong Gibbs stage question",
            "repeat filler or meme text literally",
            "summarize the full reflection"
          ]
        })
      }
    ]
  });

  const reply = output.reply?.slice(0, 500) || input.fallback;
  return isValidContextualReply({
    reply,
    stage: input.stage,
    fallback: input.fallback,
    studentMessage: input.studentMessage,
    lane: input.lane
  })
    ? reply
    : input.mode === "loop_repair"
      ? input.fallback
      : stageAlignedFallback(input.stage, input.fallback);
}

export async function evaluateStageSufficiency(input: {
  stage: GibbsStage;
  studentMessage: string;
  answers: Partial<Record<string, string>>;
  recentTurns: ReflectionTurn[];
  model?: ModelClient;
  promptText?: string;
}): Promise<StageSufficiency> {
  const deterministic = deterministicStageSufficiency(input.stage, input.studentMessage, {
    answers: input.answers,
    recentTurns: input.recentTurns
  });
  if (deterministic.confidence >= 0.9 || !input.model) return deterministic;
  const promptText = input.promptText ?? `Current Gibbs stage: ${input.stage}. Stage question: ${stageProbeQuestions[input.stage]}`;

  const schema = z.object({
    stageComplete: z.boolean(),
    confidence: z.number().min(0).max(1),
    missing: z.array(z.string()),
    probeQuestion: z.string(),
    reason: z.string()
  });

  const output = await input.model.generateJson({
    task: "stage_sufficiency",
    schema,
    fallback: deterministic,
    responseContract: stageSufficiencyContract,
    messages: [
      {
        role: "system",
        content: [
          promptText,
          "Judge whether the student's latest answer gives enough useful content for the current Gibbs stage.",
          "Use semantic meaning, not exact keywords. A good answer may be short, casual, or missing words like because, learned, reason, or next time.",
          "High-confidence rejects: greetings, avoidance, filler, meme/joke text, meta-navigation, repeated non-answers, and unrelated text.",
          "Description: accept a concrete event, situation, project, competition, class, conversation, or moment.",
          "People: accept who was involved, including alone, myself, a friend, team, classmate, mentor, or family.",
          "Feelings: accept thoughts or feelings, including one-word real feelings.",
          "Evaluation: accept what went well or badly, including contextual confirmations when the recent turn already contains the substance.",
          "Analysis: accept plausible causes, motives, constraints, beliefs, assumptions, resource or tool effects, overconfidence, time pressure, scope pressure, or explanations of what made it happen, even without causal keywords.",
          "Conclusion: accept takeaways or lessons even without the words learned, learnt, takeaway, or realized.",
          "Action plan: accept concrete next steps even without will, plan, or next time.",
          "If incomplete, return one stage-specific probe question. Return JSON only."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          currentStage: input.stage,
          studentMessage: input.studentMessage,
          currentAnswers: input.answers,
          stageRubric: semanticStageRubric[input.stage],
          recentTurns: input.recentTurns.slice(-8).map((turn) => ({
            role: turn.role,
            stage: turn.stage,
            content: turn.content
          }))
        })
      }
    ]
  });

  return {
    ...output,
    probeQuestion: output.probeQuestion || stageProbeQuestions[input.stage]
  };
}

async function generateSummary(input: {
  model?: ModelClient;
  answers: Partial<Record<string, string>>;
  safetyConcern: SafetyClassification;
}) {
  const fallback = skillRegistry.summarize_reflection.run({ answers: input.answers });
  if (!input.model) return fallback;

  return input.model.generateJson({
    task: "reflection_summary",
    schema: skillRegistry.summarize_reflection.outputSchema,
    fallback,
    responseContract: summaryContract,
    messages: [
      {
        role: "system",
        content:
          "Create a faithful brief student reflection summary and key learnings. Do not quote self-harm or suicide statements. Do not turn unsafe statements into goals or actionables."
      },
      {
        role: "user",
        content: JSON.stringify({
          answers: input.answers,
          safety: input.safetyConcern
        })
      }
    ]
  });
}

function safetyFollowup(stage: GibbsStage): string {
  return `I'm here with you. We can keep this gentle. For now: ${stagePrompts[stage]}`;
}

function dangerousContentRedirect(stage: GibbsStage): string {
  return `I can't help with making weapons or causing harm. If this is connected to something that happened, we can reflect on it safely: ${stagePrompts[stage]}`;
}

function buildPeerCoachFallback(input: {
  stage: GibbsStage;
  studentMessage: string;
  fallback: string;
  recentTurns: ReflectionTurn[];
  safetyConcern: SafetyClassification;
}): string {
  if (input.safetyConcern.hasConcern) return input.fallback;

  const message = input.studentMessage.trim().toLowerCase();
  const prompt = stagePrompts[input.stage];
  const recentStudentShortReplies = input.recentTurns
    .filter((turn) => turn.role === "student" && turn.stage === input.stage)
    .filter((turn) => isLowEffort(turn.content)).length;

  if (isGreeting(message)) {
    return `Hey. Let's stay with this bit for now: ${prompt}`;
  }

  if (isLowEffort(message) && recentStudentShortReplies >= 2) {
    return `No stress. ${stageProbeQuestions[input.stage]}`;
  }

  if (isLowEffort(message)) {
    return `All good. Give me one small detail to work with: ${prompt}`;
  }

  if (/\b(awkward|nervous|anxious|scared|stress|stressed|weird)\b/.test(message)) {
    return `That sounds a bit uncomfortable. ${prompt}`;
  }

  return input.fallback;
}

function deterministicStageSufficiency(
  stage: GibbsStage,
  answer: string,
  context: { answers?: Partial<Record<string, string>>; recentTurns?: ReflectionTurn[] } = {}
): StageSufficiency {
  const normalized = answer.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const incomplete = (missing: string[], probeQuestion = stageProbeQuestions[stage], reason = "Needs more stage-specific detail.", confidence = 0.95): StageSufficiency => ({
    stageComplete: false,
    confidence,
    missing,
    probeQuestion,
    reason
  });
  const complete = (reason: string, confidence = 0.9): StageSufficiency => ({
    stageComplete: true,
    confidence,
    missing: [],
    probeQuestion: stageProbeQuestions[stage],
    reason
  });

  if (isGreeting(normalized)) return incomplete(["stage answer"], stageProbeQuestions[stage], "Greeting does not answer the stage.");
  if (isHardRejectStageAnswer(normalized)) return incomplete(["stage answer"], stageProbeQuestions[stage], "Obvious filler, avoidance, or off-topic text.");

  switch (stage) {
    case "description":
      if (hasAny(normalized, ["attended", "went", "joined", "had", "did", "volunteer", "event", "workshop", "project", "competition", "hackathon", "meeting", "class", "session", "trip", "visited", "helped", "made", "built"])) {
        return complete("Answer names a concrete event or experience.");
      }
      if (isExactLowEffort(normalized)) return incomplete(["specific detail"], stageProbeQuestions.description, "Low-effort answer.");
      return words.length >= 8
        ? incomplete(["concrete event"], "What was the actual event or situation you are reflecting on?", "Long answer still does not name a clear event.", 0.7)
        : incomplete(["what happened"], stageProbeQuestions.description, "Description does not name a clear event.", 0.75);
    case "people":
      if (hasAny(normalized, ["alone", "myself", "solo", "just me", "only me"]) || /\b(with|and|me|classmates|friends|friend|teacher|mentor|team|group|partner|parents|family|cca)\b/.test(normalized)) {
        return complete("Answer identifies who was involved.");
      }
      if (isExactLowEffort(normalized)) return incomplete(["who was involved"], stageProbeQuestions.people, "Low-effort answer.");
      return incomplete(["who was involved"], stageProbeQuestions.people, "People answer is ambiguous.", 0.75);
    case "feelings":
      if (hasAny(normalized, ["felt", "feel", "thought", "happy", "sad", "angry", "nervous", "anxious", "awkward", "excited", "excitement", "tired", "scared", "confident", "worried", "proud", "stress", "stressed", "chill", "rushed", "pressure", "calm", "frustrated"])) {
        return complete("Answer includes a thought or feeling.");
      }
      if (isExactLowEffort(normalized)) return incomplete(["thought or feeling"], stageProbeQuestions.feelings, "Low-effort answer.");
      return incomplete(["thought or feeling"], stageProbeQuestions.feelings, "Feeling answer is ambiguous.", 0.75);
    case "evaluation": {
      const hasEvaluation = hasAny(normalized, ["good", "well", "bad", "hard", "difficult", "struggled", "better", "worse", "worked", "liked", "didn't", "not", "could improve", "able to submit", "unable to submit", "wasn't able"]);
      const directEvaluation = /\b(went|go|was|were)\b.*\b(well|bad|badly|great|poorly|spectacularly)\b/.test(normalized) ||
        /\bsomething\b.*\b(went well|did not|didn't|bad|hard)\b/.test(normalized);
      if (isExactLowEffort(normalized) && !directEvaluation) return incomplete(["what went well or not"], stageProbeQuestions.evaluation, "Low-effort answer.");
      return directEvaluation || (hasEvaluation && words.length >= 5)
        ? complete("Answer evaluates what went well or not so well.", 0.85)
        : incomplete(["what went well or not"], stageProbeQuestions.evaluation, "Evaluation is too thin.", 0.75);
    }
    case "analysis":
      if (isRepeatedStoredStageAnswer("analysis", normalized, context)) {
        return incomplete(["new cause or added detail"], stageProbeQuestions.analysis, "Repeated analysis answer adds no new meaning after prior probing.");
      }
      if (isExactLowEffort(normalized)) return incomplete(["why it happened"], stageProbeQuestions.analysis, "Low-effort answer.");
      return hasAny(normalized, ["because", "why", "reason", "think", "due to", "caused", "happened", "maybe"])
        ? complete("Answer gives a reason or cause.")
        : incomplete(["why it happened"], stageProbeQuestions.analysis, "Analysis needs semantic judgment.", 0.55);
    case "conclusion":
      if (isExactLowEffort(normalized)) return incomplete(["learning"], stageProbeQuestions.conclusion, "Low-effort answer.");
      return hasAny(normalized, ["learned", "learnt", "realized", "understand", "noticed", "takeaway", "now know"]) ||
        isSemanticConclusion(normalized, words)
        ? complete("Answer includes a learning or takeaway.")
        : incomplete(["learning"], stageProbeQuestions.conclusion, "Conclusion needs semantic judgment.", 0.65);
    case "action_plan":
      if (isExactLowEffort(normalized)) return incomplete(["next step"], stageProbeQuestions.action_plan, "Low-effort answer.");
      return hasAny(normalized, ["will", "next time", "try", "plan", "going to", "ask", "prepare", "practice", "do next"]) ||
        isSemanticActionPlan(normalized, words)
        ? complete("Answer includes a next step.")
        : incomplete(["next step"], stageProbeQuestions.action_plan, "Action plan needs semantic judgment.", 0.65);
  }
}

function completeSufficiency(stage: GibbsStage, reason: string): StageSufficiency {
  return {
    stageComplete: true,
    confidence: 1,
    missing: [],
    probeQuestion: stageProbeQuestions[stage],
    reason
  };
}

function decideTurn(input: {
  stage: GibbsStage;
  studentMessage: string;
  recentTurns: ReflectionTurn[];
  safetyConcern: SafetyClassification;
  lane: MessageLane;
}): TurnDecision {
  const normalized = normalizeCasualStageAnswer(input.stage, input.studentMessage);
  if (input.safetyConcern.hasConcern) {
    return {
      kind: "safety_or_danger",
      shouldAdvance: false,
      shouldStore: false,
      repairAction: "safety_redirect",
      replyIntent: "Safety concern takes priority."
    };
  }

  if (isMoveOnIntent(input.studentMessage)) {
    return {
      kind: "skip_or_navigation",
      shouldAdvance: true,
      shouldStore: false,
      repairAction: "skip_stage",
      replyIntent: "Acknowledge the skip and move to the next stage."
    };
  }

  if (input.stage === "evaluation") {
    const previousNegative = findPreviousNegativeEvaluationAnswer(input.recentTurns);
    if (previousNegative && isNegativeEvaluationConfirmation(normalized)) {
      return {
        kind: "short_contextual_answer",
        shouldAdvance: true,
        shouldStore: true,
        answerToStore: previousNegative,
        repairAction: "accept_and_advance",
        replyIntent: "Short contextual confirmation accepts the previous negative evaluation."
      };
    }
    const previousEvaluation = findPreviousMeaningfulStageAnswer("evaluation", input.recentTurns);
    if (previousEvaluation && isAffirmation(normalized)) {
      return {
        kind: "short_contextual_answer",
        shouldAdvance: true,
        shouldStore: true,
        answerToStore: previousEvaluation,
        repairAction: "accept_and_advance",
        replyIntent: "Short contextual confirmation accepts the previous evaluation."
      };
    }
    if (isDirectEvaluationAnswer(normalized)) {
      return {
        kind: "valid_stage_answer",
        shouldAdvance: true,
        shouldStore: true,
        answerToStore: normalized,
        repairAction: "accept_and_advance",
        replyIntent: "Student gave a direct evaluation."
      };
    }
  }

  if (input.stage === "people" && isDirectPeopleAnswer(normalized)) {
    return {
      kind: "valid_stage_answer",
      shouldAdvance: true,
      shouldStore: true,
      answerToStore: normalized,
      repairAction: "accept_and_advance",
      replyIntent: "Student identified who was involved."
    };
  }

  if (input.stage === "feelings" && isRecognizedFeeling(normalized)) {
    return {
      kind: "valid_stage_answer",
      shouldAdvance: true,
      shouldStore: true,
      answerToStore: normalized,
      repairAction: "accept_and_advance",
      replyIntent: "Student gave a clear feeling."
    };
  }

  if (input.lane === "off_topic_or_playful") {
    return {
      kind: "off_topic_or_playful",
      shouldAdvance: false,
      shouldStore: false,
      repairAction: "probe",
      replyIntent: "Lightly redirect to the current reflection stage."
    };
  }

  if (input.lane === "low_effort" || isReactionOrFiller(input.studentMessage)) {
    return {
      kind: "reaction_or_filler",
      shouldAdvance: false,
      shouldStore: false,
      repairAction: "probe",
      replyIntent: "Do not echo filler; ask for one concrete detail."
    };
  }

  return {
    kind: input.lane === "short_confirmation" ? "short_contextual_answer" : "partial_stage_answer",
    shouldAdvance: false,
    shouldStore: true,
    repairAction: "probe",
    replyIntent: "Evaluate the answer against the current Gibbs stage."
  };
}

function normalizeCasualStageAnswer(stage: GibbsStage, answer: string): string {
  const normalized = answer.trim().replace(/\s+/g, " ");
  if (!normalized) return normalized;
  const strippedTokens = normalized
    .split(" ")
    .filter((token) => {
      const lower = stripToken(token).toLowerCase();
      return !["lah", "leh", "lor", "ofc", "pls", "please", "chat"].includes(lower);
    });
  const stripped = strippedTokens.join(" ").trim() || normalized;

  if (stage === "feelings") {
    const lower = stripped.toLowerCase();
    const feeling = recognizedFeelings.find((item) => lower === item || lower.includes(item));
    if (feeling) return feeling;
  }

  return stripped;
}

function stripToken(token: string): string {
  return token.replace(/^[^\w']+|[^\w']+$/g, "");
}

function findPreviousMeaningfulStageAnswer(stage: GibbsStage, recentTurns: ReflectionTurn[]): string | undefined {
  return [...recentTurns]
    .reverse()
    .find((turn) => turn.role === "student" && turn.stage === stage && isMeaningfulForConfirmation(turn.content))
    ?.content;
}

function findPreviousNegativeEvaluationAnswer(recentTurns: ReflectionTurn[]): string | undefined {
  return [...recentTurns]
    .reverse()
    .find((turn) => turn.role === "student" && turn.stage === "evaluation" && isMeaningfulForConfirmation(turn.content) && isEvaluationNegativeish(turn.content))
    ?.content;
}

function isRecognizedFeeling(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return recognizedFeelings.includes(normalized) || recognizedFeelings.some((feeling) => normalized.includes(feeling));
}

function isDirectPeopleAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return hasAny(normalized, ["alone", "myself", "solo", "just me", "only me"]) ||
    /\b(with|and|me|classmates|friends|friend|teacher|mentor|team|group|partner|parents|family|cca)\b/.test(normalized);
}

const recognizedFeelings = [
  "happy",
  "sad",
  "angry",
  "nervous",
  "anxious",
  "awkward",
  "excited",
  "excitement",
  "tired",
  "scared",
  "confident",
  "worried",
  "proud",
  "stress",
  "stressed",
  "chill",
  "rushed",
  "pressure",
  "calm",
  "frustrated"
];

function isDirectEvaluationAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return false;
  if (isExactLowEffort(normalized) && !/^(did not|didn't|didnt|bad|badly|not well)$/.test(normalized)) return false;
  return (
    /\b(went|go|was|were|did)\b.*\b(well|bad|badly|great|poorly|spectacularly|not)\b/.test(normalized) ||
    /\b(did not|didn't|didnt|not good|not well|went wrong|went badly)\b/.test(normalized) ||
    /\bsomething\b.*\b(went well|did not|didn't|bad|hard)\b/.test(normalized)
  );
}

function isNegativeEvaluationConfirmation(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return /^(no|nah|nope|did not|didn't|didnt|not well|bad|badly)$/.test(normalized) || isDirectEvaluationAnswer(normalized) && isEvaluationNegativeish(normalized);
}

function isEvaluationNegativeish(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return hasAny(normalized, [
    "did not",
    "didn't",
    "didnt",
    "not submit",
    "not enough",
    "too many",
    "not well",
    "bad",
    "badly",
    "hard",
    "difficult",
    "struggled",
    "rush",
    "rushed",
    "wrong"
  ]);
}

function skipStageMessage(followingStage: GibbsStage): string {
  return `Skipping that bit. Next: ${stagePrompts[followingStage]}`;
}

function loopRepairMessage(input: {
  currentStage: GibbsStage;
  followingStage: GibbsStage;
  repairedAnswer?: string;
  recentTurns: ReflectionTurn[];
}): string {
  if (input.currentStage === "analysis" && input.repairedAnswer && isMeaningfulStoredAnswer(input.repairedAnswer)) {
    const cause = summarizeLoopRepairCause(input.repairedAnswer);
    return `I think we are circling the same cause: ${cause}. Let's move forward. ${loopRepairNextQuestion(input.followingStage)}`;
  }

  return `I think we are looping, so I will move us forward. Next: ${stagePrompts[input.followingStage]}`;
}

function loopRepairNextQuestion(stage: GibbsStage): string {
  if (stage === "conclusion") return "What are you taking from this?";
  return stagePrompts[stage];
}

function summarizeLoopRepairCause(answer: string): string {
  const cleaned = answer.trim().replace(/\s+/g, " ");
  const withoutTrailingPunctuation = cleaned.replace(/[.!?]+$/g, "");
  return withoutTrailingPunctuation.length > 90
    ? `${withoutTrailingPunctuation.slice(0, 87)}...`
    : withoutTrailingPunctuation;
}

function isSummaryEligible(answers: Partial<Record<string, string>>): boolean {
  const meaningfulAnswers = Object.entries(answers)
    .filter(([, value]) => value && isMeaningfulStoredAnswer(value))
    .length;
  const hasLearningOrAction = Boolean(answers.conclusion && isMeaningfulStoredAnswer(answers.conclusion)) ||
    Boolean(answers.action_plan && isMeaningfulStoredAnswer(answers.action_plan));
  return meaningfulAnswers >= 4 && hasLearningOrAction;
}

function isMeaningfulStoredAnswer(answer: string): boolean {
  const normalized = normalizeCasualStageAnswer("description", answer).trim().toLowerCase();
  return Boolean(normalized) &&
    !isLowEffort(normalized) &&
    !isMoveOnIntent(normalized) &&
    !isReactionOrFiller(normalized) &&
    !isPlayfulOrOffTopic(normalized) &&
    !looksLikeGibberish(normalized);
}

function formatProbeReply(input: {
  stage: GibbsStage;
  studentMessage: string;
  sufficiency: StageSufficiency;
  probeCount: number;
  recentTurns: ReflectionTurn[];
  lane: MessageLane;
}): string {
  const question = input.sufficiency.probeQuestion || stageProbeQuestions[input.stage];
  if (input.lane === "off_topic_or_playful") return formatPlayfulRedirect(input.stage);
  if (isGreeting(input.studentMessage)) return `Hey. ${question}`;
  if (input.probeCount > 0) return formatContextualProbe(input.stage, input.studentMessage, question);
  return `Got it. ${question}`;
}

function forcedMoveMessage(currentStage: GibbsStage, followingStage: GibbsStage, completed: boolean): string {
  if (completed) return stagePrompts[followingStage];
  return `No worries, we can keep moving. ${stagePrompts[followingStage]}`;
}

function countStageProbes(turns: ReflectionTurn[], stage: GibbsStage): number {
  return turns.filter((turn, index) => isStageProbeTurn(turn, stage, turns, index)).length;
}

function isStageProbeTurn(turn: ReflectionTurn, stage: GibbsStage, turns: ReflectionTurn[], index: number): boolean {
  if (turn.role !== "bot" || turn.stage !== stage) return false;
  if (!turn.content.trim().endsWith("?")) return false;
  if (isInitialStageEntryPrompt(stage, turn.content)) return false;
  return !isStageEntryBySequence(turns, index, stage);
}

function isStageEntryBySequence(turns: ReflectionTurn[], index: number, stage: GibbsStage): boolean {
  const previousTurn = turns[index - 1];
  return Boolean(previousTurn && previousTurn.stage !== stage);
}

function isInitialStageEntryPrompt(stage: GibbsStage, content: string): boolean {
  const normalized = normalizePromptForCounting(content);
  return initialStageEntryPrompts[stage].some((prompt) => normalizePromptForCounting(prompt) === normalized);
}

function normalizePromptForCounting(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[^\w'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function isHardRejectStageAnswer(message: string): boolean {
  const normalized = normalizeCasualText(message);
  return (
    isReactionOrFiller(normalized) ||
    isExactLowEffort(normalized) ||
    isLowAgencyPrompt(normalized) ||
    isPlayfulOrOffTopic(normalized) ||
    isMoveOnIntent(normalized)
  );
}

function isRepeatedStoredStageAnswer(
  stage: GibbsStage,
  normalizedAnswer: string,
  context: { answers?: Partial<Record<string, string>>; recentTurns?: ReflectionTurn[] }
): boolean {
  const stored = context.answers?.[stage];
  if (!stored || normalizeCasualText(stored) !== normalizeCasualText(normalizedAnswer)) return false;
  const sameStageProbes = (context.recentTurns ?? []).filter(
    (turn) => turn.role === "bot" && turn.stage === stage && turn.content.trim().endsWith("?")
  ).length;
  return sameStageProbes >= 2;
}

function isGreeting(message: string): boolean {
  return /^(hi|hello|hey|yo|sup|hiya)[!. ]*$/.test(message.trim());
}

function isLowEffort(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return isExactLowEffort(normalized) || isLowAgencyPrompt(normalized) || isReactionOrFiller(normalized);
}

function classifyMessageLane(message: string, stage: GibbsStage, recentTurns: ReflectionTurn[]): MessageLane {
  const normalized = message.trim().toLowerCase();
  const deterministicSafety = skillRegistry.detect_safety_concern.run({ text: message });
  if (deterministicSafety.category === "dangerous_instruction") return "dangerous_instruction";
  if (isCrisisSafety(deterministicSafety)) return "crisis_safety";
  if (isMoveOnIntent(normalized)) return "meta_navigation";
  if (isShortConfirmation(normalized)) return "short_confirmation";
  if (isPlayfulOrOffTopic(normalized)) return "off_topic_or_playful";
  if (isReactionOrFiller(normalized)) return "low_effort";
  if (isExactLowEffort(normalized) || isLowAgencyPrompt(normalized)) return "low_effort";
  if (stage === "evaluation" && resolveStageAnswer({ stage, studentMessage: message, recentTurns }) !== message) return "short_confirmation";
  return "stage_answer";
}

function resolveStageAnswer(input: {
  stage: GibbsStage;
  studentMessage: string;
  recentTurns: ReflectionTurn[];
}): string {
  const normalized = input.studentMessage.trim().toLowerCase();
  if (input.stage !== "evaluation" || !isAffirmation(normalized)) return input.studentMessage;

  const previousStudentTurn = [...input.recentTurns]
    .reverse()
    .find((turn) => turn.role === "student" && turn.stage === input.stage && isMeaningfulForConfirmation(turn.content));
  return previousStudentTurn?.content ?? input.studentMessage;
}

function isMeaningfulForConfirmation(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return !isLowEffort(normalized) && !isMoveOnIntent(normalized) && !isPlayfulOrOffTopic(normalized) && !isReactionOrFiller(normalized);
}

function isStorableForcedAnswer(answer: string, lane: MessageLane): boolean {
  return !["low_effort", "off_topic_or_playful", "meta_navigation", "short_confirmation"].includes(lane) && !isLowEffort(answer) && !isReactionOrFiller(answer);
}

function noSafetyConcern(): SafetyClassification {
  return {
    hasConcern: false,
    level: "none",
    category: "none",
    shouldFlag: false,
    allowNormalSummary: true
  };
}

function isCrisisSafety(safetyConcern: SafetyClassification): boolean {
  return safetyConcern.hasConcern &&
    safetyConcern.shouldFlag &&
    ["high", "crisis"].includes(safetyConcern.level) &&
    ["self_harm", "suicidal_ideation", "abuse_or_harm", "immediate_danger"].includes(safetyConcern.category);
}

function shouldUseModelSafety(safetyConcern: SafetyClassification): boolean {
  if (safetyConcern.category === "dangerous_instruction") return safetyConcern.hasConcern;
  return isCrisisSafety(safetyConcern);
}

function isMoveOnIntent(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\b(move on|next stage|continue|go next|skip this|let'?s move|lets move)\b/.test(normalized) ||
    /\b(repeating yourself|already answered|asked that|same question)\b/.test(normalized)
  );
}

function isShortConfirmation(message: string): boolean {
  return /^(yes|yep|yeah|ya|yup|no|nah|nope|correct|right|true)[!. ]*$/.test(message.trim());
}

function isAffirmation(message: string): boolean {
  return /^(yes|yep|yeah|ya|yup|correct|right|true)[!. ]*$/.test(message.trim());
}

function isLowAgencyPrompt(message: string): boolean {
  return /\b(idk|i don'?t know|dont know|you tell me|u tell me|tell me)\b/.test(message);
}

function isPlayfulOrOffTopic(message: string): boolean {
  return /\b(joe mama|yo mama|your mama|my mama|my momma|momma|mommy|what are you saying|what r u saying|sussy baka)\b/.test(message);
}

function isReactionOrFiller(message: string): boolean {
  const normalized = normalizeCasualText(message);
  if (!normalized) return true;
  if (["bruh", "bro", "lol", "lmao", "haha", "uh", "uhh", "uhhh", "um", "umm", "hmm", "ok", "okay", "k", "j", "meh"].includes(normalized)) return true;
  return looksLikeGibberish(normalized);
}

function normalizeCasualText(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[^\w'\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !["lah", "leh", "lor", "ofc", "pls", "please", "chat"].includes(token))
    .join(" ");
}

function looksLikeGibberish(message: string): boolean {
  const normalized = normalizeCasualText(message);
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/);
  if (tokens.length > 3) return false;
  if (recognizedFeelings.includes(normalized)) return false;
  if (tokens.every((token) => /^[a-z]{1,2}$/.test(token))) return true;
  if (!/[aeiou]/.test(normalized) && normalized.length <= 8) return true;
  return /^[a-z]{4,12}$/.test(normalized) && !/[aeiou]{1,2}/.test(normalized);
}

function isSemanticConclusion(normalized: string, words: string[]): boolean {
  if (words.length < 4) return false;
  return (
    hasAny(normalized, [
      "manage",
      "expectation",
      "under pressure",
      "focus",
      "core feature",
      "start smaller",
      "scope",
      "smaller",
      "ask for help",
      "get help",
      "team",
      "prepare",
      "time",
      "balance",
      "prioritize",
      "communicate"
    ]) || /\b(i|me|my|myself)\b/.test(normalized) && hasAny(normalized, ["need to", "should", "can", "could"])
  );
}

function isSemanticActionPlan(normalized: string, words: string[]): boolean {
  if (words.length < 4) return false;
  return hasAny(normalized, [
    "apply",
    "use this",
    "use them",
    "focus on",
    "start with",
    "start smaller",
    "build",
    "make",
    "work on",
    "reach out",
    "get a team",
    "small team",
    "core feature",
    "manage my time",
    "scope down"
  ]);
}

function formatContextualProbe(stage: GibbsStage, studentMessage: string, fallbackQuestion: string): string {
  const detail = summarizeForProbe(studentMessage);
  const prefix = detail ? `I hear "${detail}". ` : "";

  switch (stage) {
    case "description":
      return detail
        ? `${prefix}What happened at that event? One concrete moment is enough.`
        : "No stress. What is one concrete event or moment you can name?";
    case "people":
      return detail
        ? `${prefix}Who was part of it, even if the answer is just you?`
        : "No stress. Who was involved, even if it was just you?";
    case "feelings":
      return detail
        ? `${prefix}What feeling or thought was strongest in that moment?`
        : "No stress. What was one thought or feeling you remember from it?";
    case "evaluation":
      return detail
        ? `${prefix}Was that something that went well, or something that did not?`
        : "No stress. What was one thing that went well, or one thing that did not?";
    case "analysis":
      return detail
        ? `${prefix}What do you think made it turn out that way?`
        : "No stress. Why do you think it happened that way?";
    case "conclusion":
      return detail
        ? `${prefix}What does that tell you for next time?`
        : "No stress. What is one thing you are taking from it?";
    case "action_plan":
      return detail
        ? `${prefix}What is the smallest next step you would actually take?`
        : "No stress. What is one small next step you want to take?";
    default:
      return `No stress. ${fallbackQuestion}`;
  }
}

function formatPlayfulRedirect(stage: GibbsStage): string {
  switch (stage) {
    case "description":
      return "Haha, staying with the reflection for a sec: what actually happened?";
    case "people":
      return "Haha, staying with the reflection for a sec: who was actually involved?";
    case "feelings":
      return "Haha, back to the reflection: what was one real feeling from it?";
    case "evaluation":
      return "Haha, staying with this: what actually went well or did not?";
    case "analysis":
      return "Haha, back to the reflection: why do you think it turned out that way?";
    case "conclusion":
      return "Haha, staying with it: what are you taking away from this?";
    case "action_plan":
      return "Haha, final bit: what is one small next step you would take?";
  }
}

function summarizeForProbe(message: string): string {
  const cleaned = message.trim().replace(/\s+/g, " ");
  const normalized = cleaned.toLowerCase();
  if (
    !cleaned ||
    isGreeting(cleaned) ||
    isExactLowEffort(cleaned) ||
    isReactionOrFiller(cleaned) ||
    isLowAgencyPrompt(normalized) ||
    isPlayfulOrOffTopic(normalized) ||
    isShortConfirmation(normalized) ||
    isMoveOnIntent(cleaned)
  ) return "";
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function isExactLowEffort(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return ["idk", "i don't know", "dont know", "dunno", "ok", "okay", "uhh", "umm", "meh", "nothing", "not sure", "i guess", "j", "k", "yes", "no"].includes(normalized);
}

function isValidContextualReply(input: {
  reply: string;
  stage: GibbsStage;
  fallback: string;
  studentMessage: string;
  lane: MessageLane;
}): boolean {
  const reply = input.reply.trim();
  const normalized = reply.toLowerCase();
  if (!reply || reply.length > 500) return false;
  if ((reply.match(/\?/g) ?? []).length > 1) return false;
  if (!isStageAlignedReply(reply, input.stage)) return false;
  if (hasAny(normalized, ["stage is complete", "move to the next stage", "i'll mark this", "here is a brief summary"])) return false;

  const studentText = normalizeCasualText(input.studentMessage);
  const shouldAvoidLiteralEcho = input.lane !== "stage_answer" || isReactionOrFiller(input.studentMessage) || isPlayfulOrOffTopic(input.studentMessage.toLowerCase());
  if (shouldAvoidLiteralEcho && studentText && normalized.includes(studentText)) return false;
  if (isReactionOrFiller(input.studentMessage) && hasAny(normalized, ["bruh", "uhh", "umm", " k ", "\"k\"", "\"j\""])) return false;

  return true;
}

function requiredQuestionIntent(stage: GibbsStage): string {
  switch (stage) {
    case "description":
      return "ask for the concrete event or situation";
    case "people":
      return "ask who was involved";
    case "feelings":
      return "ask for one thought or feeling";
    case "evaluation":
      return "ask what went well or did not go well";
    case "analysis":
      return "ask why it happened that way";
    case "conclusion":
      return "ask what the student learned or is taking away";
    case "action_plan":
      return "ask for one small next step";
  }
}

function enforceStageAlignedReply(reply: string, stage: GibbsStage, fallback: string): string {
  if (isStageAlignedReply(reply, stage)) return reply;
  return stageAlignedFallback(stage, fallback);
}

function isStageAlignedReply(reply: string, stage: GibbsStage): boolean {
  const normalized = reply.toLowerCase();
  switch (stage) {
    case "description":
      return hasAny(normalized, ["what happened", "event", "situation", "experience"]);
    case "people":
      return hasAny(normalized, ["who", "with you", "involved", "alone", "solo", "team", "group"]);
    case "feelings":
      return hasAny(normalized, ["feel", "felt", "feeling", "thought", "thinking"]);
    case "evaluation":
      return hasAny(normalized, ["went well", "not go", "did not", "didn't", "successful", "enjoy", "hard", "worked"]);
    case "analysis":
      return hasAny(normalized, ["why", "reason", "caused", "made it", "happened that way", "led"]);
    case "conclusion":
      return hasAny(normalized, ["learn", "learnt", "takeaway", "realize", "tell you", "next time"]);
    case "action_plan":
      return hasAny(normalized, ["next step", "next time", "what will", "will you", "action", "plan", "try"]);
  }
}

function stageAlignedFallback(stage: GibbsStage, fallback: string): string {
  switch (stage) {
    case "people":
      return "Got the event. Who was involved, even if it was just you?";
    case "feelings":
      return "That gives us the setup. What was one thought or feeling you remember from it?";
    case "evaluation":
      return "Okay, staying with that. What was one thing that went well, or one thing that did not?";
    case "analysis":
      return "That helps. Why do you think it happened that way?";
    case "conclusion":
      return "That points to something useful. What does it tell you for next time?";
    case "action_plan":
      return "That sounds like a takeaway. What is one small next step you want to take?";
    default:
      return fallback;
  }
}

const adaptiveReplyContract = {
  type: "object",
  additionalProperties: false,
  required: ["stageComplete", "reply", "tone", "reason"],
  properties: {
    stageComplete: { type: "boolean" },
    reply: { type: "string" },
    tone: { type: "string", enum: ["peer_coach", "gentle", "concise", "safety_redirect"] },
    reason: { type: "string" }
  }
};

const contextualReplyContract = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "referencedUserContext", "questionIntent", "reason"],
  properties: {
    reply: { type: "string" },
    referencedUserContext: { type: "boolean" },
    questionIntent: { type: "string" },
    reason: { type: "string" }
  }
};

const safetyClassificationContract = {
  type: "object",
  additionalProperties: false,
  required: ["hasConcern", "level", "category", "reason", "studentFacingSupport", "shouldFlag", "allowNormalSummary"],
  properties: {
    hasConcern: { type: "boolean" },
    level: { type: "string", enum: ["none", "low", "medium", "high", "crisis"] },
    category: {
      type: "string",
      enum: [
        "none",
        "self_harm",
        "suicidal_ideation",
        "abuse_or_harm",
        "immediate_danger",
        "dangerous_instruction",
        "distress"
      ]
    },
    reason: { type: "string" },
    studentFacingSupport: { type: "string" },
    shouldFlag: { type: "boolean" },
    allowNormalSummary: { type: "boolean" }
  }
};

const stageSufficiencyContract = {
  type: "object",
  additionalProperties: false,
  required: ["stageComplete", "confidence", "missing", "probeQuestion", "reason"],
  properties: {
    stageComplete: { type: "boolean" },
    confidence: { type: "number" },
    missing: { type: "array", items: { type: "string" } },
    probeQuestion: { type: "string" },
    reason: { type: "string" }
  }
};

const summaryContract = {
  type: "object",
  additionalProperties: false,
  required: ["briefSummary", "keyLearnings"],
  properties: {
    briefSummary: { type: "string" },
    keyLearnings: { type: "array", items: { type: "string" } }
  }
};

const stageProbeQuestions: Record<GibbsStage, string> = {
  description: "What was the actual event or situation you want to reflect on?",
  people: "Who was involved, even if it was just you?",
  feelings: "What was one thought or feeling you remember from it?",
  evaluation: "What was one thing that went well, or one thing that did not?",
  analysis: "Why do you think it happened that way?",
  conclusion: "What is one thing you learned from it?",
  action_plan: "What is one small next step you want to take?"
};

const initialStageEntryPrompts: Record<GibbsStage, string[]> = {
  description: [
    stagePrompts.description
  ],
  people: [
    stagePrompts.people,
    "Got the event. Who was involved, even if it was just you?",
    "Thanks for sharing that. Who was around when it happened?"
  ],
  feelings: [
    stagePrompts.feelings,
    "That gives us the setup. What was one thought or feeling you remember from it?"
  ],
  evaluation: [
    stagePrompts.evaluation,
    "Okay, staying with that. What was one thing that went well, or one thing that did not?"
  ],
  analysis: [
    stagePrompts.analysis
  ],
  conclusion: [
    stagePrompts.conclusion,
    "That points to something useful. What does it tell you for next time?"
  ],
  action_plan: [
    stagePrompts.action_plan,
    "That sounds like a takeaway. What is one small next step you want to take?"
  ]
};

const semanticStageRubric: Record<GibbsStage, string> = {
  description: "Enough content names the actual event, situation, project, competition, interaction, or concrete moment.",
  people: "Enough content identifies who was involved, including if the student was alone.",
  feelings: "Enough content gives a real thought or feeling, even as one word.",
  evaluation: "Enough content says what went well, what did not, or gives a clear positive or negative judgment about the experience.",
  analysis: "Enough content explains a plausible cause, motive, constraint, assumption, belief, resource/tool effect, overconfidence, time pressure, or scope pressure behind what happened.",
  conclusion: "Enough content states a lesson, takeaway, realization, or useful implication for next time.",
  action_plan: "Enough content states a concrete next step, behavior change, preparation step, or application for a future similar situation."
};

export function createInitialReflection(studentId: string): ReflectionSession {
  const now = new Date().toISOString();
  return {
    id: createId("refl"),
    studentId,
    currentStage: "description",
    status: "in_progress",
    answers: {},
    safetyFlagged: false,
    createdAt: now,
    updatedAt: now
  };
}

export function formatCompletionMessage(summary: ReflectionSummary): string {
  const actionables = summary.actionables.map((item) => `- ${item}`).join("\n");
  return [`Here is a brief summary of your reflection:`, summary.briefSummary, "", "Actionables:", actionables].join("\n");
}
