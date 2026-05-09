import { describe, expect, it } from "vitest";
import { createId, createInitialReflection, fixedSafetySupportMessage, stagePrompts } from "@reflection/core";
import { buildReflectionReplies, handleStudentReflectionMessage, processReflectionText } from "./bot.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";

describe("Telegram safety flow", () => {
  it("persists a safety concern and continues the reflection", async () => {
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
      text: "I attended an event and now I want to hurt myself",
      studentTurnId
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.session.currentStage).toBe("people");
    expect(result.botMessage).toBe(stagePrompts.people);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getSafetyConcerns()[0]?.studentTurnId).toBe(studentTurnId);
  });

  it("sends safety support before the normal Gibbs reply", () => {
    const replies = buildReflectionReplies({
      botMessage: stagePrompts.people,
      safetyConcern: { hasConcern: true }
    });

    expect(replies).toEqual([fixedSafetySupportMessage, stagePrompts.people]);
  });

  it("processes a safety-triggering first free-text message", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_2",
      displayName: "Ben"
    });

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      text: "I attended an event and now I want to hurt myself"
    });

    expect(replies).toEqual([fixedSafetySupportMessage, stagePrompts.people]);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      "I attended an event and now I want to hurt myself",
      fixedSafetySupportMessage,
      stagePrompts.people
    ]);
    expect(store.getTurns().map((turn) => turn.role)).toEqual(["student", "bot", "bot"]);
    const session = await store.getLatestOpenReflection(student.id);
    expect(session?.currentStage).toBe("people");
    expect(session?.safetyFlagged).toBe(true);
  });

  it("processes a normal first free-text message as the description answer", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_3",
      displayName: "Chloe"
    });

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      text: "I attended a leadership workshop after school"
    });

    expect(replies).toEqual([stagePrompts.people]);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      "I attended a leadership workshop after school",
      stagePrompts.people
    ]);
    expect(store.getTurns().map((turn) => turn.role)).toEqual(["student", "bot"]);
    const session = await store.getLatestOpenReflection(student.id);
    expect(session?.currentStage).toBe("people");
    expect(session?.answers.description).toBe("I attended a leadership workshop after school");
    expect(session?.safetyFlagged).toBe(false);
  });
});
