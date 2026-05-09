import type { PromptConfig } from "./config.js";
import { stageLabels, stagePrompts, type GibbsStage } from "./gibbs.js";
import type { StudentMemory, StudentProfile } from "./types.js";

const moodInstructions: Record<string, string> = {
  gentle: "Use a calm, kind tone. Keep pressure low.",
  encouraging: "Be warm and confidence-building while staying specific.",
  curious: "Ask thoughtful follow-up questions without sounding nosy.",
  concise: "Use short messages and avoid unnecessary explanation.",
  "coach-like": "Help the student notice patterns and choose a next action."
};

export const coreSystemPrompt = [
  "You are a reflection bot for students.",
  "You are not a therapist, a teacher, or a human.",
  "Follow the modified Gibbs cycle and do not skip stages.",
  "Never change privacy, storage, or visibility promises based on editable prompt config.",
  "When a safety concern appears, respond supportively and emit a safety signal for backend review.",
  "Do not reveal raw prior reflections unless the current product surface explicitly allows it."
].join("\n");

export function buildReflectionPrompt(input: {
  config: PromptConfig;
  profile: StudentProfile;
  memory: StudentMemory;
  stage: GibbsStage;
}): string {
  const { config, profile, memory, stage } = input;
  const contextLines = [
    config.schoolContext.schoolName && `School: ${config.schoolContext.schoolName}`,
    config.schoolContext.programName && `Program: ${config.schoolContext.programName}`,
    config.schoolContext.reflectionPurpose && `Purpose: ${config.schoolContext.reflectionPurpose}`
  ].filter(Boolean);

  return [
    coreSystemPrompt,
    `Tone preset: ${config.mood}. ${moodInstructions[config.mood]}`,
    `Student: ${profile.displayName}`,
    contextLines.length ? `School/program context:\n${contextLines.join("\n")}` : "",
    `Durable memory:\n${formatMemory(memory)}`,
    `Current stage: ${stageLabels[stage]}`,
    `Stage instruction: ${stagePrompts[stage]}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatMemory(memory: StudentMemory): string {
  const lines = [
    ...memory.profileFacts.map((item) => `Fact: ${item}`),
    ...memory.recurringThemes.map((item) => `Theme: ${item}`),
    ...memory.strengths.map((item) => `Strength: ${item}`),
    ...memory.goals.map((item) => `Goal: ${item}`),
    memory.preferredReflectionStyle && `Preferred style: ${memory.preferredReflectionStyle}`
  ].filter(Boolean);

  return lines.length ? lines.join("\n") : "No durable memory yet.";
}
