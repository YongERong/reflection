import { Bot, InlineKeyboard, type Context } from "grammy";
import {
  createId,
  detectSafetyConcern,
  fixedSafetySupportMessage,
  handleReflectionTurn,
  renderStartingMessage,
  safetyPauseFollowupMessage,
  stagePrompts,
  type AgentTurnDiagnostics,
  type ModelClient,
  type ReflectionSession,
  type ReflectionStore,
  type TelegramPendingBatch,
  type StudentProfile
} from "@reflection/core";
import { captureTraceInput, captureTraceOutput, getBotTracer } from "./observability.js";
import { createSecretToken, sha256Hex } from "./tokenCrypto.js";
import {
  comparisonModelNames,
  createModelRouter,
  defaultComparisonModel,
  isComparisonModelName,
  type ModelAssignment,
  type ModelRouter
} from "./modelRouter.js";

export const openReflectionMessage =
  "You already have a reflection in progress. Send /continue to keep going, or /new to start over.";
export const homeMessage =
  "Hey. I can help you reflect on something. Send /reflect to start, or /model to choose the model.";
export const discardedReflectionMessage =
  "Discarded that reflection. Send /reflect to start again, or /model to choose the model.";
export const staleBacklogMessage =
  "Sorry, I was away for a bit. I saw your messages, but I do not want to treat an old backlog like a live conversation. Send one fresh message when you are ready to continue.";
export const calendarNotConfiguredMessage =
  "Google Calendar linking is not configured yet.";
export const calendarDisconnectedMessage =
  "Disconnected Google Calendar. Send /calendar when you want to connect it again.";

const staleAfterSeconds = 15 * 60;
const calendarAuthLinkTtlMs = 10 * 60 * 1000;
const defaultWorkerIntervalMs = 1000;
const defaultTypingRefreshMs = 4000;
const defaultTypingRevisionPauseMs = 2000;
const minimumSplitReplyLength = 90;
export const defaultBatchClaimGraceMs = 2000;
export const defaultBatchProcessingLeaseSeconds = 60;

export type ReflectionBotOptions = {
  responseDelaySeconds?: number;
  replySplitRate?: number;
  googleCalendar?: {
    enabled: boolean;
    publicBaseUrl: string;
  };
  workerIntervalMs?: number;
  batchClaimGraceMs?: number;
  typingIndicatorManager?: TypingIndicatorManager;
  now?: () => Date;
};

export type TelegramReplyDeliveryKind =
  | "normal_reflection"
  | "safety"
  | "summary"
  | "command"
  | "home"
  | "stale"
  | "loop_repair";

export type TelegramReplyDeliveryPlan = {
  messages: string[];
  metadata: {
    split: boolean;
    messageCount: number;
    splitRate: number;
  };
};

export type TelegramDeliveryTraceInput = {
  splitRate: number;
  seed: string;
};

export type TypingIndicatorTimers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export type TypingIndicatorManagerOptions = {
  sendTyping: (chatId: string) => Promise<void>;
  refreshMs?: number;
  revisionPauseMs?: number;
  timers?: TypingIndicatorTimers;
};

export type TelegramBatchFlushSchedulerOptions = {
  flush: () => Promise<void>;
  intervalMs: number;
  timers?: Pick<TypingIndicatorTimers, "setInterval" | "clearInterval">;
  onError?: (error: unknown) => void;
};

type TypingIndicatorState = {
  chatId: string;
  reflectionId: string;
  refreshTimer?: ReturnType<typeof setInterval>;
  pauseTimer?: ReturnType<typeof setTimeout>;
};

export class TypingIndicatorManager {
  private readonly sendTyping: (chatId: string) => Promise<void>;
  private readonly refreshMs: number;
  private readonly revisionPauseMs: number;
  private readonly timers: TypingIndicatorTimers;
  private readonly states = new Map<string, TypingIndicatorState>();

  constructor(options: TypingIndicatorManagerOptions) {
    this.sendTyping = options.sendTyping;
    this.refreshMs = options.refreshMs ?? defaultTypingRefreshMs;
    this.revisionPauseMs = options.revisionPauseMs ?? defaultTypingRevisionPauseMs;
    this.timers = options.timers ?? {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    };
  }

  noteBufferedMessage(input: { chatId: string; reflectionId: string }): void {
    const key = typingIndicatorKey(input.chatId, input.reflectionId);
    const existing = this.states.get(key);

    if (!existing) {
      const state: TypingIndicatorState = {
        chatId: input.chatId,
        reflectionId: input.reflectionId
      };
      this.states.set(key, state);
      this.sendTypingNow(state);
      this.startRefresh(state);
      return;
    }

    this.stopRefresh(existing);
    if (existing.pauseTimer) this.timers.clearTimeout(existing.pauseTimer);
    existing.pauseTimer = this.timers.setTimeout(() => {
      existing.pauseTimer = undefined;
      if (!this.states.has(key)) return;
      this.sendTypingNow(existing);
      this.startRefresh(existing);
    }, this.revisionPauseMs);
    existing.pauseTimer.unref?.();
  }

  stop(input: { chatId?: string; reflectionId: string }): void {
    if (input.chatId) {
      this.stopByKey(typingIndicatorKey(input.chatId, input.reflectionId));
      return;
    }

    for (const [key, state] of this.states.entries()) {
      if (state.reflectionId === input.reflectionId) this.stopByKey(key);
    }
  }

  pendingCount(): number {
    return this.states.size;
  }

  private startRefresh(state: TypingIndicatorState): void {
    this.stopRefresh(state);
    state.refreshTimer = this.timers.setInterval(() => {
      this.sendTypingNow(state);
    }, this.refreshMs);
    state.refreshTimer.unref?.();
  }

  private stopByKey(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    this.stopRefresh(state);
    if (state.pauseTimer) this.timers.clearTimeout(state.pauseTimer);
    this.states.delete(key);
  }

  private stopRefresh(state: TypingIndicatorState): void {
    if (!state.refreshTimer) return;
    this.timers.clearInterval(state.refreshTimer);
    state.refreshTimer = undefined;
  }

  private sendTypingNow(state: TypingIndicatorState): void {
    void this.sendTyping(state.chatId).catch((error) => {
      console.warn("Failed to send Telegram typing indicator", error);
    });
  }
}

export function createTelegramBatchFlushScheduler(options: TelegramBatchFlushSchedulerOptions) {
  const timers = options.timers ?? {
    setInterval,
    clearInterval
  };
  const onError = options.onError ?? ((error) => console.error("Failed to run Telegram batch flush worker", error));
  let flushInFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const run = (): void => {
    if (flushInFlight) return;
    flushInFlight = true;
    void options.flush()
      .catch(onError)
      .finally(() => {
        flushInFlight = false;
      });
  };

  return {
    start(): void {
      if (timer) return;
      timer = timers.setInterval(run, options.intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      timers.clearInterval(timer);
      timer = undefined;
    },
    isInFlight(): boolean {
      return flushInFlight;
    }
  };
}

export function createReflectionBot(
  token: string,
  store: ReflectionStore,
  model?: ModelClient,
  router?: ModelRouter,
  options: ReflectionBotOptions = {}
): Bot {
  const bot = new Bot(token);
  const modelRouter = router ?? createModelRouter({ [defaultComparisonModel]: model });
  const responseDelaySeconds = options.responseDelaySeconds ?? 0;
  const replySplitRate = options.replySplitRate ?? 0;
  const now = options.now ?? (() => new Date());
  const typingIndicatorManager =
    options.typingIndicatorManager ??
    new TypingIndicatorManager({
      sendTyping: async (chatId) => {
        await bot.api.sendChatAction(chatId, "typing");
      }
    });
  const staleCommandCollapser = createStaleCommandCollapser({
    now,
    staleAfterSeconds,
    collapseMs: 250
  });

  bot.command("start", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const config = await store.getActiveConfig(student.programId);
    await ctx.reply(renderStartingMessage(config, student.displayName));
  }));

  bot.command("reflect", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const replies = await handleReflectCommand({ store, student, modelRouter });
    for (const reply of replies) await ctx.reply(reply);
  }));

  bot.command("new", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const existing = await store.getLatestOpenReflection(student.id);
    if (existing) {
      typingIndicatorManager.stop({
        chatId: String(ctx.chat?.id ?? student.telegramUserId ?? student.id),
        reflectionId: existing.id
      });
    }
    const replies = await handleNewReflectionCommand({ store, student, modelRouter });
    for (const reply of replies) await ctx.reply(reply);
  }));

  bot.command("model", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const response = await handleModelCommand({ store, student, modelRouter });
    await ctx.reply(response.text, response.replyMarkup ? { reply_markup: response.replyMarkup } : undefined);
  }));

  bot.command("calendar", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const response = await handleCalendarCommand({
      store,
      student,
      telegramChatId: String(ctx.chat?.id ?? student.telegramUserId ?? student.id),
      publicBaseUrl: options.googleCalendar?.publicBaseUrl ?? "",
      enabled: options.googleCalendar?.enabled === true
    });
    await ctx.reply(response.text, response.replyMarkup ? { reply_markup: response.replyMarkup } : undefined);
  }));

  bot.command("disconnect_calendar", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const response = await handleDisconnectCalendarCommand({ store, student });
    await ctx.reply(response);
  }));

  bot.callbackQuery(/^model:/, async (ctx) => {
    const student = await getStudent(ctx, store);
    const callbackData = ctx.callbackQuery.data ?? "";
    const response = await handleModelSelectionCallback({
      store,
      student,
      modelRouter,
      callbackData
    });
    await ctx.answerCallbackQuery({ text: response.callbackText });
    await ctx.reply(response.text);
  });

  bot.command("continue", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const session = await store.getLatestOpenReflection(student.id);
    if (!session) {
      await ctx.reply("You do not have an unfinished reflection. Send /reflect to start one.");
      return;
    }
    await ctx.reply(stagePrompts[session.currentStage]);
  }));

  bot.command("summary", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    const student = await getStudent(ctx, store);
    const summary = await store.getLatestSummary(student.id);
    if (!summary) {
      await ctx.reply("No completed reflection summary yet. Send /reflect when you are ready.");
      return;
    }
    await ctx.reply(formatSummary(summary.briefSummary, summary.actionables));
  }));

  bot.command("privacy", async (ctx) => runCommand(ctx, staleCommandCollapser, async () => {
    await ctx.reply(
      [
        "Your reflections are stored with your student profile.",
        "Teachers/admins can view summaries and actionables in the dashboard when they have permission.",
        "The bot uses structured memory themes to adapt over time; core privacy and safety rules cannot be changed by custom prompts."
      ].join("\n")
    );
  }));

  bot.on("message:text", async (ctx) => {
    const student = await getStudent(ctx, store);
    const session = await store.getLatestOpenReflection(student.id);
    if (!session) {
      await ctx.reply(homeMessage);
      return;
    }

    const assignment = modelRouter.assignReflection(session.id, modelRoutingKey(student));
    const result = await handleIncomingReflectionText({
      store,
      model: modelRouter.getClient(assignment) ?? model,
      modelAssignment: assignment,
      responseDelaySeconds,
      session,
      student,
      text: ctx.message.text,
      telegramChatId: String(ctx.chat?.id ?? student.telegramUserId ?? student.id),
      receivedAt: telegramDateToIso(ctx.message.date, now),
      delivery: {
        splitRate: replySplitRate,
        seed: `${session.id}:${student.id}:${ctx.message.message_id}`
      }
    });

    if (result.buffered && result.batch) {
      typingIndicatorManager.noteBufferedMessage({
        chatId: result.batch.telegramChatId ?? String(ctx.chat?.id ?? student.telegramUserId ?? student.id),
        reflectionId: result.batch.reflectionId
      });
    } else if (result.cancelledBySafety) {
      typingIndicatorManager.stop({
        chatId: String(ctx.chat?.id ?? student.telegramUserId ?? student.id),
        reflectionId: session.id
      });
    }

    for (const reply of result.replies) {
      await sendTelegramReply({
        reply,
        kind: classifyTelegramReplyDeliveryKind(reply),
        splitRate: replySplitRate,
        seed: `${session.id}:${student.id}:${ctx.message.message_id}:${reply}`,
        send: async (message) => {
          await ctx.reply(message);
        }
      });
    }
  });

  if (responseDelaySeconds > 0) {
    const scheduler = createTelegramBatchFlushScheduler({
      intervalMs: options.workerIntervalMs ?? defaultWorkerIntervalMs,
      flush: async () => {
        await flushReadyTelegramBatches({
          store,
          model,
          modelRouter,
          now,
          batchClaimGraceMs: options.batchClaimGraceMs,
          typingIndicatorManager,
          replySplitRate,
          sendMessage: async (chatId, text) => {
            await bot.api.sendMessage(chatId, text);
          }
        });
      }
    });
    scheduler.start();
  }

  return bot;
}

export async function handleReflectCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter?: ModelRouter;
}): Promise<string[]> {
  const existing = await input.store.getLatestOpenReflection(input.student.id);
  if (existing) return [openReflectionMessage];
  return createReflectionWithPrompt(input.store, input.student, input.modelRouter);
}

export async function handleNewReflectionCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter?: ModelRouter;
}): Promise<string[]> {
  const existing = await input.store.getLatestOpenReflection(input.student.id);
  if (existing) {
    await input.store.cancelTelegramPendingBatch({
      studentId: input.student.id,
      reflectionId: existing.id,
      reason: "new_command"
    });
  }
  await input.store.abandonOpenReflections(input.student.id);
  return [existing ? discardedReflectionMessage : homeMessage];
}

export async function handleIncomingReflectionText(input: {
  store: ReflectionStore;
  model?: ModelClient;
  modelAssignment?: ModelAssignment;
  responseDelaySeconds: number;
  session: ReflectionSession;
  student: StudentProfile;
  text: string;
  telegramChatId?: string;
  receivedAt: string;
  delivery?: TelegramDeliveryTraceInput;
}): Promise<{ replies: string[]; buffered: boolean; batch?: TelegramPendingBatch; cancelledBySafety?: boolean }> {
  if (isTelegramCommand(input.text)) {
    return { replies: [], buffered: false };
  }

  if (input.responseDelaySeconds === 0) {
    return {
      replies: await handleStudentReflectionMessage(input),
      buffered: false
    };
  }

  const safety = detectSafetyConcern(input.text);
  if (safety.hasConcern) {
    await input.store.cancelTelegramPendingBatch({
      studentId: input.student.id,
      reflectionId: input.session.id,
      reason: "cancelled_by_safety"
    });
    return {
      replies: await handleStudentReflectionMessage({
        ...input,
        batch: {
          messageCount: 1,
          firstMessageAt: input.receivedAt,
          lastMessageAt: input.receivedAt,
          debounceMs: 0,
          stale: false,
          cancelledBySafety: true
        },
        delivery: input.delivery
      }),
      buffered: false,
      cancelledBySafety: true
    };
  }

  const batch = await input.store.appendTelegramPendingBatch({
    studentId: input.student.id,
    reflectionId: input.session.id,
    telegramChatId: input.telegramChatId,
    text: input.text,
    receivedAt: input.receivedAt,
    delaySeconds: input.responseDelaySeconds,
    staleAfterSeconds
  });

  return { replies: [], buffered: true, batch };
}

export async function handleModelCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter: ModelRouter;
}): Promise<{ text: string; replyMarkup?: InlineKeyboard }> {
  const openReflection = await input.store.getLatestOpenReflection(input.student.id);
  if (openReflection) {
    const assignment = input.modelRouter.assignReflection(openReflection.id, modelRoutingKey(input.student));
    return {
      text: `You have a reflection in progress using ${assignment.modelName}. Finish it or send /new to discard it before changing models.`
    };
  }

  const preference = input.modelRouter.getPreference(modelRoutingKey(input.student));
  return {
    text: `Choose the model for new reflections. Current choice: ${preference.modelName}.`,
    replyMarkup: buildModelPickerKeyboard()
  };
}

export async function handleModelSelectionCallback(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter: ModelRouter;
  callbackData: string;
}): Promise<{ text: string; callbackText: string }> {
  const [, modelName = ""] = input.callbackData.split(":");
  if (!isComparisonModelName(modelName)) {
    return {
      text: "That model option is not available.",
      callbackText: "Model not available"
    };
  }

  const openReflection = await input.store.getLatestOpenReflection(input.student.id);
  if (openReflection) {
    const assignment = input.modelRouter.assignReflection(openReflection.id, modelRoutingKey(input.student));
    return {
      text: `You have a reflection in progress using ${assignment.modelName}. Finish it or send /new to discard it before changing models.`,
      callbackText: "Finish or discard the current reflection first"
    };
  }

  input.modelRouter.setPreference(modelRoutingKey(input.student), modelName);
  return {
    text: `New reflections will use ${modelName}.`,
    callbackText: `New reflections will use ${modelName}`
  };
}

export async function handleCalendarCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  telegramChatId?: string;
  publicBaseUrl: string;
  enabled: boolean;
  now?: () => Date;
}): Promise<{ text: string; replyMarkup?: InlineKeyboard }> {
  if (!input.enabled || !input.publicBaseUrl) {
    return { text: calendarNotConfiguredMessage };
  }

  const telegramUserId = input.student.telegramUserId ?? input.student.id;
  const token = createSecretToken();
  const state = createSecretToken();
  const now = input.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + calendarAuthLinkTtlMs).toISOString();
  const connection = await input.store.getGoogleCalendarConnection(input.student.id);

  await input.store.createGoogleCalendarAuthLink({
    studentId: input.student.id,
    telegramUserId,
    telegramChatId: input.telegramChatId,
    tokenHash: sha256Hex(token),
    state,
    expiresAt
  });

  const connectUrl = new URL("/google-calendar/connect", input.publicBaseUrl);
  connectUrl.searchParams.set("token", token);
  const keyboard = new InlineKeyboard().url(
    connection?.status === "active" ? "Reconnect Google Calendar" : "Connect Google Calendar",
    connectUrl.toString()
  );

  if (connection?.status === "active") {
    return {
      text: `Google Calendar is connected as ${connection.googleEmail}. Use the button to reconnect or update permissions. Send /disconnect_calendar to remove access.`,
      replyMarkup: keyboard
    };
  }

  if (connection?.status === "needs_reauth") {
    return {
      text: "Google Calendar needs to be reconnected before I can add or edit events.",
      replyMarkup: keyboard
    };
  }

  return {
    text: "Connect Google Calendar so I can add and edit reflection events for you.",
    replyMarkup: keyboard
  };
}

export async function handleDisconnectCalendarCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
}): Promise<string> {
  await input.store.disconnectGoogleCalendarConnection(input.student.id);
  return calendarDisconnectedMessage;
}

export async function handleStudentReflectionMessage(input: {
  store: ReflectionStore;
  model?: ModelClient;
  modelAssignment?: ModelAssignment;
  session?: ReflectionSession;
  student: StudentProfile;
  text: string;
  studentTurnCreatedAt?: string;
  batch?: TelegramBatchTraceMetadata;
  delivery?: TelegramDeliveryTraceInput;
}): Promise<string[]> {
  return getBotTracer().withActiveSpan("reflection.student_message", async (span) => {
    const session = input.session ?? (await input.store.getLatestOpenReflection(input.student.id));
    if (!session) {
      span.setType("workflow");
      captureTraceInput(span, "json", {
        studentId: input.student.id,
        status: "home",
        text: input.text
      });
      span.setAttributes({
        "reflection.student_id": input.student.id,
        "reflection.session_status": "home",
        "reflection.home_state": true
      });
      captureTraceOutput(span, {
        replies: [homeMessage],
        completed: false,
        currentStage: "home",
        replyKind: "home"
      });
      return [homeMessage];
    }

    span.setType("workflow");
    captureTraceInput(span, "json", {
      reflectionId: session.id,
      studentId: input.student.id,
      stage: session.currentStage,
      status: session.status,
      text: input.text,
      model: input.modelAssignment?.modelName,
      batch: input.batch
    });
    span.setAttributes({
      "reflection.id": session.id,
      "reflection.student_id": input.student.id,
      "reflection.stage": session.currentStage,
      "reflection.session_status": session.status,
      ...telegramBatchTraceAttributes(input.batch),
      ...modelTraceAttributes(input.modelAssignment)
    });

    const studentTurn = {
      id: createId("turn"),
      reflectionId: session.id,
      role: "student",
      content: input.text,
      stage: session.currentStage,
      createdAt: input.studentTurnCreatedAt ?? new Date().toISOString()
    } as const;
    await input.store.addTurn(studentTurn);

    const result = await processReflectionText({
      store: input.store,
      model: input.model,
      session,
      student: input.student,
      text: input.text,
      studentTurnId: studentTurn.id
    });

    await input.store.saveReflection(result.session);

    if (result.summary) {
      await input.store.saveSummary(result.summary);
    }

    const replies = buildReflectionReplies(result);
    const deliveryPlans = input.delivery
      ? replies.map((reply) => planTelegramReplyDelivery({
          reply,
          kind: classifyTelegramReplyDeliveryKind(reply),
          splitRate: input.delivery?.splitRate ?? 0,
          seed: `${input.delivery?.seed ?? ""}:${reply}`
        }))
      : [];
    span.setAttributes({
      "reflection.completed": result.completed,
      "reflection.next_stage": result.session.currentStage,
      "reflection.reply_kind": result.replyKind,
      "reflection.safety_flagged": result.safetyConcern.hasConcern,
      "reflection.safety_pause": result.replyKind === "safety_followup" && result.safetyConcern.hasConcern,
      ...reflectionDiagnosticsTraceAttributes(result.diagnostics),
      ...telegramDeliveryTraceAttributes(deliveryPlans),
      ...telegramBatchTraceAttributes(input.batch),
      ...modelTraceAttributes(input.modelAssignment)
    });
    captureTraceOutput(span, {
      replies,
      completed: result.completed,
      currentStage: result.session.currentStage,
      replyKind: result.replyKind,
      safetyConcern: {
        hasConcern: result.safetyConcern.hasConcern,
        level: result.safetyConcern.level,
        category: result.safetyConcern.category
      },
      diagnostics: result.diagnostics,
      delivery: deliveryPlans.length > 0
        ? {
            split: deliveryPlans.some((plan) => plan.metadata.split),
            messageCount: deliveryPlans.reduce((sum, plan) => sum + plan.metadata.messageCount, 0),
            splitRate: input.delivery?.splitRate ?? 0
          }
        : undefined,
      summary: result.summary
        ? {
            promptVersionId: result.summary.promptVersionId,
            actionablesCount: result.summary.actionables.length,
            keyLearningsCount: result.summary.keyLearnings.length
          }
        : undefined
    });

    for (const reply of replies) {
      await input.store.addTurn({
        id: createId("turn"),
        reflectionId: result.session.id,
        role: "bot",
        content: reply,
        stage: result.session.currentStage,
        createdAt: new Date().toISOString()
      });
    }

    return replies;
  });
}

export async function processReflectionText(input: {
  store: ReflectionStore;
  model?: ModelClient;
  modelAssignment?: ModelAssignment;
  session: ReflectionSession;
  student: StudentProfile;
  text: string;
  studentTurnId: string;
}) {
  const memory = await input.store.getMemory(input.student.id);
  const config = await input.store.getActiveConfig(input.student.programId);
  const recentTurns = await input.store.getRecentTurns(input.session.id, 10);
  const result = await handleReflectionTurn({
    profile: input.student,
    memory,
    config,
    model: input.model,
    recentTurns,
    session: input.session,
    studentMessage: input.text
  });

  if (result.safetyConcern.hasConcern) {
    await input.store.saveSafetyConcern({
      id: createId("safety"),
      reflectionId: input.session.id,
      studentId: input.student.id,
      stage: input.session.currentStage,
      studentTurnId: input.studentTurnId,
      reason: `${result.safetyConcern.category}: ${result.safetyConcern.reason ?? "Safety concern detected."}`,
      messageSnippet: toSafetySnippet(input.text),
      status: "open",
      createdAt: new Date().toISOString()
    });
  }

  return result;
}

export async function flushReadyTelegramBatches(input: {
  store: ReflectionStore;
  model?: ModelClient;
  modelRouter: ModelRouter;
  now?: () => Date;
  limit?: number;
  batchClaimGraceMs?: number;
  typingIndicatorManager?: TypingIndicatorManager;
  replySplitRate?: number;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  const workerNow = now();
  const readyAt = new Date(workerNow.getTime() - (input.batchClaimGraceMs ?? defaultBatchClaimGraceMs));
  const batches = await input.store.claimReadyTelegramPendingBatches({
    readyAt: readyAt.toISOString(),
    now: workerNow.toISOString(),
    staleAfterSeconds,
    processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
    limit: input.limit ?? 10
  });

  for (const batch of batches) {
    try {
      const session = await input.store.getReflection(batch.reflectionId);
      if (!session || session.status !== "in_progress") {
        input.typingIndicatorManager?.stop(
          batch.telegramChatId
            ? { chatId: batch.telegramChatId, reflectionId: batch.reflectionId }
            : { reflectionId: batch.reflectionId }
        );
        await input.store.markTelegramPendingBatchProcessed(batch.id);
        continue;
      }
      const student = await input.store.getOrCreateStudent({
        telegramUserId: batch.telegramChatId ?? batch.studentId,
        displayName: "there"
      });
      const batchText = batch.messages.map((message) => message.text).join("\n\n");
      const chatId = batch.telegramChatId ?? student.telegramUserId ?? student.id;

      if (batch.stale) {
        input.typingIndicatorManager?.stop({ chatId, reflectionId: batch.reflectionId });
        await persistStaleBacklogTurn({
          store: input.store,
          session,
          text: batchText,
          receivedAt: batch.lastMessageAt
        });
        await input.sendMessage(chatId, staleBacklogMessage);
        await input.store.addTurn({
          id: createId("turn"),
          reflectionId: session.id,
          role: "bot",
          content: staleBacklogMessage,
          stage: session.currentStage,
          createdAt: now().toISOString()
        });
        await input.store.markTelegramPendingBatchProcessed(batch.id);
        continue;
      }

      const assignment = input.modelRouter.assignReflection(session.id, modelRoutingKey(student));
      const replies = await handleStudentReflectionMessage({
        store: input.store,
        model: input.modelRouter.getClient(assignment) ?? input.model,
        modelAssignment: assignment,
        session,
        student,
        text: batchText,
        studentTurnCreatedAt: batch.lastMessageAt,
        batch: {
          messageCount: batch.messageCount,
          firstMessageAt: batch.firstMessageAt,
          lastMessageAt: batch.lastMessageAt,
          debounceMs: new Date(batch.flushAfter).getTime() - new Date(batch.lastMessageAt).getTime(),
          stale: batch.stale,
          cancelledBySafety: false
        },
        delivery: {
          splitRate: input.replySplitRate ?? 0,
          seed: `${chatId}:${batch.id}`
        }
      });
      for (const reply of replies) {
        input.typingIndicatorManager?.stop({ chatId, reflectionId: batch.reflectionId });
        await sendTelegramReply({
          reply,
          kind: classifyTelegramReplyDeliveryKind(reply),
          splitRate: input.replySplitRate ?? 0,
          seed: `${chatId}:${batch.id}:${reply}`,
          send: async (message) => {
            await input.sendMessage(chatId, message);
          }
        });
      }
      input.typingIndicatorManager?.stop({ chatId, reflectionId: batch.reflectionId });
      await input.store.markTelegramPendingBatchProcessed(batch.id);
    } catch (error) {
      console.error("Failed to flush Telegram pending batch", error);
      await input.store.releaseTelegramPendingBatch(batch.id, new Date(now().getTime() + 5000).toISOString());
    }
  }

  return batches.length;
}

export function buildReflectionReplies(result: {
  botMessage: string;
  safetyConcern: { hasConcern: boolean; category?: string };
}): string[] {
  return result.safetyConcern.hasConcern && result.safetyConcern.category !== "dangerous_instruction"
    ? [fixedSafetySupportMessage, result.botMessage]
    : [result.botMessage];
}

export async function sendTelegramReply(input: {
  reply: string;
  kind: TelegramReplyDeliveryKind;
  splitRate: number;
  seed: string;
  send: (message: string) => Promise<void>;
}): Promise<TelegramReplyDeliveryPlan> {
  const plan = planTelegramReplyDelivery({
    reply: input.reply,
    kind: input.kind,
    splitRate: input.splitRate,
    seed: input.seed
  });
  for (const message of plan.messages) {
    await input.send(message);
  }
  return plan;
}

export function planTelegramReplyDelivery(input: {
  reply: string;
  kind: TelegramReplyDeliveryKind;
  splitRate: number;
  seed: string;
}): TelegramReplyDeliveryPlan {
  const splitRate = clampReplySplitRate(input.splitRate);
  const unsplit = (): TelegramReplyDeliveryPlan => ({
    messages: [input.reply],
    metadata: {
      split: false,
      messageCount: 1,
      splitRate
    }
  });

  if (splitRate === 0 || input.kind !== "normal_reflection") return unsplit();
  if (input.reply.length < minimumSplitReplyLength) return unsplit();
  const sentenceChunks = splitIntoSentenceChunks(input.reply);
  if (sentenceChunks.length < 2) return unsplit();
  if (stableUnitInterval(`${input.seed}:${input.reply}`) >= splitRate) return unsplit();

  const splitIndex = chooseBalancedSplitIndex(sentenceChunks);
  const messages = [
    sentenceChunks.slice(0, splitIndex).join(" ").trim(),
    sentenceChunks.slice(splitIndex).join(" ").trim()
  ].filter(Boolean);
  if (messages.length !== 2) return unsplit();

  return {
    messages,
    metadata: {
      split: true,
      messageCount: messages.length,
      splitRate
    }
  };
}

export function classifyTelegramReplyDeliveryKind(reply: string): TelegramReplyDeliveryKind {
  if (reply === homeMessage) return "home";
  if (reply === staleBacklogMessage) return "stale";
  if (reply === fixedSafetySupportMessage || reply === safetyPauseFollowupMessage) return "safety";
  if (reply.startsWith("Here is a brief summary of your reflection:") || reply.includes("\nActionables:\n")) return "summary";
  if (reply.startsWith("I think we are looping") || reply.startsWith("I think we are circling the same cause")) return "loop_repair";
  return "normal_reflection";
}

function splitIntoSentenceChunks(reply: string): string[] {
  return reply
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function chooseBalancedSplitIndex(chunks: string[]): number {
  if (chunks.length <= 2) return 1;
  const totalLength = chunks.join(" ").length;
  let bestIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < chunks.length; index += 1) {
    const leftLength = chunks.slice(0, index).join(" ").length;
    const distance = Math.abs(totalLength / 2 - leftLength);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function clampReplySplitRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function stableUnitInterval(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

async function getStudent(ctx: Context, store: ReflectionStore) {
  const telegramUserId = String(ctx.from?.id ?? "unknown");
  const displayName = ctx.from?.first_name ?? ctx.from?.username ?? "there";
  return store.getOrCreateStudent({ telegramUserId, displayName });
}

function buildModelPickerKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  comparisonModelNames.forEach((modelName, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(modelName, `model:${modelName}`);
  });
  return keyboard;
}

async function createReflectionWithPrompt(
  store: ReflectionStore,
  student: StudentProfile,
  modelRouter?: ModelRouter
): Promise<string[]> {
  const session = await store.createReflection(student.id);
  modelRouter?.assignReflection(session.id, modelRoutingKey(student));
  await store.addTurn({
    id: createId("turn"),
    reflectionId: session.id,
    role: "bot",
    content: stagePrompts.description,
    stage: "description",
    createdAt: new Date().toISOString()
  });
  return [stagePrompts.description];
}

export function modelTraceAttributes(assignment?: ModelAssignment): Record<string, string> {
  if (!assignment) return {};
  return {
    "reflection.model.variant": assignment.modelName,
    "reflection.model.assignment_source": assignment.source,
    "reflection.model.comparison_group": "in_situ_manual"
  };
}

export type TelegramBatchTraceMetadata = {
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  debounceMs: number;
  stale: boolean;
  cancelledBySafety: boolean;
};

export function telegramBatchTraceAttributes(batch?: TelegramBatchTraceMetadata): Record<string, string | number | boolean> {
  if (!batch) return {};
  return {
    "telegram.batch.message_count": batch.messageCount,
    "telegram.batch.first_message_at": batch.firstMessageAt,
    "telegram.batch.last_message_at": batch.lastMessageAt,
    "telegram.batch.debounce_ms": batch.debounceMs,
    "telegram.batch.stale": batch.stale,
    "telegram.batch.cancelled_by_safety": batch.cancelledBySafety
  };
}

export function reflectionDiagnosticsTraceAttributes(diagnostics?: AgentTurnDiagnostics): Record<string, string | number | boolean> {
  if (!diagnostics) return {};
  return {
    "reflection.reply_guard.exact_repeat": diagnostics.replyGuard.exactRepeat,
    "reflection.reply_guard.action": diagnostics.replyGuard.action,
    "reflection.loop.semantic_probe_count": diagnostics.loop.semanticProbeCount,
    "reflection.loop.semantic_loop": diagnostics.loop.semanticLoop
  };
}

export function telegramDeliveryTraceAttributes(plans: TelegramReplyDeliveryPlan[]): Record<string, string | number | boolean> {
  if (plans.length === 0) return {};
  return {
    "telegram.delivery.split": plans.some((plan) => plan.metadata.split),
    "telegram.delivery.message_count": plans.reduce((sum, plan) => sum + plan.metadata.messageCount, 0),
    "telegram.delivery.split_rate": plans[0]?.metadata.splitRate ?? 0
  };
}

export function isTelegramCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

export function isStaleTelegramDate(dateSeconds: number | undefined, now: Date, staleSeconds = staleAfterSeconds): boolean {
  if (!dateSeconds) return false;
  return now.getTime() - dateSeconds * 1000 > staleSeconds * 1000;
}

export type StaleCommandCollapser = ReturnType<typeof createStaleCommandCollapser>;

export function createStaleCommandCollapser(input: {
  now: () => Date;
  staleAfterSeconds: number;
  collapseMs: number;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    async run(ctx: Context, execute: () => Promise<void>): Promise<void> {
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "unknown");
      if (!isStaleTelegramDate(ctx.message?.date, input.now(), input.staleAfterSeconds)) {
        await execute();
        return;
      }

      const existing = pending.get(chatId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pending.delete(chatId);
        void ctx.reply(staleBacklogMessage).then(execute);
      }, input.collapseMs);
      timer.unref?.();
      pending.set(chatId, timer);
    },
    pendingCount(): number {
      return pending.size;
    }
  };
}

function modelRoutingKey(student: StudentProfile): string {
  return student.telegramUserId ?? student.id;
}

function typingIndicatorKey(chatId: string, reflectionId: string): string {
  return `${chatId}:${reflectionId}`;
}

async function runCommand(
  ctx: Context,
  staleCommandCollapser: StaleCommandCollapser,
  execute: () => Promise<void>
): Promise<void> {
  await staleCommandCollapser.run(ctx, execute);
}

async function persistStaleBacklogTurn(input: {
  store: ReflectionStore;
  session: ReflectionSession;
  text: string;
  receivedAt: string;
}): Promise<void> {
  await input.store.addTurn({
    id: createId("turn"),
    reflectionId: input.session.id,
    role: "student",
    content: input.text,
    stage: input.session.currentStage,
    createdAt: input.receivedAt
  });
}

function telegramDateToIso(dateSeconds: number | undefined, now: () => Date): string {
  return dateSeconds ? new Date(dateSeconds * 1000).toISOString() : now().toISOString();
}

function formatSummary(briefSummary: string, actionables: string[]): string {
  return [`Latest reflection summary:`, briefSummary, "", "Actionables:", ...actionables.map((item) => `- ${item}`)].join("\n");
}

function toSafetySnippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}
