import { describe, expect, it } from "vitest";
import { createId, createInitialReflection, fixedSafetySupportMessage, safetyPauseFollowupMessage, stagePrompts } from "@reflection/core";
import {
  buildReflectionReplies,
  discardedReflectionMessage,
  handleModelCommand,
  handleModelSelectionCallback,
  handleNewReflectionCommand,
  handleReflectCommand,
  handleStudentReflectionMessage,
  homeMessage,
  modelTraceAttributes,
  openReflectionMessage,
  processReflectionText
} from "./bot.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";
import { createModelRouter } from "./modelRouter.js";

function modelRoutingKey(student: { id: string; telegramUserId?: string }) {
  return student.telegramUserId ?? student.id;
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
