import { describe, expect, it } from "vitest";
import { createInitialReflection, handleReflectionTurn } from "./agent.js";
import { defaultPromptConfig } from "./config.js";
import { gibbsStages } from "./gibbs.js";
import { skillRegistry } from "./skills.js";

const profile = {
  id: "student_1",
  telegramUserId: "tg_1",
  displayName: "Asha"
};

describe("modified Gibbs reflection agent", () => {
  it("walks through the full cycle including people", () => {
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
      const result = handleReflectionTurn({ profile, session, studentMessage: answer, config: defaultPromptConfig });
      session = result.session;
    }

    expect(session.status).toBe("completed");
    expect(session.answers.people).toContain("Mei");
  });

  it("keeps vague answers in the same stage", () => {
    const session = createInitialReflection(profile.id);
    const result = handleReflectionTurn({ profile, session, studentMessage: "Friends" });

    expect(result.session.currentStage).toBe("description");
    expect(result.botMessage).toContain("Could you share a little more");
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

  it("always detects safety concerns even when the safety skill is not enabled", () => {
    const session = createInitialReflection(profile.id);
    const config = {
      ...defaultPromptConfig,
      enabledSkills: defaultPromptConfig.enabledSkills.filter((skill) => skill !== "detect_safety_concern")
    };

    const result = handleReflectionTurn({
      profile,
      session,
      studentMessage: "I attended an event and now I want to hurt myself",
      config
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.session.safetyFlagged).toBe(true);
  });
});
