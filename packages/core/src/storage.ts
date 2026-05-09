import type { PromptConfig } from "./config.js";
import type {
  ReflectionSession,
  ReflectionSummary,
  ReflectionTurn,
  SafetyConcern,
  StudentMemory,
  StudentProfile
} from "./types.js";

export type ReflectionStore = {
  getOrCreateStudent(input: { telegramUserId: string; displayName: string }): Promise<StudentProfile>;
  getMemory(studentId: string): Promise<StudentMemory>;
  getActiveConfig(programId?: string): Promise<PromptConfig>;
  createReflection(studentId: string): Promise<ReflectionSession>;
  getLatestOpenReflection(studentId: string): Promise<ReflectionSession | null>;
  saveReflection(session: ReflectionSession): Promise<void>;
  abandonReflection(reflectionId: string): Promise<void>;
  abandonOpenReflections(studentId: string): Promise<void>;
  addTurn(turn: ReflectionTurn): Promise<void>;
  getRecentTurns(reflectionId: string, limit: number): Promise<ReflectionTurn[]>;
  saveSafetyConcern(concern: SafetyConcern): Promise<void>;
  saveSummary(summary: ReflectionSummary): Promise<void>;
  getLatestSummary(studentId: string): Promise<ReflectionSummary | null>;
};

export function createId(prefix: string): string {
  void prefix;
  return crypto.randomUUID();
}
