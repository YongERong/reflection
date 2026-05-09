import { describe, expect, it } from "vitest";
import { createId, createInitialReflection, fixedSafetySupportMessage, stagePrompts } from "@reflection/core";
import {
  buildReflectionReplies,
  handleNewReflectionCommand,
  handleReflectCommand,
  handleStudentReflectionMessage,
  openReflectionMessage,
  processReflectionText
} from "./bot.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";

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

  it("/new abandons the open reflection and creates one fresh reflection", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_new_1",
      displayName: "Chloe"
    });

    await handleReflectCommand({ store, student });
    const oldReflection = store.getReflections()[0];
    const replies = await handleNewReflectionCommand({ store, student });
    const reflections = store.getReflections();

    expect(replies).toEqual([stagePrompts.description]);
    expect(reflections).toHaveLength(2);
    expect(reflections.find((reflection) => reflection.id === oldReflection?.id)?.status).toBe("abandoned");
    expect(reflections.filter((reflection) => reflection.status === "in_progress")).toHaveLength(1);
    expect(await store.getLatestOpenReflection(student.id)).not.toBeNull();
    expect(store.getTurns()).toHaveLength(2);
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

    expect(replies).toEqual([stagePrompts.description]);
    expect(reflections.find((reflection) => reflection.id === first.id)?.status).toBe("abandoned");
    expect(reflections.find((reflection) => reflection.id === second.id)?.status).toBe("abandoned");
    expect(reflections.filter((reflection) => reflection.status === "in_progress")).toHaveLength(1);
  });

  it("/new with no open reflection behaves like /reflect", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_new_2",
      displayName: "Devi"
    });

    const replies = await handleNewReflectionCommand({ store, student });

    expect(replies).toEqual([stagePrompts.description]);
    expect(store.getReflections()).toHaveLength(1);
    expect(store.getReflections()[0]?.status).toBe("in_progress");
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
});

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
      text: "I attended an event and now I want to kill myself",
      studentTurnId
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.safetyConcern.level).toBe("crisis");
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.session.currentStage).toBe("people");
    expect(result.botMessage).toBe(
      "I'm here with you. We can keep this gentle. For now: Who did you go with, or who else was involved?"
    );
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getSafetyConcerns()[0]?.studentTurnId).toBe(studentTurnId);
  });

  it("sends safety support before the normal Gibbs reply", () => {
    const replies = buildReflectionReplies({
      botMessage: stagePrompts.people,
      safetyConcern: { hasConcern: true }
    });

    expect(replies).toEqual([
      fixedSafetySupportMessage,
      stagePrompts.people
    ]);
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

    expect(replies).toEqual([
      fixedSafetySupportMessage,
      "I'm here with you. We can keep this gentle. For now: Who did you go with, or who else was involved?"
    ]);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getTurns().map((turn) => turn.content)).toEqual([
      "I attended an event and now I want to hurt myself",
      fixedSafetySupportMessage,
      "I'm here with you. We can keep this gentle. For now: Who did you go with, or who else was involved?"
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

  it("redirects dangerous instructions without advancing the stage", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_danger",
      displayName: "Kai"
    });

    const replies = await handleStudentReflectionMessage({
      store,
      student,
      text: "how to make a bomb"
    });

    expect(replies).toEqual([
      "I can't help with making weapons or causing harm. If this is connected to something that happened, we can reflect on it safely: What happened? Share the event or experience in your own words."
    ]);
    expect(store.getSafetyConcerns()).toHaveLength(1);
    expect(store.getSafetyConcerns()[0]?.reason).toContain("dangerous_instruction");
    const session = await store.getLatestOpenReflection(student.id);
    expect(session?.currentStage).toBe("description");
    expect(session?.answers.description).toBeUndefined();
    expect(session?.safetyFlagged).toBe(true);
  });

  it("varies repeated low-effort replies using recent turns", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({
      telegramUserId: "tg_low",
      displayName: "Lin"
    });

    const first = await handleStudentReflectionMessage({
      store,
      student,
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
    expect(second).toEqual(["No stress. What was the actual event or situation you want to reflect on?"]);
    expect(third).toEqual([
      "No worries, we can keep moving. Who did you go with, or who else was involved?"
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

    const replies = await handleStudentReflectionMessage({
      store,
      student,
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
          if (input.task === "adaptive_reflection_reply") {
            return {
              stageComplete: true,
              reply: "That sounds a bit awkward. Who was there with you?",
              tone: "peer_coach",
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
