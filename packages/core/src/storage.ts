import type { PromptConfig } from "./config.js";
import type {
  ReflectionSession,
  ReflectionSummary,
  ReflectionTurn,
  SafetyConcern,
  StudentMemory,
  StudentProfile
} from "./types.js";

export type TelegramPendingBatchMessage = {
  text: string;
  receivedAt: string;
};

export type TelegramPendingBatchStatus = "pending" | "processing" | "processed" | "cancelled";

export type TelegramPendingBatch = {
  id: string;
  studentId: string;
  reflectionId: string;
  telegramChatId?: string;
  messages: TelegramPendingBatchMessage[];
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  flushAfter: string;
  status: TelegramPendingBatchStatus;
  stale: boolean;
  processingExpiresAt?: string;
  cancellationReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ReflectionStore = {
  getOrCreateStudent(input: { telegramUserId: string; displayName: string }): Promise<StudentProfile>;
  getMemory(studentId: string): Promise<StudentMemory>;
  getActiveConfig(programId?: string): Promise<PromptConfig>;
  createReflection(studentId: string): Promise<ReflectionSession>;
  getReflection(reflectionId: string): Promise<ReflectionSession | null>;
  getLatestOpenReflection(studentId: string): Promise<ReflectionSession | null>;
  saveReflection(session: ReflectionSession): Promise<void>;
  abandonReflection(reflectionId: string): Promise<void>;
  abandonOpenReflections(studentId: string): Promise<void>;
  addTurn(turn: ReflectionTurn): Promise<void>;
  getRecentTurns(reflectionId: string, limit: number): Promise<ReflectionTurn[]>;
  saveSafetyConcern(concern: SafetyConcern): Promise<void>;
  saveSummary(summary: ReflectionSummary): Promise<void>;
  getLatestSummary(studentId: string): Promise<ReflectionSummary | null>;
  appendTelegramPendingBatch(input: {
    studentId: string;
    reflectionId: string;
    telegramChatId?: string;
    text: string;
    receivedAt: string;
    delaySeconds: number;
    staleAfterSeconds: number;
  }): Promise<TelegramPendingBatch>;
  claimReadyTelegramPendingBatches(input: {
    readyAt: string;
    now: string;
    staleAfterSeconds: number;
    processingLeaseSeconds: number;
    limit: number;
  }): Promise<TelegramPendingBatch[]>;
  markTelegramPendingBatchProcessed(batchId: string): Promise<void>;
  releaseTelegramPendingBatch(batchId: string, flushAfter: string): Promise<void>;
  cancelTelegramPendingBatch(input: {
    studentId: string;
    reflectionId: string;
    reason: string;
  }): Promise<void>;
};

export function createId(prefix: string): string {
  void prefix;
  return crypto.randomUUID();
}
