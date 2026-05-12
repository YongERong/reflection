import { describe, expect, it, vi } from "vitest";
import { createId, createInitialReflection, fixedSafetySupportMessage, safetyPauseFollowupMessage, stagePrompts } from "@reflection/core";
import {
  buildReflectionReplies,
  calendarDisconnectedMessage,
  calendarNotConfiguredMessage,
  createTelegramBatchFlushScheduler,
  createStaleCommandCollapser,
  defaultBatchProcessingLeaseSeconds,
  discardedReflectionMessage,
  flushReadyTelegramBatches,
  handleCalendarCommand,
  handleDisconnectCalendarCommand,
  handleIncomingReflectionText,
  handleModelCommand,
  handleModelSelectionCallback,
  handleNewReflectionCommand,
  handleReflectCommand,
  handleStudentReflectionMessage,
  homeMessage,
  isStaleTelegramDate,
  modelTraceAttributes,
  openReflectionMessage,
  planTelegramReplyDelivery,
  processReflectionText,
  sendTelegramReply,
  staleBacklogMessage,
  TypingIndicatorManager
} from "./bot.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";
import { createModelRouter } from "./modelRouter.js";

function modelRoutingKey(student: { id: string; telegramUserId?: string }) {
  return student.telegramUserId ?? student.id;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("Telegram reflection start commands", () => {
  it("/reflect creates one reflection and prompt turn when no open reflection exists", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_reflect_1",
      displayName: "Asha"
    });

    const replies = await handleReflectCommand({ store, student });

    expect(replies).toEqual([stagePrompts.description]);
    expect(store.getReflections()).toHaveLength(1);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([stagePrompts.description]);
  });

  it("/reflect with an open reflection creates no additional rows", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_reflect_2",
      displayName: "Ben"
    });

    await handleReflectCommand({ store, student });
    const replies = await handleReflectCommand({ store, student });

    expect(replies).toEqual([openReflectionMessage]);
    expect(store.getReflections()).toHaveLength(1);
    expect(store.getTurns()).toHaveLength(1);
  });

  it("/new abandons the open reflection and returns home", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_new_1",
      displayName: "Chloe"
    });

    await handleReflectCommand({ store, student });
    const oldReflection = store.getReflections()[0];
    const replies = await handleNewReflectionCommand({ store, student });
    const reflections = store.getReflections();

    expect(replies).toEqual([discardedReflectionMessage]);
    expect(reflections).toHaveLength(1);
    expect(reflections.find((reflection) => reflection.id === oldReflection?.id)?.status).toBe("abandoned");
    expect(reflections.filter((reflection) => reflection.status === "in_progress")).toHaveLength(0);
    expect(await store.getLatestOpenReflection(student.id)).toBeNull();
    expect(store.getTurns()).toHaveLength(1);
  });

  it("/new abandons every existing open reflection for the student", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_new_many",
      displayName: "Farah"
    });
    const first = await store.createReflection(student.id);
    const second = await store.createReflection(student.id);

    const replies = await handleNewReflectionCommand({ store, student });
    const reflections = store.getReflections();

    expect(replies).toEqual([discardedReflectionMessage]);
    expect(reflections.find((reflection) => reflection.id === first.id)?.status).toBe("abandoned");
    expect(reflections.find((reflection) => reflection.id === second.id)?.status).toBe("abandoned");
    expect(reflections.filter((reflection) => reflection.status === "in_progress")).toHaveLength(0);
  });

  it("/new with no open reflection stays home without creating a reflection", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_new_2",
      displayName: "Devi"
    });

    const replies = await handleNewReflectionCommand({ store, student });

    expect(replies).toEqual([homeMessage]);
    expect(store.getReflections()).toHaveLength(0);
  });

  it("abandoned reflections are excluded from continue lookups", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_new_3",
      displayName: "Eli"
    });
    const session = await store.createReflection(student.id);

    await store.abandonReflection(session.id);

    expect(await store.getLatestOpenReflection(student.id)).toBeNull();
  });

  it("free text with no open reflection returns home without creating rows", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_home_text",
      displayName: "Hana"
    });

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      text: "hi"
    });

    expect(replies).toEqual([homeMessage]);
    expect(store.getReflections()).toHaveLength(0);
    expect(store.getTurns()).toHaveLength(0);
  });
});

describe("Telegram model picker", () => {
  it("/model with no open reflection shows the two model buttons", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_empty",
      displayName: "Asha"
    });

    const response = await handleModelCommand({ store, student, modelRouter });

    expect(response.text).toContain("Current choice: gpt-4o-mini");
    expect(response.replyMarkup?.inline_keyboard).toEqual([
      [{ text: "gpt-4o-mini", callback_data: "model:gpt-4o-mini" }],
      [{ text: "gpt-5-mini", callback_data: "model:gpt-5-mini" }]
    ]);
  });

  it("/model with an open reflection refuses to change and names the assigned model", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_open",
      displayName: "Ben"
    });
    modelRouter.setPreference(modelRoutingKey(student), "gpt-5-mini");
    const session = await store.createReflection(student.id);
    modelRouter.setPreference(modelRoutingKey(student), "gpt-4o-mini");
    modelRouter.assignReflection(session.id, modelRoutingKey(student));

    const response = await handleModelCommand({ store, student, modelRouter });

    expect(response.text).toBe(
      "You have a reflection in progress using gpt-4o-mini. Finish it or send /new to discard it before changing models."
    );
    expect(response.replyMarkup).toBeUndefined();
  });

  it("selecting gpt-5-mini sets the preference for future reflections", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_select",
      displayName: "Chloe"
    });

    const response = await handleModelSelectionCallback({
      store,
      student,
      modelRouter,
      callbackData: "model:gpt-5-mini"
    });

    expect(response).toEqual({
      text: "New reflections will use gpt-5-mini.",
      callbackText: "New reflections will use gpt-5-mini"
    });
    expect(modelRouter.getPreference(modelRoutingKey(student))).toEqual({
      modelName: "gpt-5-mini",
      source: "manual"
    });
  });

  it("rejects an unknown model callback safely", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_unknown",
      displayName: "Devi"
    });

    const response = await handleModelSelectionCallback({
      store,
      student,
      modelRouter,
      callbackData: "model:gpt-9-mini"
    });

    expect(response).toEqual({
      text: "That model option is not available.",
      callbackText: "Model not available"
    });
    expect(modelRouter.getPreference(modelRoutingKey(student))).toEqual({
      modelName: "gpt-4o-mini",
      source: "default"
    });
  });

  it("/reflect assigns the selected model to the fresh reflection", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_new",
      displayName: "Eli"
    });
    modelRouter.setPreference(modelRoutingKey(student), "gpt-5-mini");

    await handleReflectCommand({ store, student, modelRouter });
    const session = await store.getLatestOpenReflection(student.id);

    expect(session).not.toBeNull();
    expect(modelRouter.getReflectionAssignment(session?.id ?? "")).toEqual({
      modelName: "gpt-5-mini",
      source: "manual"
    });
  });

  it("/model after /new shows buttons because the reflection was discarded", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_after_new",
      displayName: "Hui"
    });
    await handleReflectCommand({ store, student, modelRouter });
    await handleNewReflectionCommand({ store, student, modelRouter });

    const response = await handleModelCommand({ store, student, modelRouter });

    expect(response.text).toContain("Current choice: gpt-4o-mini");
    expect(response.replyMarkup?.inline_keyboard).toHaveLength(2);
  });

  it("changing preference after assignment does not affect an open reflection", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_stable",
      displayName: "Farah"
    });
    modelRouter.setPreference(modelRoutingKey(student), "gpt-4o-mini");
    const session = await store.createReflection(student.id);
    const initial = modelRouter.assignReflection(session.id, modelRoutingKey(student));

    modelRouter.setPreference(modelRoutingKey(student), "gpt-5-mini");
    const afterPreferenceChange = modelRouter.assignReflection(session.id, modelRoutingKey(student));

    expect(initial).toEqual({ modelName: "gpt-4o-mini", source: "manual" });
    expect(afterPreferenceChange).toEqual(initial);
  });

  it("does not allow callback-based model changes during an open reflection", async () => {
    const store = new InMemoryReflectionStore();
    const modelRouter = createModelRouter({});
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_model_midstream",
      displayName: "Gita"
    });
    const session = await store.createReflection(student.id);
    modelRouter.assignReflection(session.id, modelRoutingKey(student));

    const response = await handleModelSelectionCallback({
      store,
      student,
      modelRouter,
      callbackData: "model:gpt-5-mini"
    });

    expect(response).toEqual({
      text: "You have a reflection in progress using gpt-4o-mini. Finish it or send /new to discard it before changing models.",
      callbackText: "Finish or discard the current reflection first"
    });
    expect(modelRouter.getReflectionAssignment(session.id)).toEqual({
      modelName: "gpt-4o-mini",
      source: "default"
    });
  });

  it("builds LangWatch model comparison trace metadata", () => {
    expect(modelTraceAttributes({ modelName: "gpt-5-mini", source: "manual" })).toEqual({
      "reflection.model.variant": "gpt-5-mini",
      "reflection.model.assignment_source": "manual",
      "reflection.model.comparison_group": "in_situ_manual"
    });
  });
});

describe("Telegram Google Calendar linking", () => {
  it("/calendar says linking is unavailable when Google is not configured", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_calendar_unconfigured",
      displayName: "Asha"
    });

    const response = await handleCalendarCommand({
      store,
      student,
      telegramChatId: "chat-calendar",
      publicBaseUrl: "https://bot.example.com",
      enabled: false
    });

    expect(response).toEqual({ text: calendarNotConfiguredMessage });
  });

  it("/calendar creates a short-lived one-time Google connect link", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_calendar_link",
      displayName: "Ben"
    });
    const now = new Date("2026-05-11T01:00:00.000Z");

    const response = await handleCalendarCommand({
      store,
      student,
      telegramChatId: "chat-calendar",
      publicBaseUrl: "https://bot.example.com",
      enabled: true,
      now: () => now
    });
    const button = response.replyMarkup?.inline_keyboard[0]?.[0] as { url?: string } | undefined;
    const url = button?.url;
    const token = url ? new URL(url).searchParams.get("token") : null;
    const link = token
      ? await store.getValidGoogleCalendarAuthLinkByTokenHash({
          tokenHash: (await import("./tokenCrypto.js")).sha256Hex(token),
          now: "2026-05-11T01:01:00.000Z"
        })
      : null;

    expect(response.text).toContain("Connect Google Calendar");
    expect(url).toMatch(/^https:\/\/bot\.example\.com\/google-calendar\/connect\?token=/);
    expect(link).toMatchObject({
      studentId: student.id,
      telegramUserId: "tg_calendar_link",
      telegramChatId: "chat-calendar",
      expiresAt: "2026-05-11T01:10:00.000Z"
    });
  });

  it("/calendar sends localhost connect URLs as plain text instead of inline buttons", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_calendar_localhost",
      displayName: "Lin"
    });

    const response = await handleCalendarCommand({
      store,
      student,
      telegramChatId: "chat-calendar",
      publicBaseUrl: "http://localhost:8787",
      enabled: true,
      now: () => new Date("2026-05-11T01:00:00.000Z")
    });

    expect(response.replyMarkup).toBeUndefined();
    expect(response.text).toContain("Open this link on the machine running the bot:");
    expect(response.text).toMatch(/http:\/\/localhost:8787\/google-calendar\/connect\?token=/);
  });

  it("consumes Google Calendar auth states exactly once", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_calendar_consume",
      displayName: "Bea"
    });
    const created = await store.createGoogleCalendarAuthLink({
      studentId: student.id,
      telegramUserId: "tg_calendar_consume",
      telegramChatId: "chat-calendar",
      tokenHash: "token-hash",
      state: "state-token",
      expiresAt: "2026-05-11T01:10:00.000Z"
    });

    const consumed = await store.consumeGoogleCalendarAuthLinkByState({
      state: created.state,
      now: "2026-05-11T01:01:00.000Z",
      usedAt: "2026-05-11T01:01:00.000Z"
    });
    const secondConsume = await store.consumeGoogleCalendarAuthLinkByState({
      state: created.state,
      now: "2026-05-11T01:01:01.000Z",
      usedAt: "2026-05-11T01:01:01.000Z"
    });

    expect(consumed).toMatchObject({
      id: created.id,
      usedAt: "2026-05-11T01:01:00.000Z"
    });
    expect(secondConsume).toBeNull();
  });

  it("/calendar shows connected account and reconnect option", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_calendar_connected",
      displayName: "Chloe"
    });
    await store.saveGoogleCalendarConnection({
      studentId: student.id,
      googleSub: "google-sub",
      googleEmail: "chloe@example.com",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      encryptedRefreshToken: "encrypted",
      calendarId: "primary",
      connectedAt: "2026-05-11T01:00:00.000Z"
    });

    const response = await handleCalendarCommand({
      store,
      student,
      telegramChatId: "chat-calendar",
      publicBaseUrl: "https://bot.example.com",
      enabled: true
    });

    expect(response.text).toContain("chloe@example.com");
    const button = response.replyMarkup?.inline_keyboard[0]?.[0] as { text?: string } | undefined;
    expect(button?.text).toBe("Reconnect Google Calendar");
  });

  it("/disconnect_calendar marks the connection disconnected", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_calendar_disconnect",
      displayName: "Devi"
    });
    await store.saveGoogleCalendarConnection({
      studentId: student.id,
      googleSub: "google-sub",
      googleEmail: "devi@example.com",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      encryptedRefreshToken: "encrypted",
      calendarId: "primary",
      connectedAt: "2026-05-11T01:00:00.000Z"
    });

    const response = await handleDisconnectCalendarCommand({ store, student });

    expect(response).toBe(calendarDisconnectedMessage);
    expect(await store.getGoogleCalendarConnection(student.id)).toMatchObject({
      status: "disconnected",
      revokedAt: expect.any(String)
    });
    expect(await store.getEncryptedGoogleCalendarRefreshToken(student.id)).toBeNull();
  });
});

describe("Telegram safety flow", () => {
  it("persists a safety concern and pauses the reflection", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_1",
      displayName: "Asha"
    });
    const session = createInitialReflection(student.id);
    await store.saveReflection(session);
    const studentTurnId = createId("turn");

    await store.addTurn({
      id: studentTurnId,
      reflectionId: session.id,
      role: "student",
      content: "I attended an event and now I want to hurt myself",
      stage: "description",
      createdAt: new Date().toISOString()
    });

    const result = await processReflectionText({
      store,
      session,
      student,
      text: "I attended an event and now I want to kill myself",
      studentTurnId
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.safetyConcern.level).toBe("crisis");
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getSafetyConcerns()[0]?.studentTurnId).toBe(studentTurnId);
    expect(store.getSafetyConcerns()[0]?.stage).toBe("description");
    expect(store.getSafetyConcerns()[0]?.status).toBe("open");
    expect(store.getSafetyConcerns()[0]?.reason).toContain("suicidal_ideation");
  });

  it("sends safety support before the safety pause follow-up", () => {
    const replies = buildReflectionReplies({
      botMessage: safetyPauseFollowupMessage,
      safetyConcern: { hasConcern: true }
    });

    expect(replies).toEqual([
      fixedSafetySupportMessage,
      safetyPauseFollowupMessage
    ]);
  });

  it("processes a safety-triggering message inside an open reflection", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_2",
      displayName: "Ben"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      session: session ?? undefined,
      text: "I attended an event and now I want to hurt myself"
    });

    expect(replies).toEqual([
      fixedSafetySupportMessage,
      safetyPauseFollowupMessage
    ]);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "I attended an event and now I want to hurt myself",
      fixedSafetySupportMessage,
      safetyPauseFollowupMessage
    ]);
    expect(store.getTurns().map((turn) => turn.role)).toEqual(["bot", "student", "bot", "bot"]);
    expect(store.getTurns().map((turn) => turn.stage)).toEqual(["description", "description", "description", "description"]);
    const updatedSession = await store.getLatestOpenReflection(student.id);
    expect(updatedSession?.status).toBe("in_progress");
    expect(updatedSession?.currentStage).toBe("description");
    expect(updatedSession?.answers.description).toBeUndefined();
    expect(updatedSession?.safetyFlagged).toBe(true);
  });

  it("processes a normal reflection message as the description answer", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_3",
      displayName: "Chloe"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      session: session ?? undefined,
      text: "I attended a leadership workshop after school"
    });

    expect(replies).toEqual([stagePrompts.people]);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "I attended a leadership workshop after school",
      stagePrompts.people
    ]);
    expect(store.getTurns().map((turn) => turn.role)).toEqual(["bot", "student", "bot"]);
    const updatedSession = await store.getLatestOpenReflection(student.id);
    expect(updatedSession?.currentStage).toBe("people");
    expect(updatedSession?.answers.description).toBe("I attended a leadership workshop after school");
    expect(updatedSession?.safetyFlagged).toBe(false);
  });

  it("redirects dangerous instructions without advancing the stage", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_danger",
      displayName: "Kai"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      session: session ?? undefined,
      text: "how to make a bomb"
    });

    expect(replies).toEqual([
      "I can't help with making weapons or causing harm. If this is connected to something that happened, we can reflect on it safely: What happened? Share the event or experience in your own words."
    ]);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getSafetyConcerns()[0]?.reason).toContain("dangerous_instruction");
    const updatedSession = await store.getLatestOpenReflection(student.id);
    expect(updatedSession?.currentStage).toBe("description");
    expect(updatedSession?.answers.description).toBeUndefined();
    expect(updatedSession?.safetyFlagged).toBe(true);
  });

  it("varies repeated low-effort replies using recent turns", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_low",
      displayName: "Lin"
    });
    await handleReflectCommand({ store, student });
    const startSession = await store.getLatestOpenReflection(student.id);

    const first = await handleStudentReflectionMessage({
      store,
      student,
      session: startSession ?? undefined,
      text: "idk"
    });
    const session = await store.getLatestOpenReflection(student.id);
    const second = await handleStudentReflectionMessage({
      store,
      student,
      session: session ?? undefined,
      text: "ok"
    });
    const sessionAfterSecond = await store.getLatestOpenReflection(student.id);
    const third = await handleStudentReflectionMessage({
      store,
      student,
      session: sessionAfterSecond ?? undefined,
      text: "not sure"
    });

    expect(first).toEqual([
      "Got it. What was the actual event or situation you want to reflect on?"
    ]);
    expect(second).toEqual(["No stress. What is one concrete event or moment you can name?"]);
    expect(third).toEqual([
      "I think we are looping, so I will move us forward. Next: Who did you go with, or who else was involved?"
    ]);
    expect(first[0]).not.toBe(second[0]);
    expect((await store.getLatestOpenReflection(student.id))?.currentStage).toBe("people");
  });

  it("uses an adaptive model reply when available", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_4",
      displayName: "Devi"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      session: session ?? undefined,
      text: "there was this awkward thing after school",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: true,
              confidence: 0.92,
              missing: [],
              probeQuestion: "Who was there with you?",
              reason: "Student gave enough context to move on."
            } as never;
          }
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: "That sounds a bit awkward. Who was there with you?",
              referencedUserContext: true,
              questionIntent: "ask who was involved",
              reason: "Student sounded nervous"
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(replies).toEqual(["That sounds a bit awkward. Who was there with you?"]);
  });
});

describe("Telegram typing indicator manager", () => {
  it("starts immediately and refreshes while a batch is pending", async () => {
    vi.useFakeTimers();
    try {
      const typingEvents: string[] = [];
      const manager = new TypingIndicatorManager({
        sendTyping: async (chatId) => {
          typingEvents.push(chatId);
        },
        refreshMs: 4000,
        revisionPauseMs: 2000
      });

      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });

      expect(typingEvents).toEqual(["chat-1"]);
      await vi.advanceTimersByTimeAsync(3999);
      expect(typingEvents).toEqual(["chat-1"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(typingEvents).toEqual(["chat-1", "chat-1"]);

      manager.stop({ chatId: "chat-1", reflectionId: "reflection-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses for two seconds on a follow-up message, then resumes", async () => {
    vi.useFakeTimers();
    try {
      const typingEvents: string[] = [];
      const manager = new TypingIndicatorManager({
        sendTyping: async (chatId) => {
          typingEvents.push(chatId);
        },
        refreshMs: 4000,
        revisionPauseMs: 2000
      });

      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });
      await vi.advanceTimersByTimeAsync(4000);
      expect(typingEvents).toHaveLength(2);

      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });
      await vi.advanceTimersByTimeAsync(1999);
      expect(typingEvents).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(typingEvents).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(4000);
      expect(typingEvents).toHaveLength(4);

      manager.stop({ chatId: "chat-1", reflectionId: "reflection-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the pause window when more messages arrive during the pause", async () => {
    vi.useFakeTimers();
    try {
      const typingEvents: string[] = [];
      const manager = new TypingIndicatorManager({
        sendTyping: async (chatId) => {
          typingEvents.push(chatId);
        },
        refreshMs: 4000,
        revisionPauseMs: 2000
      });

      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });
      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });
      await vi.advanceTimersByTimeAsync(1000);
      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(typingEvents).toEqual(["chat-1"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(typingEvents).toEqual(["chat-1", "chat-1"]);

      manager.stop({ chatId: "chat-1", reflectionId: "reflection-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops refreshes by chat/reflection or by reflection", async () => {
    vi.useFakeTimers();
    try {
      const typingEvents: string[] = [];
      const manager = new TypingIndicatorManager({
        sendTyping: async (chatId) => {
          typingEvents.push(chatId);
        },
        refreshMs: 4000,
        revisionPauseMs: 2000
      });

      manager.noteBufferedMessage({ chatId: "chat-1", reflectionId: "reflection-1" });
      manager.noteBufferedMessage({ chatId: "chat-2", reflectionId: "reflection-2" });
      expect(manager.pendingCount()).toBe(2);

      manager.stop({ chatId: "chat-1", reflectionId: "reflection-1" });
      expect(manager.pendingCount()).toBe(1);
      manager.stop({ reflectionId: "reflection-2" });
      expect(manager.pendingCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(10000);
      expect(typingEvents).toEqual(["chat-1", "chat-2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Telegram batch flush scheduler", () => {
  it("skips interval ticks while a previous flush is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const flush = vi.fn(() => gate.promise);
      const scheduler = createTelegramBatchFlushScheduler({
        flush,
        intervalMs: 100
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(flush).toHaveBeenCalledTimes(1);
      expect(scheduler.isInFlight()).toBe(true);

      await vi.advanceTimersByTimeAsync(defaultBatchProcessingLeaseSeconds * 1000 + 5000);

      expect(flush).toHaveBeenCalledTimes(1);

      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.isInFlight()).toBe(false);

      await vi.advanceTimersByTimeAsync(100);

      expect(flush).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows later ticks after a flush rejects", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const flush = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("temporary flush failure"))
        .mockResolvedValue(undefined);
      const scheduler = createTelegramBatchFlushScheduler({
        flush,
        intervalMs: 100,
        onError
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(scheduler.isInFlight()).toBe(false);

      await vi.advanceTimersByTimeAsync(100);

      expect(flush).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Telegram reply delivery splitting", () => {
  const multiSentenceReply =
    "That sounds like a lot to hold after the hackathon. What do you think went well during the build? What felt hardest by the end?";

  it("does not split when the split rate is 0", () => {
    expect(planTelegramReplyDelivery({
      reply: multiSentenceReply,
      kind: "normal_reflection",
      splitRate: 0,
      seed: "split-off"
    })).toMatchObject({
      messages: [multiSentenceReply],
      metadata: {
        split: false,
        messageCount: 1,
        splitRate: 0
      }
    });
  });

  it("deterministically splits eligible replies at sentence boundaries", () => {
    const first = planTelegramReplyDelivery({
      reply: multiSentenceReply,
      kind: "normal_reflection",
      splitRate: 1,
      seed: "same-seed"
    });
    const second = planTelegramReplyDelivery({
      reply: multiSentenceReply,
      kind: "normal_reflection",
      splitRate: 1,
      seed: "same-seed"
    });

    expect(first).toEqual(second);
    expect(first.messages).toHaveLength(2);
    expect(first.messages.join(" ")).toBe(multiSentenceReply);
    expect(first.messages[0]).toMatch(/[.!?]$/);
    expect(first.metadata).toEqual({
      split: true,
      messageCount: 2,
      splitRate: 1
    });
  });

  it.each([
    ["safety", fixedSafetySupportMessage],
    ["safety", safetyPauseFollowupMessage],
    ["summary", "Here is a brief summary of your reflection:\nYou reflected on a hackathon.\n\nActionables:\n- Start smaller next time."],
    ["home", homeMessage],
    ["stale", staleBacklogMessage],
    ["loop_repair", "I think we are looping, so I will move us forward. Next: What did you learn about yourself, others, or the situation?"]
  ] as const)("does not split %s replies", (kind, reply) => {
    const plan = planTelegramReplyDelivery({
      reply,
      kind,
      splitRate: 1,
      seed: "forced"
    });

    expect(plan.messages).toEqual([reply]);
    expect(plan.metadata.split).toBe(false);
  });

  it("never creates more than two Telegram messages", () => {
    const reply =
      "First sentence gives enough detail for an eligible delivery split. Second sentence keeps the reply natural. Third sentence adds a little more context. Fourth sentence asks the next gentle question.";
    const plan = planTelegramReplyDelivery({
      reply,
      kind: "normal_reflection",
      splitRate: 1,
      seed: "many-sentences"
    });

    expect(plan.messages).toHaveLength(2);
    expect(plan.messages.join(" ")).toBe(reply);
  });

  it("sends split delivery messages while returning the delivery plan", async () => {
    const sent: string[] = [];
    const plan = await sendTelegramReply({
      reply: multiSentenceReply,
      kind: "normal_reflection",
      splitRate: 1,
      seed: "send-split",
      send: async (message) => {
        sent.push(message);
      }
    });

    expect(sent).toEqual(plan.messages);
    expect(sent).toHaveLength(2);
  });

  it("keeps one logical bot turn when Telegram delivery splits the reply", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_split_logical", displayName: "Asha" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const logicalReply =
      "That gives useful context about the hackathon and the people around it. Who did you go with, or who else was involved in the hackathon experience?";

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      session: session ?? undefined,
      text: "I went to a hackathon",
      model: {
        async generateJson(input) {
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: logicalReply,
              referencedUserContext: true,
              questionIntent: "ask who was involved",
              reason: "Multi-sentence delivery split candidate."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });
    const sent: string[] = [];
    await sendTelegramReply({
      reply: replies[0] ?? "",
      kind: "normal_reflection",
      splitRate: 1,
      seed: "logical-turn",
      send: async (message) => {
        sent.push(message);
      }
    });

    expect(replies).toEqual([logicalReply]);
    expect(sent).toHaveLength(2);
    expect(store.getTurns().filter((turn) => turn.role === "bot").map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      logicalReply
    ]);
  });
});

describe("Telegram debounce flow", () => {
  it("buffers two normal texts into one combined student turn and one bot reply", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_batch",
      displayName: "Asha"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const modelRouter = createModelRouter({});
    const assignment = modelRouter.assignReflection(session?.id ?? "", modelRoutingKey(student));
    const base = new Date("2026-05-10T10:00:00.000Z");

    const first = await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      modelAssignment: assignment,
      responseDelaySeconds: 5,
      text: "I went to a hackathon",
      telegramChatId: "tg_batch",
      receivedAt: base.toISOString()
    });
    const second = await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      modelAssignment: assignment,
      responseDelaySeconds: 5,
      text: "and I felt stressed but proud",
      telegramChatId: "tg_batch",
      receivedAt: new Date(base.getTime() + 2000).toISOString()
    });

    expect(first).toMatchObject({ replies: [], buffered: true });
    expect(second).toMatchObject({ replies: [], buffered: true });
    expect(store.getTurns().map((turn) => turn.content)).toEqual([stagePrompts.description]);
    expect(store.getTelegramPendingBatches()[0]?.messageCount).toBe(2);

    const sent: string[] = [];
    const flushed = await flushReadyTelegramBatches({
      store,
      modelRouter,
      now: () => new Date(base.getTime() + 10000),
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      }
    });

    expect(flushed).toBe(1);
    expect(sent).toEqual([stagePrompts.people]);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "I went to a hackathon\n\nand I felt stressed but proud",
      stagePrompts.people
    ]);
    expect(store.getTelegramPendingBatches()[0]?.status).toBe("processed");
  });

  it("stops typing refreshes when a pending batch is flushed", async () => {
    vi.useFakeTimers();
    try {
      const base = new Date("2026-05-10T10:15:00.000Z");
      vi.setSystemTime(base);
      const store = new InMemoryReflectionStore();
      const student = await store.getOrCreateStudent({
        telegramUserId: "tg_typing_flush",
        displayName: "Asha"
      });
      await handleReflectCommand({ store, student });
      const session = await store.getLatestOpenReflection(student.id);
      const modelRouter = createModelRouter({});
      const typingEvents: string[] = [];
      const typingIndicatorManager = new TypingIndicatorManager({
        sendTyping: async (chatId) => {
          typingEvents.push(chatId);
        },
        refreshMs: 4000,
        revisionPauseMs: 2000
      });

      const buffered = await handleIncomingReflectionText({
        store,
        student,
        session: session ?? undefined as never,
        responseDelaySeconds: 5,
        text: "I went to a hackathon",
        telegramChatId: "tg_typing_flush",
        receivedAt: base.toISOString()
      });
      if (buffered.batch) {
        typingIndicatorManager.noteBufferedMessage({
          chatId: buffered.batch.telegramChatId ?? "tg_typing_flush",
          reflectionId: buffered.batch.reflectionId
        });
      }

      expect(typingEvents).toEqual(["tg_typing_flush"]);
      const sent: string[] = [];
      await flushReadyTelegramBatches({
        store,
        modelRouter,
        typingIndicatorManager,
        now: () => new Date(base.getTime() + 10000),
        sendMessage: async (_chatId, text) => {
          sent.push(text);
        }
      });

      expect(sent).toEqual([stagePrompts.people]);
      expect(typingIndicatorManager.pendingCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10000);
      expect(typingEvents).toEqual(["tg_typing_flush"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses delivery splitting for worker-flushed normal replies while storing one logical turn", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_batch_split",
      displayName: "Asha"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const logicalReply =
      "That gives useful context about the hackathon and the people around it. Who did you go with, or who else was involved in the hackathon experience?";
    const modelRouter = createModelRouter({
      "gpt-4o-mini": {
        async generateJson(input) {
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: logicalReply,
              referencedUserContext: true,
              questionIntent: "ask who was involved",
              reason: "Multi-sentence delivery split candidate."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });
    const base = new Date();

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "I went to a hackathon",
      telegramChatId: "tg_batch_split",
      receivedAt: base.toISOString()
    });

    const sent: string[] = [];
    await flushReadyTelegramBatches({
      store,
      modelRouter,
      replySplitRate: 1,
      now: () => new Date(base.getTime() + 10000),
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      }
    });

    expect(sent).toHaveLength(2);
    expect(sent.join(" ")).toBe(logicalReply);
    expect(store.getTurns().filter((turn) => turn.role === "bot").map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      logicalReply
    ]);
  });

  it("waits a small grace after flush_after before claiming a batch", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_batch_grace",
      displayName: "Asha"
    });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const modelRouter = createModelRouter({});
    const base = new Date("2026-05-10T10:30:00.000Z");

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 10,
      text: "first thought",
      telegramChatId: "tg_batch_grace",
      receivedAt: base.toISOString()
    });
    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 10,
      text: "second thought",
      telegramChatId: "tg_batch_grace",
      receivedAt: new Date(base.getTime() + 5000).toISOString()
    });

    const sentBeforeGrace: string[] = [];
    const boundaryFlush = await flushReadyTelegramBatches({
      store,
      modelRouter,
      now: () => new Date(base.getTime() + 15000),
      sendMessage: async (_chatId, text) => {
        sentBeforeGrace.push(text);
      }
    });

    expect(boundaryFlush).toBe(0);
    expect(sentBeforeGrace).toEqual([]);

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 10,
      text: "third thought",
      telegramChatId: "tg_batch_grace",
      receivedAt: new Date(base.getTime() + 15000).toISOString()
    });

    expect(store.getTelegramPendingBatches()[0]?.messageCount).toBe(3);

    const sentAfterGrace: string[] = [];
    const finalFlush = await flushReadyTelegramBatches({
      store,
      modelRouter,
      now: () => new Date(base.getTime() + 28000),
      sendMessage: async (_chatId, text) => {
        sentAfterGrace.push(text);
      }
    });

    expect(finalFlush).toBe(1);
    expect(store.getTelegramPendingBatches()[0]?.status).toBe("processed");
    expect(store.getTurns().map((turn) => turn.content)).toContain("first thought\n\nsecond thought\n\nthird thought");
  });

  it("keeps alternating users in separate pending batches", async () => {
    const store = new InMemoryReflectionStore();
    const firstStudent = await store.getOrCreateStudent({ telegramUserId: "tg_alt_1", displayName: "Asha" });
    const secondStudent = await store.getOrCreateStudent({ telegramUserId: "tg_alt_2", displayName: "Ben" });
    await handleReflectCommand({ store, student: firstStudent });
    await handleReflectCommand({ store, student: secondStudent });
    const firstSession = await store.getLatestOpenReflection(firstStudent.id);
    const secondSession = await store.getLatestOpenReflection(secondStudent.id);
    const receivedAt = new Date("2026-05-10T11:00:00.000Z").toISOString();

    await handleIncomingReflectionText({
      store,
      student: firstStudent,
      session: firstSession ?? undefined as never,
      responseDelaySeconds: 5,
      text: "A message",
      telegramChatId: "tg_alt_1",
      receivedAt
    });
    await handleIncomingReflectionText({
      store,
      student: secondStudent,
      session: secondSession ?? undefined as never,
      responseDelaySeconds: 5,
      text: "B message",
      telegramChatId: "tg_alt_2",
      receivedAt
    });

    const batches = store.getTelegramPendingBatches();
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.telegramChatId).sort()).toEqual(["tg_alt_1", "tg_alt_2"]);
  });

  it("reclassifies a once-fresh pending batch as stale when claimed after downtime", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_stale_on_claim", displayName: "Farah" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const base = new Date();
    let modelCalls = 0;
    const modelRouter = createModelRouter({
      "gpt-4o-mini": {
        async generateJson(input) {
          modelCalls += 1;
          return input.fallback as never;
        }
      }
    });

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "this was sort of about my week and stuff",
      telegramChatId: "tg_stale_on_claim",
      receivedAt: base.toISOString()
    });
    expect(store.getTelegramPendingBatches()[0]?.stale).toBe(false);

    const sent: string[] = [];
    await flushReadyTelegramBatches({
      store,
      modelRouter,
      now: () => new Date(base.getTime() + 16 * 60 * 1000),
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      }
    });

    expect(sent).toEqual([staleBacklogMessage]);
    expect(modelCalls).toBe(0);
    expect((await store.getLatestOpenReflection(student.id))?.currentStage).toBe("description");
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "this was sort of about my week and stuff",
      staleBacklogMessage
    ]);
    expect(store.getTelegramPendingBatches()[0]).toMatchObject({
      status: "processed",
      stale: true
    });
  });

  it("reclaims an expired processing batch after a simulated worker crash", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_crash_reclaim", displayName: "Gita" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const base = new Date();
    const modelRouter = createModelRouter({});

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "I went to a hackathon",
      telegramChatId: "tg_crash_reclaim",
      receivedAt: base.toISOString()
    });

    await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 10_000).toISOString(),
      now: new Date(base.getTime() + 10_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    const sentBeforeExpiry: string[] = [];
    const beforeExpiry = await flushReadyTelegramBatches({
      store,
      modelRouter,
      now: () => new Date(base.getTime() + 10_000 + defaultBatchProcessingLeaseSeconds * 1000 - 1000),
      sendMessage: async (_chatId, text) => {
        sentBeforeExpiry.push(text);
      }
    });

    expect(beforeExpiry).toBe(0);
    expect(sentBeforeExpiry).toEqual([]);

    const sentAfterExpiry: string[] = [];
    const afterExpiry = await flushReadyTelegramBatches({
      store,
      modelRouter,
      now: () => new Date(base.getTime() + 10_000 + defaultBatchProcessingLeaseSeconds * 1000 + 1000),
      sendMessage: async (_chatId, text) => {
        sentAfterExpiry.push(text);
      }
    });

    expect(afterExpiry).toBe(1);
    expect(sentAfterExpiry).toEqual([stagePrompts.people]);
    expect(store.getTelegramPendingBatches()[0]).toMatchObject({
      status: "processed",
      processingExpiresAt: undefined
    });
  });

  it("response delay 0 preserves immediate processing", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_delay_zero", displayName: "Chloe" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    const result = await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 0,
      text: "I attended a leadership workshop after school",
      receivedAt: new Date().toISOString()
    });

    expect(result).toEqual({ replies: [stagePrompts.people], buffered: false });
    expect(store.getTelegramPendingBatches()).toHaveLength(0);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "I attended a leadership workshop after school",
      stagePrompts.people
    ]);
  });

  it("commands bypass debounce and are not batched as reflection text", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_command_bypass", displayName: "Devi" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    const result = await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "/continue",
      receivedAt: new Date().toISOString()
    });

    expect(result).toEqual({ replies: [], buffered: false });
    expect(store.getTelegramPendingBatches()).toHaveLength(0);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([stagePrompts.description]);
  });

  it("safety text bypasses debounce and cancels pending normal text", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_safety_bypass", displayName: "Eli" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "I went to a hackathon",
      telegramChatId: "tg_safety_bypass",
      receivedAt: new Date().toISOString()
    });
    const result = await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "I want to hurt myself",
      telegramChatId: "tg_safety_bypass",
      receivedAt: new Date().toISOString()
    });

    expect(result.replies).toEqual([fixedSafetySupportMessage, safetyPauseFollowupMessage]);
    expect(store.getTelegramPendingBatches()[0]?.status).toBe("cancelled");
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "I want to hurt myself",
      fixedSafetySupportMessage,
      safetyPauseFollowupMessage
    ]);
  });

  it("stale normal Telegram updates received after downtime get catch-up handling", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_stale_text", displayName: "Farah" });
    await handleReflectCommand({ store, student });
    const session = await store.getLatestOpenReflection(student.id);
    const oldReceivedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const modelRouter = createModelRouter({});

    await handleIncomingReflectionText({
      store,
      student,
      session: session ?? undefined as never,
      responseDelaySeconds: 5,
      text: "I wrote this while you were down",
      telegramChatId: "tg_stale_text",
      receivedAt: oldReceivedAt
    });
    const sent: string[] = [];

    await flushReadyTelegramBatches({
      store,
      modelRouter,
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      }
    });

    expect(sent).toEqual([staleBacklogMessage]);
    expect((await store.getLatestOpenReflection(student.id))?.currentStage).toBe("description");
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      stagePrompts.description,
      "I wrote this while you were down",
      staleBacklogMessage
    ]);
  });

  it("collapses stale command bursts to one delayed execution", async () => {
    vi.useFakeTimers();
    const replies: string[] = [];
    const collapser = createStaleCommandCollapser({
      now: () => new Date("2026-05-10T12:30:00.000Z"),
      staleAfterSeconds: 15 * 60,
      collapseMs: 250
    });
    const makeCtx = () => ({
      chat: { id: "chat-1" },
      from: { id: "chat-1" },
      message: { date: Math.floor(new Date("2026-05-10T12:00:00.000Z").getTime() / 1000) },
      reply: async (text: string) => {
        replies.push(text);
      }
    });

    await collapser.run(makeCtx() as never, async () => {
      replies.push("first command");
    });
    await collapser.run(makeCtx() as never, async () => {
      replies.push("latest command");
    });

    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();

    expect(replies).toEqual([staleBacklogMessage, "latest command"]);
  });

  it("detects stale Telegram message dates", () => {
    const now = new Date("2026-05-10T12:30:00.000Z");
    const stale = Math.floor(new Date("2026-05-10T12:00:00.000Z").getTime() / 1000);
    const fresh = Math.floor(new Date("2026-05-10T12:25:00.000Z").getTime() / 1000);

    expect(isStaleTelegramDate(stale, now)).toBe(true);
    expect(isStaleTelegramDate(fresh, now)).toBe(false);
  });
});

describe("Telegram pending batch store", () => {
  it("keeps a fresh ready batch non-stale when claimed before the stale threshold", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_store_fresh", displayName: "Asha" });
    const reflection = await store.createReflection(student.id);
    const base = new Date();

    await store.appendTelegramPendingBatch({
      studentId: student.id,
      reflectionId: reflection.id,
      telegramChatId: "tg_store_fresh",
      text: "fresh thought",
      receivedAt: base.toISOString(),
      delaySeconds: 5,
      staleAfterSeconds: 15 * 60
    });

    const claimed = await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 10_000).toISOString(),
      now: new Date(base.getTime() + 10_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.stale).toBe(false);
    expect(claimed[0]?.processingExpiresAt).toBe(
      new Date(base.getTime() + 10_000 + defaultBatchProcessingLeaseSeconds * 1000).toISOString()
    );
    expect(store.getTelegramPendingBatches()[0]).toMatchObject({
      status: "processing",
      stale: false
    });
  });

  it("marks a once-fresh ready batch stale when claimed after the stale threshold", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_store_stale", displayName: "Ben" });
    const reflection = await store.createReflection(student.id);
    const base = new Date();

    await store.appendTelegramPendingBatch({
      studentId: student.id,
      reflectionId: reflection.id,
      telegramChatId: "tg_store_stale",
      text: "fresh when received",
      receivedAt: base.toISOString(),
      delaySeconds: 5,
      staleAfterSeconds: 15 * 60
    });

    const claimed = await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 16 * 60 * 1000).toISOString(),
      now: new Date(base.getTime() + 16 * 60 * 1000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.stale).toBe(true);
    expect(store.getTelegramPendingBatches()[0]).toMatchObject({
      status: "processing",
      stale: true
    });
  });

  it("uses readyAt for readiness even when now would make the batch stale", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_store_ready_at", displayName: "Chloe" });
    const reflection = await store.createReflection(student.id);
    const base = new Date();

    await store.appendTelegramPendingBatch({
      studentId: student.id,
      reflectionId: reflection.id,
      telegramChatId: "tg_store_ready_at",
      text: "not ready yet",
      receivedAt: base.toISOString(),
      delaySeconds: 10,
      staleAfterSeconds: 15 * 60
    });

    const claimed = await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 9000).toISOString(),
      now: new Date(base.getTime() + 16 * 60 * 1000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    expect(claimed).toEqual([]);
    expect(store.getTelegramPendingBatches()[0]).toMatchObject({
      status: "pending",
      stale: false
    });
  });

  it("claims isolated pending batches for separate students and reflections", async () => {
    const store = new InMemoryReflectionStore();
    const firstStudent = await store.getOrCreateStudent({ telegramUserId: "tg_store_iso_1", displayName: "Devi" });
    const secondStudent = await store.getOrCreateStudent({ telegramUserId: "tg_store_iso_2", displayName: "Eli" });
    const firstReflection = await store.createReflection(firstStudent.id);
    const secondReflection = await store.createReflection(secondStudent.id);
    const base = new Date("2026-05-10T12:00:00.000Z");

    await store.appendTelegramPendingBatch({
      studentId: firstStudent.id,
      reflectionId: firstReflection.id,
      telegramChatId: "tg_store_iso_1",
      text: "first",
      receivedAt: base.toISOString(),
      delaySeconds: 5,
      staleAfterSeconds: 15 * 60
    });
    await store.appendTelegramPendingBatch({
      studentId: secondStudent.id,
      reflectionId: secondReflection.id,
      telegramChatId: "tg_store_iso_2",
      text: "second",
      receivedAt: base.toISOString(),
      delaySeconds: 5,
      staleAfterSeconds: 15 * 60
    });

    const claimed = await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 10_000).toISOString(),
      now: new Date(base.getTime() + 10_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    expect(claimed.map((batch) => batch.telegramChatId).sort()).toEqual(["tg_store_iso_1", "tg_store_iso_2"]);
    expect(new Set(claimed.map((batch) => batch.reflectionId)).size).toBe(2);
  });

  it("does not reclaim a processing batch before its lease expires", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_store_lease_active", displayName: "Hana" });
    const reflection = await store.createReflection(student.id);
    const base = new Date();

    await store.appendTelegramPendingBatch({
      studentId: student.id,
      reflectionId: reflection.id,
      telegramChatId: "tg_store_lease_active",
      text: "leased",
      receivedAt: base.toISOString(),
      delaySeconds: 5,
      staleAfterSeconds: 15 * 60
    });
    await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 10_000).toISOString(),
      now: new Date(base.getTime() + 10_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    const reclaimed = await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 20_000).toISOString(),
      now: new Date(base.getTime() + 20_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    expect(reclaimed).toEqual([]);
  });

  it("reclaims a processing batch after its lease expires and renews the lease", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_store_lease_expired", displayName: "Isa" });
    const reflection = await store.createReflection(student.id);
    const base = new Date();

    await store.appendTelegramPendingBatch({
      studentId: student.id,
      reflectionId: reflection.id,
      telegramChatId: "tg_store_lease_expired",
      text: "leased",
      receivedAt: base.toISOString(),
      delaySeconds: 5,
      staleAfterSeconds: 15 * 60
    });
    await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 10_000).toISOString(),
      now: new Date(base.getTime() + 10_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    const reclaimNow = new Date(base.getTime() + 10_000 + defaultBatchProcessingLeaseSeconds * 1000 + 1000);
    const reclaimed = await store.claimReadyTelegramPendingBatches({
      readyAt: reclaimNow.toISOString(),
      now: reclaimNow.toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      status: "processing",
      stale: false,
      processingExpiresAt: new Date(reclaimNow.getTime() + defaultBatchProcessingLeaseSeconds * 1000).toISOString()
    });
  });

  it("clears processing leases when releasing, processing, or cancelling batches", async () => {
    const store = new InMemoryReflectionStore();
    const firstStudent = await store.getOrCreateStudent({ telegramUserId: "tg_store_clear_1", displayName: "Jun" });
    const secondStudent = await store.getOrCreateStudent({ telegramUserId: "tg_store_clear_2", displayName: "Kai" });
    const thirdStudent = await store.getOrCreateStudent({ telegramUserId: "tg_store_clear_3", displayName: "Lin" });
    const firstReflection = await store.createReflection(firstStudent.id);
    const secondReflection = await store.createReflection(secondStudent.id);
    const thirdReflection = await store.createReflection(thirdStudent.id);
    const base = new Date();

    for (const [student, reflection, chatId] of [
      [firstStudent, firstReflection, "tg_store_clear_1"],
      [secondStudent, secondReflection, "tg_store_clear_2"],
      [thirdStudent, thirdReflection, "tg_store_clear_3"]
    ] as const) {
      await store.appendTelegramPendingBatch({
        studentId: student.id,
        reflectionId: reflection.id,
        telegramChatId: chatId,
        text: chatId,
        receivedAt: base.toISOString(),
        delaySeconds: 5,
        staleAfterSeconds: 15 * 60
      });
    }

    const claimed = await store.claimReadyTelegramPendingBatches({
      readyAt: new Date(base.getTime() + 10_000).toISOString(),
      now: new Date(base.getTime() + 10_000).toISOString(),
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: defaultBatchProcessingLeaseSeconds,
      limit: 10
    });
    const [releaseBatch, processedBatch] = claimed;

    await store.releaseTelegramPendingBatch(releaseBatch?.id ?? "", new Date(base.getTime() + 20_000).toISOString());
    await store.markTelegramPendingBatchProcessed(processedBatch?.id ?? "");
    await store.cancelTelegramPendingBatch({
      studentId: thirdStudent.id,
      reflectionId: thirdReflection.id,
      reason: "test_cancel"
    });

    const batches = store.getTelegramPendingBatches();
    expect(batches.every((batch) => batch.processingExpiresAt === undefined)).toBe(true);
    expect(batches.map((batch) => batch.status).sort()).toEqual(["cancelled", "pending", "processed"]);
  });
});
