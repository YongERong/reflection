import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createInitialReflection,
  defaultPromptConfig,
  type GoogleCalendarAuthLink,
  type GoogleCalendarConnection,
  type GoogleCalendarEvent,
  type GoogleCalendarEventStatus,
  type PromptConfig,
  type ReflectionSession,
  type ReflectionStore,
  type ReflectionSummary,
  type TelegramPendingBatch,
  type TelegramPendingBatchMessage,
  type ReflectionTurn,
  type SafetyConcern,
  type StudentMemory,
  type StudentProfile
} from "@reflection/core";

type JsonRecord = Record<string, unknown>;

export class SupabaseReflectionStore implements ReflectionStore {
  private client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    const { error } = await this.client.from("student_profiles").select("id").limit(1);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async getOrCreateStudent(input: { telegramUserId: string; displayName: string }): Promise<StudentProfile> {
    const { data: existing, error: selectError } = await this.client
      .from("student_profiles")
      .select("id, telegram_user_id, display_name, class_id, program_id")
      .eq("telegram_user_id", input.telegramUserId)
      .maybeSingle();

    if (selectError) throw new Error(`Failed to load student profile: ${selectError.message}`);
    if (existing) return mapStudent(existing);

    const { data, error } = await this.client
      .from("student_profiles")
      .insert({
        telegram_user_id: input.telegramUserId,
        display_name: input.displayName
      })
      .select("id, telegram_user_id, display_name, class_id, program_id")
      .single();

    if (error) throw new Error(`Failed to create student profile: ${error.message}`);
    return mapStudent(data);
  }

  async getMemory(studentId: string): Promise<StudentMemory> {
    const { data, error } = await this.client
      .from("student_memory")
      .select("kind, value")
      .eq("student_id", studentId)
      .eq("active", true);

    if (error) throw new Error(`Failed to load student memory: ${error.message}`);

    const memory: StudentMemory = {
      profileFacts: [],
      recurringThemes: [],
      strengths: [],
      goals: []
    };

    for (const item of data ?? []) {
      if (item.kind === "profileFact") memory.profileFacts.push(item.value);
      if (item.kind === "recurringTheme") memory.recurringThemes.push(item.value);
      if (item.kind === "strength") memory.strengths.push(item.value);
      if (item.kind === "goal") memory.goals.push(item.value);
      if (item.kind === "preferredStyle") memory.preferredReflectionStyle = item.value;
    }

    return memory;
  }

  async getActiveConfig(programId?: string): Promise<PromptConfig> {
    let query = this.client
      .from("prompt_configs")
      .select("id, version, mood, starting_message_template, school_context, summary_format, enabled_skills")
      .order("version", { ascending: false })
      .limit(1);

    query = programId ? query.eq("program_id", programId) : query.is("program_id", null);
    const { data, error } = await query.maybeSingle();

    if (error) throw new Error(`Failed to load prompt config: ${error.message}`);
    if (!data) return defaultPromptConfig;

    return {
      id: data.id,
      version: data.version,
      mood: data.mood,
      startingMessageTemplate: data.starting_message_template,
      schoolContext: (data.school_context ?? {}) as PromptConfig["schoolContext"],
      summaryFormat: data.summary_format,
      enabledSkills: data.enabled_skills ?? defaultPromptConfig.enabledSkills
    };
  }

  async createReflection(studentId: string): Promise<ReflectionSession> {
    const session = createInitialReflection(studentId);
    const { data, error } = await this.client
      .from("reflections")
      .insert(toReflectionRow(session))
      .select(reflectionSelect)
      .single();

    if (error) throw new Error(`Failed to create reflection: ${error.message}`);
    return mapReflection(data);
  }

  async getReflection(reflectionId: string): Promise<ReflectionSession | null> {
    const { data, error } = await this.client
      .from("reflections")
      .select(reflectionSelect)
      .eq("id", reflectionId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load reflection: ${error.message}`);
    return data ? mapReflection(data) : null;
  }

  async getLatestOpenReflection(studentId: string): Promise<ReflectionSession | null> {
    const { data, error } = await this.client
      .from("reflections")
      .select(reflectionSelect)
      .eq("student_id", studentId)
      .eq("status", "in_progress")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to load open reflection: ${error.message}`);
    return data ? mapReflection(data) : null;
  }

  async saveReflection(session: ReflectionSession): Promise<void> {
    const { error } = await this.client.from("reflections").upsert(toReflectionRow(session));
    if (error) throw new Error(`Failed to save reflection: ${error.message}`);
  }

  async abandonReflection(reflectionId: string): Promise<void> {
    const { error } = await this.client
      .from("reflections")
      .update({ status: "abandoned", updated_at: new Date().toISOString() })
      .eq("id", reflectionId);

    if (error) throw new Error(`Failed to abandon reflection: ${error.message}`);
  }

  async abandonOpenReflections(studentId: string): Promise<void> {
    const { error } = await this.client
      .from("reflections")
      .update({ status: "abandoned", updated_at: new Date().toISOString() })
      .eq("student_id", studentId)
      .eq("status", "in_progress");

    if (error) throw new Error(`Failed to abandon open reflections: ${error.message}`);
  }

  async addTurn(turn: ReflectionTurn): Promise<void> {
    const { error } = await this.client.from("reflection_turns").insert({
      id: turn.id,
      reflection_id: turn.reflectionId,
      role: turn.role,
      content: turn.content,
      stage: turn.stage,
      created_at: turn.createdAt
    });

    if (error) throw new Error(`Failed to save reflection turn: ${error.message}`);
  }

  async getRecentTurns(reflectionId: string, limit: number): Promise<ReflectionTurn[]> {
    const { data, error } = await this.client
      .from("reflection_turns")
      .select("id, reflection_id, role, content, stage, created_at")
      .eq("reflection_id", reflectionId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Failed to load recent reflection turns: ${error.message}`);

    return (data ?? [])
      .map((row) => ({
        id: row.id,
        reflectionId: row.reflection_id,
        role: row.role,
        content: row.content,
        stage: row.stage,
        createdAt: row.created_at
      }))
      .reverse() as ReflectionTurn[];
  }

  async saveSafetyConcern(concern: SafetyConcern): Promise<void> {
    const { error } = await this.client.from("safety_concerns").insert({
      id: concern.id,
      reflection_id: concern.reflectionId,
      student_id: concern.studentId,
      stage: concern.stage,
      student_turn_id: concern.studentTurnId,
      reason: concern.reason,
      message_snippet: concern.messageSnippet,
      status: concern.status,
      created_at: concern.createdAt
    });

    if (error) throw new Error(`Failed to save safety concern: ${error.message}`);

    const { error: updateError } = await this.client
      .from("reflections")
      .update({ safety_flagged: true, updated_at: new Date().toISOString() })
      .eq("id", concern.reflectionId);

    if (updateError) throw new Error(`Failed to flag reflection safety concern: ${updateError.message}`);
  }

  async saveSummary(summary: ReflectionSummary): Promise<void> {
    const { error } = await this.client.from("reflection_summaries").upsert({
      reflection_id: summary.reflectionId,
      brief_summary: summary.briefSummary,
      key_learnings: summary.keyLearnings,
      actionables: summary.actionables,
      teacher_visible: summary.teacherVisible,
      prompt_config_id: summary.promptVersionId === "default" ? null : summary.promptVersionId
    });

    if (error) throw new Error(`Failed to save reflection summary: ${error.message}`);
  }

  async getLatestSummary(studentId: string): Promise<ReflectionSummary | null> {
    const { data, error } = await this.client
      .from("reflections")
      .select(
        "id, reflection_summaries(brief_summary, key_learnings, actionables, teacher_visible, prompt_config_id)"
      )
      .eq("student_id", studentId)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (error) throw new Error(`Failed to load latest summary: ${error.message}`);

    for (const reflection of data ?? []) {
      const summary = Array.isArray(reflection.reflection_summaries)
        ? reflection.reflection_summaries[0]
        : reflection.reflection_summaries;
      if (summary) {
        return {
          reflectionId: reflection.id,
          briefSummary: summary.brief_summary,
          keyLearnings: summary.key_learnings ?? [],
          actionables: summary.actionables ?? [],
          teacherVisible: summary.teacher_visible,
          promptVersionId: summary.prompt_config_id ?? "default"
        };
      }
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
    const { data, error } = await this.client.rpc("append_telegram_pending_batch", {
      p_student_id: input.studentId,
      p_reflection_id: input.reflectionId,
      p_telegram_chat_id: input.telegramChatId ?? null,
      p_text: input.text,
      p_received_at: input.receivedAt,
      p_delay_seconds: input.delaySeconds,
      p_stale_after_seconds: input.staleAfterSeconds
    });

    if (error) throw new Error(`Failed to append Telegram pending batch: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("Failed to append Telegram pending batch: no row returned");
    return mapTelegramPendingBatch(row as JsonRecord);
  }

  async claimReadyTelegramPendingBatches(input: {
    readyAt: string;
    now: string;
    staleAfterSeconds: number;
    processingLeaseSeconds: number;
    limit: number;
  }): Promise<TelegramPendingBatch[]> {
    const { data, error } = await this.client.rpc("claim_ready_telegram_pending_batches", {
      p_ready_at: input.readyAt,
      p_now: input.now,
      p_stale_after_seconds: input.staleAfterSeconds,
      p_processing_lease_seconds: input.processingLeaseSeconds,
      p_limit: input.limit
    });

    if (error) throw new Error(`Failed to claim Telegram pending batches: ${error.message}`);
    return ((data ?? []) as JsonRecord[]).map(mapTelegramPendingBatch);
  }

  async markTelegramPendingBatchProcessed(batchId: string): Promise<void> {
    const { error } = await this.client
      .from("telegram_pending_batches")
      .update({ status: "processed", processing_expires_at: null, updated_at: new Date().toISOString() })
      .eq("id", batchId);

    if (error) throw new Error(`Failed to mark Telegram pending batch processed: ${error.message}`);
  }

  async releaseTelegramPendingBatch(batchId: string, flushAfter: string): Promise<void> {
    const { error } = await this.client
      .from("telegram_pending_batches")
      .update({ status: "pending", flush_after: flushAfter, processing_expires_at: null, updated_at: new Date().toISOString() })
      .eq("id", batchId);

    if (error) throw new Error(`Failed to release Telegram pending batch: ${error.message}`);
  }

  async cancelTelegramPendingBatch(input: {
    studentId: string;
    reflectionId: string;
    reason: string;
  }): Promise<void> {
    const { error } = await this.client
      .from("telegram_pending_batches")
      .update({
        status: "cancelled",
        cancellation_reason: input.reason,
        processing_expires_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("student_id", input.studentId)
      .eq("reflection_id", input.reflectionId)
      .in("status", ["pending", "processing"]);

    if (error) throw new Error(`Failed to cancel Telegram pending batch: ${error.message}`);
  }

  async createGoogleCalendarAuthLink(input: {
    studentId: string;
    telegramUserId: string;
    telegramChatId?: string;
    tokenHash: string;
    state: string;
    expiresAt: string;
  }): Promise<GoogleCalendarAuthLink> {
    const { data, error } = await this.client
      .from("telegram_google_auth_links")
      .insert({
        student_id: input.studentId,
        telegram_user_id: input.telegramUserId,
        telegram_chat_id: input.telegramChatId ?? null,
        token_hash: input.tokenHash,
        state: input.state,
        expires_at: input.expiresAt
      })
      .select("id, student_id, telegram_user_id, telegram_chat_id, state, expires_at, used_at, created_at")
      .single();

    if (error) throw new Error(`Failed to create Google Calendar auth link: ${error.message}`);
    return mapGoogleCalendarAuthLink(data);
  }

  async getValidGoogleCalendarAuthLinkByTokenHash(input: {
    tokenHash: string;
    now: string;
  }): Promise<GoogleCalendarAuthLink | null> {
    const { data, error } = await this.client
      .from("telegram_google_auth_links")
      .select("id, student_id, telegram_user_id, telegram_chat_id, state, expires_at, used_at, created_at")
      .eq("token_hash", input.tokenHash)
      .is("used_at", null)
      .gt("expires_at", input.now)
      .maybeSingle();

    if (error) throw new Error(`Failed to load Google Calendar auth link: ${error.message}`);
    return data ? mapGoogleCalendarAuthLink(data) : null;
  }

  async consumeGoogleCalendarAuthLinkByState(input: {
    state: string;
    now: string;
    usedAt: string;
  }): Promise<GoogleCalendarAuthLink | null> {
    const { data, error } = await this.client
      .from("telegram_google_auth_links")
      .update({ used_at: input.usedAt })
      .eq("state", input.state)
      .is("used_at", null)
      .gt("expires_at", input.now)
      .select("id, student_id, telegram_user_id, telegram_chat_id, state, expires_at, used_at, created_at")
      .maybeSingle();

    if (error) throw new Error(`Failed to consume Google Calendar auth link: ${error.message}`);
    return data ? mapGoogleCalendarAuthLink(data) : null;
  }

  async getGoogleCalendarConnection(studentId: string): Promise<GoogleCalendarConnection | null> {
    const { data, error } = await this.client
      .from("student_google_calendar_connections")
      .select("student_id, google_sub, google_email, scopes, calendar_id, status, connected_at, updated_at, revoked_at")
      .eq("student_id", studentId)
      .maybeSingle();

    if (error) throw new Error(`Failed to load Google Calendar connection: ${error.message}`);
    return data ? mapGoogleCalendarConnection(data) : null;
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
    const { data, error } = await this.client
      .from("student_google_calendar_connections")
      .upsert({
        student_id: input.studentId,
        google_sub: input.googleSub,
        google_email: input.googleEmail,
        scopes: input.scopes,
        encrypted_refresh_token: input.encryptedRefreshToken,
        calendar_id: input.calendarId,
        status: "active",
        connected_at: input.connectedAt,
        revoked_at: null,
        updated_at: input.connectedAt
      })
      .select("student_id, google_sub, google_email, scopes, calendar_id, status, connected_at, updated_at, revoked_at")
      .single();

    if (error) throw new Error(`Failed to save Google Calendar connection: ${error.message}`);
    return mapGoogleCalendarConnection(data);
  }

  async getEncryptedGoogleCalendarRefreshToken(studentId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("student_google_calendar_connections")
      .select("encrypted_refresh_token")
      .eq("student_id", studentId)
      .eq("status", "active")
      .maybeSingle();

    if (error) throw new Error(`Failed to load Google Calendar refresh token: ${error.message}`);
    return data?.encrypted_refresh_token ? String(data.encrypted_refresh_token) : null;
  }

  async markGoogleCalendarConnectionNeedsReauth(studentId: string): Promise<void> {
    const { error } = await this.client
      .from("student_google_calendar_connections")
      .update({ status: "needs_reauth", updated_at: new Date().toISOString() })
      .eq("student_id", studentId);

    if (error) throw new Error(`Failed to mark Google Calendar connection for reauth: ${error.message}`);
  }

  async disconnectGoogleCalendarConnection(studentId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client
      .from("student_google_calendar_connections")
      .update({
        encrypted_refresh_token: null,
        status: "disconnected",
        revoked_at: now,
        updated_at: now
      })
      .eq("student_id", studentId);

    if (error) throw new Error(`Failed to disconnect Google Calendar: ${error.message}`);
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
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from("student_calendar_events")
      .upsert({
        student_id: input.studentId,
        google_event_id: input.googleEventId,
        calendar_id: input.calendarId,
        source_kind: input.sourceKind,
        source_id: input.sourceId ?? null,
        last_synced_payload: input.lastSyncedPayload,
        status: input.status,
        updated_at: now
      }, { onConflict: "student_id,calendar_id,google_event_id" })
      .select("id, student_id, google_event_id, calendar_id, source_kind, source_id, last_synced_payload, status, created_at, updated_at")
      .single();

    if (error) throw new Error(`Failed to save Google Calendar event mapping: ${error.message}`);
    return mapGoogleCalendarEvent(data);
  }
}

const reflectionSelect =
  "id, student_id, current_stage, status, answers, safety_flagged, created_at, updated_at";

function mapStudent(row: JsonRecord): StudentProfile {
  return {
    id: String(row.id),
    telegramUserId: row.telegram_user_id ? String(row.telegram_user_id) : undefined,
    displayName: String(row.display_name),
    classId: row.class_id ? String(row.class_id) : undefined,
    programId: row.program_id ? String(row.program_id) : undefined
  };
}

function mapReflection(row: JsonRecord): ReflectionSession {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    currentStage: row.current_stage as ReflectionSession["currentStage"],
    status: row.status as ReflectionSession["status"],
    answers: (row.answers ?? {}) as ReflectionSession["answers"],
    safetyFlagged: Boolean(row.safety_flagged),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapTelegramPendingBatch(row: JsonRecord): TelegramPendingBatch {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    reflectionId: String(row.reflection_id),
    telegramChatId: row.telegram_chat_id ? String(row.telegram_chat_id) : undefined,
    messages: Array.isArray(row.messages) ? (row.messages as TelegramPendingBatchMessage[]) : [],
    messageCount: Number(row.message_count ?? 0),
    firstMessageAt: String(row.first_message_at),
    lastMessageAt: String(row.last_message_at),
    flushAfter: String(row.flush_after),
    status: row.status as TelegramPendingBatch["status"],
    stale: Boolean(row.stale),
    processingExpiresAt: row.processing_expires_at ? String(row.processing_expires_at) : undefined,
    cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapGoogleCalendarAuthLink(row: JsonRecord): GoogleCalendarAuthLink {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    telegramUserId: String(row.telegram_user_id),
    telegramChatId: row.telegram_chat_id ? String(row.telegram_chat_id) : undefined,
    state: String(row.state),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at ? String(row.used_at) : undefined,
    createdAt: String(row.created_at)
  };
}

function mapGoogleCalendarConnection(row: JsonRecord): GoogleCalendarConnection {
  return {
    studentId: String(row.student_id),
    googleSub: String(row.google_sub),
    googleEmail: String(row.google_email),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    calendarId: String(row.calendar_id),
    status: row.status as GoogleCalendarConnection["status"],
    connectedAt: String(row.connected_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined
  };
}

function mapGoogleCalendarEvent(row: JsonRecord): GoogleCalendarEvent {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    googleEventId: String(row.google_event_id),
    calendarId: String(row.calendar_id),
    sourceKind: String(row.source_kind),
    sourceId: row.source_id ? String(row.source_id) : undefined,
    lastSyncedPayload: (row.last_synced_payload ?? {}) as Record<string, unknown>,
    status: row.status as GoogleCalendarEvent["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toReflectionRow(session: ReflectionSession) {
  return {
    id: session.id,
    student_id: session.studentId,
    current_stage: session.currentStage,
    status: session.status,
    answers: session.answers,
    safety_flagged: session.safetyFlagged,
    created_at: session.createdAt,
    updated_at: session.updatedAt
  };
}
