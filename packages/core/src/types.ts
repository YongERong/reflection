import { z } from "zod";
import { gibbsStageSchema } from "./gibbs.js";

export const moodPresetSchema = z.enum([
  "gentle",
  "encouraging",
  "curious",
  "concise",
  "coach-like"
]);

export type MoodPreset = z.infer<typeof moodPresetSchema>;

export const roleSchema = z.enum(["student", "teacher", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const studentProfileSchema = z.object({
  id: z.string(),
  telegramUserId: z.string().optional(),
  displayName: z.string(),
  classId: z.string().optional(),
  programId: z.string().optional()
});

export type StudentProfile = z.infer<typeof studentProfileSchema>;

export const studentMemorySchema = z.object({
  profileFacts: z.array(z.string()).default([]),
  recurringThemes: z.array(z.string()).default([]),
  strengths: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  preferredReflectionStyle: z.string().optional()
});

export type StudentMemory = z.infer<typeof studentMemorySchema>;

export const reflectionTurnSchema = z.object({
  id: z.string(),
  reflectionId: z.string(),
  role: z.enum(["student", "bot"]),
  content: z.string(),
  stage: gibbsStageSchema,
  createdAt: z.string()
});

export type ReflectionTurn = z.infer<typeof reflectionTurnSchema>;

export const gibbsAnswersSchema = z
  .object({
    description: z.string(),
    people: z.string(),
    feelings: z.string(),
    evaluation: z.string(),
    analysis: z.string(),
    conclusion: z.string(),
    action_plan: z.string()
  })
  .partial();

export type GibbsAnswers = z.infer<typeof gibbsAnswersSchema>;

export const reflectionSessionSchema = z.object({
  id: z.string(),
  studentId: z.string(),
  currentStage: gibbsStageSchema,
  status: z.enum(["in_progress", "completed"]),
  answers: gibbsAnswersSchema,
  safetyFlagged: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type ReflectionSession = z.infer<typeof reflectionSessionSchema>;

export const safetyConcernStatusSchema = z.enum(["open", "reviewed", "resolved"]);
export type SafetyConcernStatus = z.infer<typeof safetyConcernStatusSchema>;

export const safetyConcernSchema = z.object({
  id: z.string(),
  reflectionId: z.string(),
  studentId: z.string(),
  stage: gibbsStageSchema,
  studentTurnId: z.string(),
  reason: z.string(),
  messageSnippet: z.string(),
  status: safetyConcernStatusSchema,
  createdAt: z.string()
});

export type SafetyConcern = z.infer<typeof safetyConcernSchema>;

export const reflectionSummarySchema = z.object({
  reflectionId: z.string(),
  briefSummary: z.string(),
  actionables: z.array(z.string()),
  keyLearnings: z.array(z.string()),
  teacherVisible: z.boolean(),
  promptVersionId: z.string()
});

export type ReflectionSummary = z.infer<typeof reflectionSummarySchema>;
