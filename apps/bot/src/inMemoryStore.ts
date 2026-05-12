import {
  createId,
  createInitialReflection,
  defaultPromptConfig,
  type PromptConfig,
  type GoogleCalendarAuthLink,
  type GoogleCalendarConnection,
  type GoogleCalendarEvent,
  type GoogleCalendarEventStatus,
  type ReflectionSession,
  type ReflectionStore,
  type ReflectionSummary,
  type TelegramPendingBatch,
  type ReflectionTurn,
  type SafetyConcern,
  type StudentMemory,
  type StudentProfile
} from "@reflection/core";

export class InMemoryReflectionStore implements ReflectionStore {
  private students = new Map<string, StudentProfile>();
  private memories = new Map<string, StudentMemory>();
  private reflections = new Map<string, ReflectionSession>();
  private summaries = new Map<string, ReflectionSummary>();
  private safetyConcerns: SafetyConcern[] = [];
  private turns: ReflectionTurn[] = [];
  private pendingTelegramBatches = new Map<string, TelegramPendingBatch>();
  private googleAuthLinks = new Map<string, GoogleCalendarAuthLink & { tokenHash: string }>();
  private googleConnections = new Map<string, GoogleCalendarConnection & { encryptedRefreshToken: string }>();
  private googleEvents = new Map<string, GoogleCalendarEvent>();
  private config: PromptConfig = defaultPromptConfig;

  async getOrCreateStudent(input: { telegramUserId: string; displayName: string }): Promise<StudentProfile> {
    const existing = this.students.get(input.telegramUserId);
    if (existing) return existing;

    const student: StudentProfile = {
      id: createId("student"),
      telegramUserId: input.telegramUserId,
      displayName: input.displayName
    };
    this.students.set(input.telegramUserId, student);
    this.memories.set(student.id, {
      profileFacts: [],
      recurringThemes: [],
      strengths: [],
      goals: []
    });
    return student;
  }

  async getMemory(studentId: string): Promise<StudentMemory> {
    return (
      this.memories.get(studentId) ?? {
        profileFacts: [],
        recurringThemes: [],
        strengths: [],
        goals: []
      }
    );
  }

  async getActiveConfig(): Promise<PromptConfig> {
    return this.config;
  }

  async createReflection(studentId: string): Promise<ReflectionSession> {
    const session = createInitialReflection(studentId);
    this.reflections.set(session.id, session);
    return session;
  }

  async getReflection(reflectionId: string): Promise<ReflectionSession | null> {
    const session = this.reflections.get(reflectionId);
    return session ? { ...session, answers: { ...session.answers } } : null;
  }

  async getLatestOpenReflection(studentId: string): Promise<ReflectionSession | null> {
    const sessions = [...this.reflections.values()]
      .filter((session) => session.studentId === studentId && session.status === "in_progress")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0] ?? null;
  }

  async saveReflection(session: ReflectionSession): Promise<void> {
    this.reflections.set(session.id, session);
  }

  async abandonReflection(reflectionId: string): Promise<void> {
    const session = this.reflections.get(reflectionId);
    if (!session) return;
    this.reflections.set(reflectionId, {
      ...session,
      status: "abandoned",
      updatedAt: new Date().toISOString()
    });
  }

  async abandonOpenReflections(studentId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const session of this.reflections.values()) {
      if (session.studentId === studentId && session.status === "in_progress") {
        this.reflections.set(session.id, {
          ...session,
          status: "abandoned",
          updatedAt: now
        });
      }
    }
  }

  async addTurn(turn: ReflectionTurn): Promise<void> {
    this.turns.push(turn);
  }

  async getRecentTurns(reflectionId: string, limit: number): Promise<ReflectionTurn[]> {
    return this.turns
      .filter((turn) => turn.reflectionId === reflectionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map((turn) => ({ ...turn }));
  }

  getTurns(): ReflectionTurn[] {
    return [...this.turns];
  }

  getReflections(): ReflectionSession[] {
    return [...this.reflections.values()].map((session) => ({ ...session, answers: { ...session.answers } }));
  }

  async saveSafetyConcern(concern: SafetyConcern): Promise<void> {
    this.safetyConcerns.push(concern);
    const session = this.reflections.get(concern.reflectionId);
    if (session) {
      this.reflections.set(session.id, { ...session, safetyFlagged: true });
    }
  }

  getSafetyConcerns(): SafetyConcern[] {
    return [...this.safetyConcerns];
  }

  async saveSummary(summary: ReflectionSummary): Promise<void> {
    this.summaries.set(summary.reflectionId, summary);
  }

  async getLatestSummary(studentId: string): Promise<ReflectionSummary | null> {
    const reflectionIds = [...this.reflections.values()]
      .filter((session) => session.studentId === studentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => session.id);

    for (const reflectionId of reflectionIds) {
      const summary = this.summaries.get(reflectionId);
      if (summary) return summary;
    }
    return null;
  }

  async appendTelegramPendingBatch(input: {
    studentId: string;
    reflectionId: string;
    telegramChatId?: string;
    text: string;
    receivedAt: string;
    delaySeconds: number;
    staleAfterSeconds: number;
  }): Promise<TelegramPendingBatch> {
    const now = new Date().toISOString();
    const flushAfter = addSeconds(input.receivedAt, input.delaySeconds);
    const existing = [...this.pendingTelegramBatches.values()].find(
      (batch) =>
        batch.studentId === input.studentId &&
        batch.reflectionId === input.reflectionId &&
        batch.status === "pending"
    );

    if (existing) {
      const updated: TelegramPendingBatch = {
        ...existing,
        telegramChatId: input.telegramChatId ?? existing.telegramChatId,
        messages: [...existing.messages, { text: input.text, receivedAt: input.receivedAt }],
        messageCount: existing.messageCount + 1,
        lastMessageAt: input.receivedAt,
        flushAfter,
        stale: isOlderThan(existing.firstMessageAt, input.receivedAt, input.staleAfterSeconds),
        updatedAt: now
      };
      this.pendingTelegramBatches.set(updated.id, updated);
      return cloneBatch(updated);
    }

    const batch: TelegramPendingBatch = {
      id: createId("telegram_batch"),
      studentId: input.studentId,
      reflectionId: input.reflectionId,
      telegramChatId: input.telegramChatId,
      messages: [{ text: input.text, receivedAt: input.receivedAt }],
      messageCount: 1,
      firstMessageAt: input.receivedAt,
      lastMessageAt: input.receivedAt,
      flushAfter,
      status: "pending",
      stale: isOlderThan(input.receivedAt, now, input.staleAfterSeconds),
      createdAt: now,
      updatedAt: now
    };
    this.pendingTelegramBatches.set(batch.id, batch);
    return cloneBatch(batch);
  }

  async claimReadyTelegramPendingBatches(input: {
    readyAt: string;
    now: string;
    staleAfterSeconds: number;
    processingLeaseSeconds: number;
    limit: number;
  }): Promise<TelegramPendingBatch[]> {
    const leaseExpiresAt = addSeconds(input.now, input.processingLeaseSeconds);
    const ready = [...this.pendingTelegramBatches.values()]
      .filter((batch) =>
        (batch.status === "pending" && batch.flushAfter <= input.readyAt) ||
        (batch.status === "processing" && batch.processingExpiresAt !== undefined && batch.processingExpiresAt <= input.now)
      )
      .sort((a, b) => a.flushAfter.localeCompare(b.flushAfter))
      .slice(0, input.limit);

    return ready.map((batch) => {
      const processing = {
        ...batch,
        status: "processing" as const,
        stale: batch.stale || isOlderThan(batch.lastMessageAt, input.now, input.staleAfterSeconds),
        processingExpiresAt: leaseExpiresAt,
        updatedAt: input.now
      };
      this.pendingTelegramBatches.set(batch.id, processing);
      return cloneBatch(processing);
    });
  }

  async markTelegramPendingBatchProcessed(batchId: string): Promise<void> {
    const batch = this.pendingTelegramBatches.get(batchId);
    if (!batch) return;
    this.pendingTelegramBatches.set(batchId, {
      ...batch,
      status: "processed",
      processingExpiresAt: undefined,
      updatedAt: new Date().toISOString()
    });
  }

  async releaseTelegramPendingBatch(batchId: string, flushAfter: string): Promise<void> {
    const batch = this.pendingTelegramBatches.get(batchId);
    if (!batch) return;
    this.pendingTelegramBatches.set(batchId, {
      ...batch,
      status: "pending",
      flushAfter,
      processingExpiresAt: undefined,
      updatedAt: new Date().toISOString()
    });
  }

  async cancelTelegramPendingBatch(input: {
    studentId: string;
    reflectionId: string;
    reason: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    for (const batch of this.pendingTelegramBatches.values()) {
      if (batch.studentId === input.studentId && batch.reflectionId === input.reflectionId && (batch.status === "pending" || batch.status === "processing")) {
        this.pendingTelegramBatches.set(batch.id, {
          ...batch,
          status: "cancelled",
          cancellationReason: input.reason,
          processingExpiresAt: undefined,
          updatedAt: now
        });
      }
    }
  }

  getTelegramPendingBatches(): TelegramPendingBatch[] {
    return [...this.pendingTelegramBatches.values()].map(cloneBatch);
  }

  async createGoogleCalendarAuthLink(input: {
    studentId: string;
    telegramUserId: string;
    telegramChatId?: string;
    tokenHash: string;
    state: string;
    expiresAt: string;
  }): Promise<GoogleCalendarAuthLink> {
    const link = {
      id: createId("google_calendar_auth_link"),
      studentId: input.studentId,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      tokenHash: input.tokenHash,
      state: input.state,
      expiresAt: input.expiresAt,
      createdAt: new Date().toISOString()
    };
    this.googleAuthLinks.set(link.id, link);
    return cloneGoogleCalendarAuthLink(link);
  }

  async getValidGoogleCalendarAuthLinkByTokenHash(input: {
    tokenHash: string;
    now: string;
  }): Promise<GoogleCalendarAuthLink | null> {
    const link = [...this.googleAuthLinks.values()].find((item) => item.tokenHash === input.tokenHash);
    return link && !link.usedAt && link.expiresAt > input.now ? cloneGoogleCalendarAuthLink(link) : null;
  }

  async consumeGoogleCalendarAuthLinkByState(input: {
    state: string;
    now: string;
    usedAt: string;
  }): Promise<GoogleCalendarAuthLink | null> {
    const link = [...this.googleAuthLinks.values()].find((item) => item.state === input.state);
    if (!link || link.usedAt || link.expiresAt <= input.now) return null;
    const consumed = { ...link, usedAt: input.usedAt };
    this.googleAuthLinks.set(link.id, consumed);
    return cloneGoogleCalendarAuthLink(consumed);
  }

  async getGoogleCalendarConnection(studentId: string): Promise<GoogleCalendarConnection | null> {
    const connection = this.googleConnections.get(studentId);
    return connection ? cloneGoogleCalendarConnection(connection) : null;
  }

  async saveGoogleCalendarConnection(input: {
    studentId: string;
    googleSub: string;
    googleEmail: string;
    scopes: string[];
    encryptedRefreshToken: string;
    calendarId: string;
    connectedAt: string;
  }): Promise<GoogleCalendarConnection> {
    const connection = {
      studentId: input.studentId,
      googleSub: input.googleSub,
      googleEmail: input.googleEmail,
      scopes: [...input.scopes],
      encryptedRefreshToken: input.encryptedRefreshToken,
      calendarId: input.calendarId,
      status: "active" as const,
      connectedAt: input.connectedAt,
      updatedAt: input.connectedAt
    };
    this.googleConnections.set(input.studentId, connection);
    return cloneGoogleCalendarConnection(connection);
  }

  async getEncryptedGoogleCalendarRefreshToken(studentId: string): Promise<string | null> {
    const connection = this.googleConnections.get(studentId);
    return connection?.status === "active" ? connection.encryptedRefreshToken : null;
  }

  async markGoogleCalendarConnectionNeedsReauth(studentId: string): Promise<void> {
    const connection = this.googleConnections.get(studentId);
    if (!connection) return;
    this.googleConnections.set(studentId, {
      ...connection,
      status: "needs_reauth",
      updatedAt: new Date().toISOString()
    });
  }

  async disconnectGoogleCalendarConnection(studentId: string): Promise<void> {
    const connection = this.googleConnections.get(studentId);
    if (!connection) return;
    const now = new Date().toISOString();
    this.googleConnections.set(studentId, {
      ...connection,
      encryptedRefreshToken: "",
      status: "disconnected",
      revokedAt: now,
      updatedAt: now
    });
  }

  async upsertGoogleCalendarEvent(input: {
    studentId: string;
    googleEventId: string;
    calendarId: string;
    sourceKind: string;
    sourceId?: string;
    lastSyncedPayload: Record<string, unknown>;
    status: GoogleCalendarEventStatus;
  }): Promise<GoogleCalendarEvent> {
    const id = `${input.studentId}:${input.calendarId}:${input.googleEventId}`;
    const existing = this.googleEvents.get(id);
    const now = new Date().toISOString();
    const event = {
      id: existing?.id ?? createId("google_calendar_event"),
      studentId: input.studentId,
      googleEventId: input.googleEventId,
      calendarId: input.calendarId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      lastSyncedPayload: { ...input.lastSyncedPayload },
      status: input.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.googleEvents.set(id, event);
    return cloneGoogleCalendarEvent(event);
  }
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function isOlderThan(firstIso: string, lastIso: string, seconds: number): boolean {
  return new Date(lastIso).getTime() - new Date(firstIso).getTime() > seconds * 1000;
}

function cloneBatch(batch: TelegramPendingBatch): TelegramPendingBatch {
  return {
    ...batch,
    messages: batch.messages.map((message) => ({ ...message }))
  };
}

function cloneGoogleCalendarAuthLink(
  link: GoogleCalendarAuthLink & { tokenHash?: string }
): GoogleCalendarAuthLink {
  return {
    id: link.id,
    studentId: link.studentId,
    telegramUserId: link.telegramUserId,
    telegramChatId: link.telegramChatId,
    state: link.state,
    expiresAt: link.expiresAt,
    usedAt: link.usedAt,
    createdAt: link.createdAt
  };
}

function cloneGoogleCalendarConnection(
  connection: GoogleCalendarConnection & { encryptedRefreshToken?: string }
): GoogleCalendarConnection {
  return {
    studentId: connection.studentId,
    googleSub: connection.googleSub,
    googleEmail: connection.googleEmail,
    scopes: [...connection.scopes],
    calendarId: connection.calendarId,
    status: connection.status,
    connectedAt: connection.connectedAt,
    updatedAt: connection.updatedAt,
    revokedAt: connection.revokedAt
  };
}

function cloneGoogleCalendarEvent(event: GoogleCalendarEvent): GoogleCalendarEvent {
  return {
    ...event,
    lastSyncedPayload: { ...event.lastSyncedPayload }
  };
}
