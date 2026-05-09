import { z } from "zod";
import { moodPresetSchema } from "./types.js";

export const promptConfigSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  mood: moodPresetSchema.default("gentle"),
  startingMessageTemplate: z
    .string()
    .max(500)
    .default("Hi {{studentName}}, let us reflect on your recent experience together."),
  schoolContext: z
    .object({
      schoolName: z.string().max(120).optional(),
      programName: z.string().max(120).optional(),
      reflectionPurpose: z.string().max(500).optional()
    })
    .default({}),
  summaryFormat: z
    .enum(["brief", "bullet_actionables", "teacher_friendly"])
    .default("bullet_actionables"),
  enabledSkills: z.array(z.string()).default([
    "ask_next_gibbs_question",
    "summarize_reflection",
    "extract_actionables",
    "propose_memory_update",
    "detect_safety_concern",
    "generate_teacher_summary"
  ])
});

export type PromptConfig = z.infer<typeof promptConfigSchema>;

export const defaultPromptConfig: PromptConfig = promptConfigSchema.parse({
  id: "default",
  version: 1
});

export function renderStartingMessage(config: PromptConfig, studentName: string): string {
  return config.startingMessageTemplate
    .replaceAll("{{studentName}}", studentName)
    .replaceAll("{{programName}}", config.schoolContext.programName ?? "this program")
    .trim();
}
