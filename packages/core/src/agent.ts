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

export const fixedSafetySupportMessage =
  "I am really sorry you are dealing with that. If you might be in immediate danger, please contact a trusted adult or local emergency support now. We can keep reflecting, but your safety matters first.";

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
  const safetyConcern = await classifySafety(input.studentMessage, input.model);

  if (safetyConcern.category === "dangerous_instruction") {
    return {
      session: {
        ...input.session,
        safetyFlagged: true,
        updatedAt: now
      },
      botMessage: dangerousContentRedirect(stage),
      completed: false,
      promptText: buildReflectionPrompt({ config, profile: input.profile, memory, stage }),
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: "safety_followup"
    };
  }

  const promptText = buildReflectionPrompt({ config, profile: input.profile, memory, stage });
  const recentTurns = input.recentTurns ?? [];
  const safetyBypassesSufficiency = safetyConcern.hasConcern;
  const sufficiency = safetyBypassesSufficiency
    ? completeSufficiency(stage, "Safety concern path keeps the reflection moving after support.")
    : await evaluateStageSufficiency({
        stage,
        studentMessage: input.studentMessage,
        answers: input.session.answers,
        recentTurns,
        model: input.model,
        promptText
      });
  const probeCount = countStageProbes(recentTurns, stage);
  const shouldMoveOn = sufficiency.stageComplete || probeCount >= 2;
  const forcedMove = !sufficiency.stageComplete && probeCount >= 2;
  const shouldStoreAnswer = safetyBypassesSufficiency || sufficiency.stageComplete || (forcedMove && !isLowEffort(input.studentMessage));
  const session: ReflectionSession = {
    ...input.session,
    answers: shouldStoreAnswer
      ? {
          ...input.session.answers,
          [stage]: input.studentMessage.trim()
        }
      : { ...input.session.answers },
    updatedAt: now
  };
  session.safetyFlagged = input.session.safetyFlagged || safetyConcern.hasConcern;

  if (!shouldMoveOn) {
    const botMessage = formatProbeReply({
      stage,
      studentMessage: input.studentMessage,
      sufficiency,
      probeCount
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
      : forcedMoveMessage(stage, followingStage, sufficiency.stageComplete);
    return {
      session,
      botMessage: await generateAdaptiveReply({
        model: input.model,
        promptText,
        stage: followingStage,
        studentMessage: input.studentMessage,
        fallback,
        safetyConcern,
        recentTurns,
        answers: session.answers,
        preserveFallback: !sufficiency.stageComplete || safetyConcern.hasConcern
      }),
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern,
      replyKind: safetyConcern.hasConcern ? "safety_followup" : "normal"
    };
  }

  session.status = "completed";
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

async function classifySafety(text: string, model?: ModelClient): Promise<SafetyClassification> {
  const deterministic = skillRegistry.detect_safety_concern.run({ text });
  if (deterministic.hasConcern || !model) return deterministic;

  return model.generateJson({
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

  return output.reply?.slice(0, 500) || conversationalFallback;
}

async function evaluateStageSufficiency(input: {
  stage: GibbsStage;
  studentMessage: string;
  answers: Partial<Record<string, string>>;
  recentTurns: ReflectionTurn[];
  model?: ModelClient;
  promptText: string;
}): Promise<StageSufficiency> {
  const deterministic = deterministicStageSufficiency(input.stage, input.studentMessage);
  if (deterministic.confidence >= 0.9 || !input.model) return deterministic;

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
          input.promptText,
          "Judge whether the student's latest answer gives enough useful content for the current Gibbs stage.",
          "Do not advance for greetings, avoidance, obvious off-topic text, or answers that do not address the stage.",
          "Short answers can be complete when they clearly answer the stage, especially People and Feelings.",
          "If incomplete, return one stage-specific probe question. Return JSON only."
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

function deterministicStageSufficiency(stage: GibbsStage, answer: string): StageSufficiency {
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

  switch (stage) {
    case "description":
      if (isLowEffort(normalized)) return incomplete(["specific detail"], stageProbeQuestions.description, "Low-effort answer.");
      if (hasAny(normalized, ["attended", "went", "joined", "had", "did", "volunteer", "event", "workshop", "project", "competition", "meeting", "class", "session", "trip", "visited", "helped", "made", "built"])) {
        return complete("Answer names a concrete event or experience.");
      }
      return words.length >= 8
        ? incomplete(["concrete event"], "What was the actual event or situation you are reflecting on?", "Long answer still does not name a clear event.", 0.7)
        : incomplete(["what happened"], stageProbeQuestions.description, "Description does not name a clear event.", 0.75);
    case "people":
      if (hasAny(normalized, ["alone", "myself", "solo"]) || /\b(with|and|classmates|friends|friend|teacher|mentor|team|group|partner|parents|family|cca)\b/.test(normalized)) {
        return complete("Answer identifies who was involved.");
      }
      if (isLowEffort(normalized)) return incomplete(["who was involved"], stageProbeQuestions.people, "Low-effort answer.");
      return incomplete(["who was involved"], stageProbeQuestions.people);
    case "feelings":
      if (hasAny(normalized, ["felt", "feel", "thought", "happy", "sad", "angry", "nervous", "anxious", "awkward", "excited", "scared", "confident", "worried", "proud", "stressed", "calm", "frustrated"])) {
        return complete("Answer includes a thought or feeling.");
      }
      if (isLowEffort(normalized)) return incomplete(["thought or feeling"], stageProbeQuestions.feelings, "Low-effort answer.");
      return incomplete(["thought or feeling"], stageProbeQuestions.feelings);
    case "evaluation": {
      if (isLowEffort(normalized)) return incomplete(["what went well or not"], stageProbeQuestions.evaluation, "Low-effort answer.");
      const hasEvaluation = hasAny(normalized, ["good", "well", "bad", "hard", "difficult", "struggled", "better", "worse", "worked", "didn't", "not", "could improve"]);
      return hasEvaluation && words.length >= 5
        ? complete("Answer evaluates what went well or not so well.", 0.85)
        : incomplete(["what went well or not"], stageProbeQuestions.evaluation, "Evaluation is too thin.");
    }
    case "analysis":
      if (isLowEffort(normalized)) return incomplete(["why it happened"], stageProbeQuestions.analysis, "Low-effort answer.");
      return hasAny(normalized, ["because", "why", "reason", "think", "due to", "caused", "happened", "maybe"])
        ? complete("Answer gives a reason or cause.")
        : incomplete(["why it happened"], stageProbeQuestions.analysis, "Analysis does not explain why it happened.", 0.75);
    case "conclusion":
      if (isLowEffort(normalized)) return incomplete(["learning"], stageProbeQuestions.conclusion, "Low-effort answer.");
      return hasAny(normalized, ["learned", "learnt", "realized", "understand", "noticed", "takeaway", "now know"])
        ? complete("Answer includes a learning or takeaway.")
        : incomplete(["learning"], stageProbeQuestions.conclusion);
    case "action_plan":
      if (isLowEffort(normalized)) return incomplete(["next step"], stageProbeQuestions.action_plan, "Low-effort answer.");
      return hasAny(normalized, ["will", "next time", "try", "plan", "going to", "ask", "prepare", "practice", "do next"])
        ? complete("Answer includes a next step.")
        : incomplete(["next step"], stageProbeQuestions.action_plan);
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

function formatProbeReply(input: {
  stage: GibbsStage;
  studentMessage: string;
  sufficiency: StageSufficiency;
  probeCount: number;
}): string {
  const question = input.sufficiency.probeQuestion || stageProbeQuestions[input.stage];
  if (isGreeting(input.studentMessage)) return `Hey. ${question}`;
  return input.probeCount === 0 ? `Got it. ${question}` : `No stress. ${question}`;
}

function forcedMoveMessage(currentStage: GibbsStage, followingStage: GibbsStage, completed: boolean): string {
  if (completed) return stagePrompts[followingStage];
  return `No worries, we can keep moving. ${stagePrompts[followingStage]}`;
}

function countStageProbes(turns: ReflectionTurn[], stage: GibbsStage): number {
  const probePrefixes = ["Got it. ", "No stress. ", "Hey. "];
  return turns.filter((turn) => {
    if (turn.role !== "bot" || turn.stage !== stage) return false;
    return probePrefixes.some((prefix) => turn.content.startsWith(prefix)) && turn.content.trim().endsWith("?");
  }).length;
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function isGreeting(message: string): boolean {
  return /^(hi|hello|hey|yo|sup|hiya)[!. ]*$/.test(message.trim());
}

function isLowEffort(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const exactLowEffort = ["idk", "i don't know", "dont know", "dunno", "ok", "okay", "uhh", "umm", "meh", "nothing", "not sure"];
  return words.length < 4 || exactLowEffort.includes(normalized);
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
