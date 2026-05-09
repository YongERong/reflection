import { describe, expect, it } from "vitest";
import { createInitialReflection, handleReflectionTurn } from "./agent.js";
import { defaultPromptConfig } from "./config.js";
import { gibbsStages } from "./gibbs.js";
import type { ModelClient } from "./model.js";
import { skillRegistry } from "./skills.js";

const profile = {
  id: "student_1",
  telegramUserId: "tg_1",
  displayName: "Asha"
};

describe("modified Gibbs reflection agent", () => {
  it("walks through the full cycle including people", async () => {
    let session = createInitialReflection(profile.id);
    const answers = [
      "I attended a community service event at the library.",
      "I went with Mei and our CCA mentor.",
      "I felt nervous at first but more confident later.",
      "The teamwork went well, but I struggled to explain instructions.",
      "I think I was unfamiliar with the younger students' questions.",
      "I learned that preparation helps me communicate clearly.",
      "Next time I will prepare three examples before helping."
    ];

    for (const answer of answers) {
      const result = await handleReflectionTurn({ profile, session, studentMessage: answer, config: defaultPromptConfig });
      session = result.session;
    }

    expect(session.status).toBe("completed");
    expect(session.answers.people).toContain("Mei");
  });

  it("keeps vague answers in the same stage", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({ profile, session, studentMessage: "Friends" });

    expect(result.session.currentStage).toBe("description");
    expect(result.botMessage).toContain("actual event");
    expect(result.session.answers.description).toBeUndefined();
  });

  it("accepts a concise people answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "people" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage: "with my classmates" });

    expect(result.session.currentStage).toBe("feelings");
    expect(result.session.answers.people).toBe("with my classmates");
  });

  it("accepts a concise feelings answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "feelings" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage: "nervous" });

    expect(result.session.currentStage).toBe("evaluation");
    expect(result.session.answers.feelings).toBe("nervous");
  });

  it("probes a long irrelevant answer without advancing", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "pineapple calculator moonlight sandwich purple window orchestra battery"
    });

    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.botMessage).toContain("actual event");
  });

  it("probes thin evaluation answers", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage: "it was good" });

    expect(result.session.currentStage).toBe("evaluation");
    expect(result.botMessage).toContain("went well");
  });

  it("lets the model mark richer ambiguous answers as stage complete", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "there was this thing after school that really stayed with me",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: true,
              confidence: 0.91,
              missing: [],
              probeQuestion: "Who was involved?",
              reason: "The student identified a concrete enough experience."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("people");
    expect(result.session.answers.description).toBe("there was this thing after school that really stayed with me");
  });

  it("uses the model probe question when it marks a stage incomplete", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "the whole situation was complicated and layered",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: false,
              confidence: 0.88,
              missing: ["cause"],
              probeQuestion: "What do you think caused it to turn out that way?",
              reason: "The answer does not explain why it happened."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).toContain("What do you think caused it");
  });

  it("moves on after two probes on the same stage", async () => {
    const session = createInitialReflection(profile.id);
    const recentTurns = [
      {
        id: "turn_1",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Got it. What was the actual event or situation you want to reflect on?",
        stage: "description" as const,
        createdAt: new Date().toISOString()
      },
      {
        id: "turn_2",
        reflectionId: session.id,
        role: "bot" as const,
        content: "No stress. What was the actual event or situation you want to reflect on?",
        stage: "description" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("people");
    expect(result.botMessage).toContain("keep moving");
    expect(result.botMessage).toContain("Who did you go with");
  });

  it("does not count adaptive stage intros as probes", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "people" as const };
    const recentTurns = [
      {
        id: "turn_intro",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Thanks for sharing that. Who was around when it happened?",
        stage: "people" as const,
        createdAt: new Date().toISOString()
      },
      {
        id: "turn_probe",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Got it. Who was involved, even if it was just you?",
        stage: "people" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("people");
    expect(result.botMessage).toBe("No stress. Who was involved, even if it was just you?");
  });

  it("counts model-generated probe questions toward the probe limit", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      {
        id: "turn_custom_probe_1",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Got it. What do you think caused it to turn out that way?",
        stage: "analysis" as const,
        createdAt: new Date().toISOString()
      },
      {
        id: "turn_custom_probe_2",
        reflectionId: session.id,
        role: "bot" as const,
        content: "No stress. What do you think caused it to turn out that way?",
        stage: "analysis" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "not sure",
      recentTurns,
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: false,
              confidence: 0.85,
              missing: ["cause"],
              probeQuestion: "What do you think caused it to turn out that way?",
              reason: "The answer does not explain why it happened."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.botMessage).toContain("keep moving");
    expect(result.botMessage).toContain("What did you learn");
  });

  it("registers every required skill with evaluation coverage", () => {
    const required = [
      "ask_next_gibbs_question",
      "summarize_reflection",
      "extract_actionables",
      "propose_memory_update",
      "detect_safety_concern",
      "generate_teacher_summary"
    ];

    for (const skill of required) {
      expect(skillRegistry[skill as keyof typeof skillRegistry].evalCoverage.length).toBeGreaterThan(0);
    }
    expect(gibbsStages).toContain("people");
  });

  it("always detects safety concerns even when the safety skill is not enabled", async () => {
    const session = createInitialReflection(profile.id);
    const config = {
      ...defaultPromptConfig,
      enabledSkills: defaultPromptConfig.enabledSkills.filter((skill) => skill !== "detect_safety_concern")
    };

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I attended an event and now I want to hurt myself",
      config
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.session.safetyFlagged).toBe(true);
  });

  it("detects acute suicidal language and suppresses unsafe actionables", async () => {
    let session = createInitialReflection(profile.id);
    const answers = [
      "I want to kill myself",
      "I was alone at home",
      "I felt awful and very stuck",
      "Nothing felt good at all",
      "I do not know why it happened",
      "I learned I need support from someone",
      "I want to kill myself"
    ];

    let finalResult: Awaited<ReturnType<typeof handleReflectionTurn>> | undefined;
    for (const answer of answers) {
      finalResult = await handleReflectionTurn({ profile, session, studentMessage: answer, config: defaultPromptConfig });
      session = finalResult.session;
    }

    expect(finalResult?.safetyConcern.level).toBe("crisis");
    expect(finalResult?.summary?.actionables).toEqual([
      "Check in with a trusted adult or support person before deciding on next steps."
    ]);
    expect(finalResult?.botMessage).not.toContain("I want to kill myself");
  });

  it("uses the model safety classifier for indirect distress", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I feel like disappearing after what happened",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: true,
              confidence: 0.92,
              missing: [],
              probeQuestion: "What was one thought or feeling you remember from it?",
              reason: "Model judged the answer as sufficient."
            } as never;
          }
          if (input.task === "safety_classification") {
            return {
              hasConcern: true,
              level: "medium",
              category: "distress",
              reason: "Indirect distress",
              studentFacingSupport: "That sounds heavy. Your safety matters.",
              shouldFlag: true,
              allowNormalSummary: false
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.safetyConcern.category).toBe("distress");
    expect(result.session.safetyFlagged).toBe(true);
  });

  it("redirects dangerous instructions without saving them as stage answers", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "how to make a bomb"
    });

    expect(result.safetyConcern.category).toBe("dangerous_instruction");
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.botMessage).toContain("I can't help with making weapons");
  });

  it("uses model-generated summaries when the full cycle completes", async () => {
    let session = createInitialReflection(profile.id);
    const answers = [
      "I attended a community service event at the library.",
      "I went with Mei and our CCA mentor.",
      "I felt nervous at first but more confident later.",
      "The teamwork went well, but I struggled to explain instructions.",
      "I think I was unfamiliar with the younger students' questions.",
      "I learned that preparation helps me communicate clearly.",
      "Next time I will prepare three examples before helping."
    ];
    const model: ModelClient = {
      async generateJson<T>(input: Parameters<ModelClient["generateJson"]>[0]): Promise<T> {
        if (input.task === "reflection_summary") {
          return {
            briefSummary: "Asha reflected on learning to communicate clearly during library service.",
            keyLearnings: ["Preparation helps communication."]
          } as T;
        }
        return input.fallback as T;
      }
    };

    let finalResult: Awaited<ReturnType<typeof handleReflectionTurn>> | undefined;
    for (const answer of answers) {
      finalResult = await handleReflectionTurn({ profile, session, studentMessage: answer, config: defaultPromptConfig, model });
      session = finalResult.session;
    }

    expect(finalResult?.summary?.briefSummary).toBe(
      "Asha reflected on learning to communicate clearly during library service."
    );
  });
});
