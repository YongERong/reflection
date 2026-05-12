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

export type GoogleCalendarAuthLink = {
  id: string;
  studentId: string;
  telegramUserId: string;
  telegramChatId?: string;
  state: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
};

export type GoogleCalendarConnectionStatus = "active" | "needs_reauth" | "disconnected";

export type GoogleCalendarConnection = {
  studentId: string;
  googleSub: string;
  googleEmail: string;
  scopes: string[];
  calendarId: string;
  status: GoogleCalendarConnectionStatus;
  connectedAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type GoogleCalendarEventStatus = "active" | "cancelled" | "sync_failed";

export type GoogleCalendarEvent = {
  id: string;
  studentId: string;
  googleEventId: string;
  calendarId: string;
  sourceKind: string;
  sourceId?: string;
  lastSyncedPayload: Record<string, unknown>;
  status: GoogleCalendarEventStatus;
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
  createGoogleCalendarAuthLink(input: {
    studentId: string;
    telegramUserId: string;
    telegramChatId?: string;
    tokenHash: string;
    state: string;
    expiresAt: string;
  }): Promise<GoogleCalendarAuthLink>;
  getValidGoogleCalendarAuthLinkByTokenHash(input: {
    tokenHash: string;
    now: string;
  }): Promise<GoogleCalendarAuthLink | null>;
  consumeGoogleCalendarAuthLinkByState(input: {
    state: string;
    now: string;
    usedAt: string;
  }): Promise<GoogleCalendarAuthLink | null>;
  getGoogleCalendarConnection(studentId: string): Promise<GoogleCalendarConnection | null>;
  saveGoogleCalendarConnection(input: {
    studentId: string;
    googleSub: string;
    googleEmail: string;
    scopes: string[];
    encryptedRefreshToken: string;
    calendarId: string;
    connectedAt: string;
  }): Promise<GoogleCalendarConnection>;
  getEncryptedGoogleCalendarRefreshToken(studentId: string): Promise<string | null>;
  markGoogleCalendarConnectionNeedsReauth(studentId: string): Promise<void>;
  disconnectGoogleCalendarConnection(studentId: string): Promise<void>;
  upsertGoogleCalendarEvent(input: {
    studentId: string;
    googleEventId: string;
    calendarId: string;
    sourceKind: string;
    sourceId?: string;
    lastSyncedPayload: Record<string, unknown>;
    status: GoogleCalendarEventStatus;
  }): Promise<GoogleCalendarEvent>;
};

export function createId(prefix: string): string {
  void prefix;
  return crypto.randomUUID();
}
