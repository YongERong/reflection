import { defaultPromptConfig, type PromptConfig } from "./config.js";
import { gibbsStageSchema, isStageAnswerSubstantial, nextStage, stagePrompts, type GibbsStage } from "./gibbs.js";
import { buildReflectionPrompt } from "./prompts.js";
import { skillRegistry } from "./skills.js";
import { createId } from "./storage.js";
import type { ReflectionSession, ReflectionSummary, StudentMemory, StudentProfile } from "./types.js";

export type AgentTurnInput = {
  profile: StudentProfile;
  memory?: StudentMemory;
  config?: PromptConfig;
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
  safetyConcern: { hasConcern: boolean; reason?: string };
};

export const fixedSafetySupportMessage =
  "I am really sorry you are dealing with that. If you might be in immediate danger, please contact a trusted adult or local emergency support now. We can keep reflecting, but your safety matters first.";

export function handleReflectionTurn(input: AgentTurnInput): AgentTurnOutput {
  const memory = input.memory ?? {
    profileFacts: [],
    recurringThemes: [],
    strengths: [],
    goals: []
  };
  const config = input.config ?? defaultPromptConfig;
  const stage = gibbsStageSchema.parse(input.session.currentStage);
  const now = new Date().toISOString();
  const session: ReflectionSession = {
    ...input.session,
    answers: {
      ...input.session.answers,
      [stage]: input.studentMessage.trim()
    },
    updatedAt: now
  };
  const promptText = buildReflectionPrompt({ config, profile: input.profile, memory, stage });
  const safetyConcern = skillRegistry.detect_safety_concern.run({ text: input.studentMessage });
  session.safetyFlagged = input.session.safetyFlagged || safetyConcern.hasConcern;

  if (!isStageAnswerSubstantial(input.studentMessage)) {
    return {
      session,
      botMessage: `Thanks. Could you share a little more? ${stagePrompts[stage]}`,
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern
    };
  }

  const followingStage = nextStage(stage);
  if (followingStage) {
    session.currentStage = followingStage;
    return {
      session,
      botMessage: stagePrompts[followingStage],
      completed: false,
      promptText,
      proposedMemoryUpdates: [],
      safetyConcern
    };
  }

  session.status = "completed";
  const summaryResult = skillRegistry.summarize_reflection.run({ answers: session.answers });
  const actionResult = skillRegistry.extract_actionables.run({ answers: session.answers });
  const memoryResult = skillRegistry.propose_memory_update.run({ answers: session.answers });
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
    safetyConcern
  };
}

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
