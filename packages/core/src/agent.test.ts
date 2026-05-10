import { describe, expect, it } from "vitest";
import { createInitialReflection, evaluateStageSufficiency, handleReflectionTurn, safetyPauseFollowupMessage } from "./agent.js";
import { defaultPromptConfig } from "./config.js";
import { gibbsStages } from "./gibbs.js";
import type { ModelClient } from "./model.js";
import { skillRegistry } from "./skills.js";

const profile = {
  id: "student_1",
  telegramUserId: "tg_1",
  displayName: "Asha"
};

function makeTurn(role: "student" | "bot", stage: ReturnType<typeof createInitialReflection>["currentStage"], content: string) {
  return {
    id: `${role}_${stage}_${content.slice(0, 8).replace(/\W/g, "_")}`,
    reflectionId: "test_reflection",
    role,
    stage,
    content,
    createdAt: new Date().toISOString()
  };
}

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

  it("accepts a concise named event in description", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({ profile, session, studentMessage: "a hackathon" });

    expect(result.session.currentStage).toBe("people");
    expect(result.session.answers.description).toBe("a hackathon");
  });

  it("accepts a concise people answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "people" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage: "with my classmates" });

    expect(result.session.currentStage).toBe("feelings");
    expect(result.session.answers.people).toBe("with my classmates");
  });

  it("accepts just me as a people answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "people" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage: "just me" });

    expect(result.session.currentStage).toBe("feelings");
    expect(result.session.answers.people).toBe("just me");
  });

  it("accepts a concise feelings answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "feelings" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage: "nervous" });

    expect(result.session.currentStage).toBe("evaluation");
    expect(result.session.answers.feelings).toBe("nervous");
  });

  it.each([
    ["excitement", "excitement"],
    ["tired lah chat", "tired"]
  ])("accepts casual one-word feelings without echoing filler: %s", async (studentMessage, storedAnswer) => {
    const session = { ...createInitialReflection(profile.id), currentStage: "feelings" as const };
    const result = await handleReflectionTurn({ profile, session, studentMessage });

    expect(result.session.currentStage).toBe("evaluation");
    expect(result.session.answers.feelings).toBe(storedAnswer);
    expect(result.botMessage).not.toContain('I hear "');
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

  it.each(["it went spectacularly well", "something that went well", "it went badly"])(
    "accepts clear evaluation answer: %s",
    async (studentMessage) => {
      const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
      const result = await handleReflectionTurn({ profile, session, studentMessage });

      expect(result.session.currentStage).toBe("analysis");
      expect(result.session.answers.evaluation).toBe(studentMessage);
    }
  );

  it("uses yes as confirmation of the previous meaningful evaluation answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
    const recentTurns = [
      {
        id: "student_eval",
        reflectionId: session.id,
        role: "student" as const,
        content: "it went spectacularly well",
        stage: "evaluation" as const,
        createdAt: new Date().toISOString()
      },
      {
        id: "bot_probe",
        reflectionId: session.id,
        role: "bot" as const,
        content: 'I hear "it went spectacularly well". Was that something that went well, or something that did not?',
        stage: "evaluation" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "yes", recentTurns });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.session.answers.evaluation).toBe("it went spectacularly well");
  });

  it.each(["didn't go well ofc", "did not"])(
    "accepts contextual negative evaluation answer: %s",
    async (studentMessage) => {
      const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
      const result = await handleReflectionTurn({ profile, session, studentMessage });

      expect(result.session.currentStage).toBe("analysis");
      expect(result.session.answers.evaluation).toContain("did");
    }
  );

  it("uses no as a contextual negative evaluation confirmation", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
    const recentTurns = [
      {
        id: "student_eval_negative",
        reflectionId: session.id,
        role: "student" as const,
        content: "planned too many features and did not submit",
        stage: "evaluation" as const,
        createdAt: new Date().toISOString()
      },
      {
        id: "bot_eval_probe",
        reflectionId: session.id,
        role: "bot" as const,
        content: 'I hear "planned too many features and did not submit". Was that something that went well, or something that did not?',
        stage: "evaluation" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "no", recentTurns });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.session.answers.evaluation).toBe("planned too many features and did not submit");
  });

  it.each(["idk, u tell me", "what are you saying abt my momma", "j", "k", "yes"])(
    "does not false-positive safety or advance on filler/playful text: %s",
    async (studentMessage) => {
      const session = createInitialReflection(profile.id);
      const result = await handleReflectionTurn({
        profile,
        session,
        studentMessage,
        model: {
          async generateJson(input) {
            if (input.task === "safety_classification") {
              return {
                hasConcern: true,
                level: "high",
                category: "distress",
                reason: "Over-eager model distress match",
                studentFacingSupport: "Safety support",
                shouldFlag: true,
                allowNormalSummary: false
              } as never;
            }
            return input.fallback as never;
          }
        }
      });

      expect(result.safetyConcern.hasConcern).toBe(false);
      expect(result.session.safetyFlagged).toBe(false);
      expect(result.session.currentStage).toBe("description");
      expect(result.session.answers.description).toBeUndefined();
      expect(result.botMessage).not.toContain("immediate danger");
      expect(result.botMessage).not.toContain('I hear "');
    }
  );

  it("steers playful people-stage replies back without advancing or storing them", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "people" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "joe mama"
    });

    expect(result.session.currentStage).toBe("people");
    expect(result.session.answers.people).toBeUndefined();
    expect(result.botMessage.toLowerCase()).toContain("reflection");
  });

  it("does not repeat meme names literally in people-stage replies", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "people" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "joe mama"
    });

    expect(result.botMessage.toLowerCase()).not.toContain("joe mama");
  });

  it("accepts semantic conclusion takeaways without requiring the word learned", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "conclusion" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "manage my time and expectations under pressure"
    });

    expect(result.session.currentStage).toBe("action_plan");
    expect(result.session.answers.conclusion).toBe("manage my time and expectations under pressure");
  });

  it("accepts natural action plans without requiring will or next time", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "action_plan" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "apply this to the next hackathon I join"
    });

    expect(result.session.status).toBe("completed");
    expect(result.session.answers.action_plan).toBe("apply this to the next hackathon I join");
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

  it("routes semantic analysis answers through the sufficiency judge instead of keyword gates", async () => {
    const semanticAnswers = [
      "I wanted to make full use of the hackathon and the resources offered",
      "I was overconfident in my abilities",
      "having vibe coding tools",
      "I was too overzealous and did not take into account my reduced time"
    ];
    const calls: string[] = [];
    const model: ModelClient = {
      async generateJson(input) {
        calls.push(input.task);
        if (input.task === "stage_sufficiency") {
          return {
            stageComplete: true,
            confidence: 0.92,
            missing: [],
            probeQuestion: "What is one thing you learned from it?",
            reason: "The answer gives a plausible cause or constraint."
          } as never;
        }
        return input.fallback as never;
      }
    };

    for (const studentMessage of semanticAnswers) {
      const result = await evaluateStageSufficiency({
        stage: "analysis",
        studentMessage,
        answers: {},
        recentTurns: [],
        model
      });

      expect(result.stageComplete).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    }

    expect(calls.filter((task) => task === "stage_sufficiency")).toHaveLength(semanticAnswers.length);
  });

  it("keeps obvious junk incomplete without asking the semantic judge", async () => {
    let calls = 0;
    const acceptingModel: ModelClient = {
      async generateJson(input) {
        calls += 1;
        return {
          stageComplete: true,
          confidence: 0.99,
          missing: [],
          probeQuestion: "What is one thing you learned from it?",
          reason: "Should not be trusted for hard rejects."
        } as never;
      }
    };

    for (const studentMessage of ["a sussy baka", "idk", "bruh", "I guess"]) {
      const result = await evaluateStageSufficiency({
        stage: "analysis",
        studentMessage,
        answers: {},
        recentTurns: [],
        model: acceptingModel
      });

      expect(result.stageComplete).toBe(false);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    }

    expect(calls).toBe(0);
  });

  it("advances from analysis when the sufficiency judge accepts a semantic cause", async () => {
    const session = {
      ...createInitialReflection(profile.id),
      currentStage: "analysis" as const,
      answers: {
        description: "hackathon",
        people: "myself",
        feelings: "excited",
        evaluation: "I planned too many features and did not submit"
      }
    };

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I wanted to make full use of the hackathon and the resources offered",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: true,
              confidence: 0.93,
              missing: [],
              probeQuestion: "What is one thing you learned from it?",
              reason: "This names the motivation behind the outcome."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.session.answers.analysis).toBe("I wanted to make full use of the hackathon and the resources offered");
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

  it("replaces model replies that ask the wrong stage question", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I attended an AI engineer hackathon",
      model: {
        async generateJson(input) {
          if (input.task === "adaptive_reflection_reply") {
            return {
              stageComplete: true,
              reply: "That sounds exciting. What was your role and how did you feel about it?",
              tone: "peer_coach",
              reason: "Wrong-stage reply"
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("people");
    expect(result.botMessage).toContain("Who");
    expect(result.botMessage).not.toContain("how did you feel");
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
    expect(result.botMessage).toContain("looping");
    expect(result.botMessage).toContain("Who did you go with");
  });

  it("counts contextual same-stage questions as probes for loop repair", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?"),
      makeTurn("bot", "analysis", "It sounds like the tooling made the scope feel manageable. What made you trust that?")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.botMessage).toContain("looping");
    expect(result.botMessage).toContain("What did you learn");
  });

  it("counts mixed legacy and contextual probes for loop repair", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("bot", "analysis", "Got it. Why do you think it happened that way?"),
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "not sure", recentTurns });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.botMessage).toContain("looping");
  });

  it("uses a prior meaningful analysis answer in loop repair copy", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("student", "analysis", "overconfidence and time pressure"),
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?"),
      makeTurn("bot", "analysis", "It sounds like overconfidence was involved. What made that happen?")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.session.answers.analysis).toBe("overconfidence and time pressure");
    expect(result.botMessage).toContain("circling the same cause");
    expect(result.botMessage).toContain("overconfidence and time pressure");
    expect(result.botMessage).toContain("What are you taking from this?");
  });

  it("uses generic loop repair copy without inventing a cause when there is no prior meaningful answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?"),
      makeTurn("bot", "analysis", "It sounds like the tooling made the scope feel manageable. What made you trust that?")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.botMessage).toContain("I think we are looping");
    expect(result.botMessage).not.toContain("same cause");
  });

  it("preserves loop repair fallback when the contextual composer returns an invalid reply", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("student", "analysis", "overconfidence and time pressure"),
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?"),
      makeTurn("bot", "analysis", "It sounds like overconfidence was involved. What made that happen?")
    ];

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "idk",
      recentTurns,
      model: {
        async generateJson(input) {
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: "Sounds stressful. Who was involved with you?",
              referencedUserContext: true,
              questionIntent: "ask who was involved",
              reason: "Wrong stage for loop repair."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.botMessage).toContain("circling the same cause");
    expect(result.botMessage).not.toContain("Who was involved");
    expect(result.botMessage).not.toContain("That points");
    expect(result.botMessage).not.toContain("That helps");
  });

  it("replaces exact repeated normal probes without treating that as semantic loop repair", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const repeatedProbe = "That helps. Why do you think it happened that way?";
    const recentTurns = [
      makeTurn("bot", "analysis", repeatedProbe)
    ];

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "idk",
      recentTurns,
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: false,
              confidence: 0.9,
              missing: ["cause"],
              probeQuestion: "Why do you think it happened that way?",
              reason: "Needs a cause."
            } as never;
          }
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: repeatedProbe,
              referencedUserContext: false,
              questionIntent: "ask why it happened that way",
              reason: "Bad duplicate model reply."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).not.toBe(repeatedProbe);
    expect(result.botMessage).toContain("Why do you think it happened that way?");
    expect(result.diagnostics?.replyGuard).toMatchObject({
      exactRepeat: true,
      action: "alternate_probe",
      originalReply: repeatedProbe
    });
    expect(result.diagnostics?.loop.semanticProbeCount).toBe(1);
    expect(result.diagnostics?.loop.semanticLoop).toBe(false);
  });

  it("does not rewrite fixed safety copy even if it appeared recently", async () => {
    const session = createInitialReflection(profile.id);
    const recentTurns = [
      makeTurn("bot", "description", safetyPauseFollowupMessage)
    ];

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I want to hurt myself",
      recentTurns
    });

    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
    expect(result.diagnostics?.replyGuard).toMatchObject({
      exactRepeat: false,
      action: "none"
    });
  });

  it("does not repeat identical fallback text more than twice across a loop repair transcript", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const repeatedProbe = "It sounds like time pressure was part of it. What do you think led to that?";
    const recentTurns = [
      makeTurn("student", "analysis", "overconfidence and time pressure"),
      makeTurn("bot", "analysis", repeatedProbe),
      makeTurn("bot", "analysis", repeatedProbe)
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });
    const transcriptReplies = [
      ...recentTurns.filter((turn) => turn.role === "bot").map((turn) => turn.content),
      result.botMessage
    ];
    const maxRepeats = Math.max(...transcriptReplies.map((reply) => transcriptReplies.filter((item) => item === reply).length));

    expect(result.session.currentStage).toBe("conclusion");
    expect(maxRepeats).toBeLessThanOrEqual(2);
    expect(result.botMessage).not.toBe(repeatedProbe);
  });

  it("keeps the hackathon analysis screenshot flow from looping", async () => {
    let session = createInitialReflection(profile.id);
    const turns: ReturnType<typeof makeTurn>[] = [];
    const botTurns: ReturnType<typeof makeTurn>[] = [];
    const stageAfterMessages: Array<{ message: string; stage: typeof session.currentStage }> = [];
    const messages = [
      "hackathon",
      "just me",
      "rushed and excited",
      "did not submit because I overplanned",
      "I was too overzealous and did not take into account my reduced time",
      "I wanted to make full use of the hackathon and the resources offered",
      "I was overconfident in my abilities",
      "having vibe coding tools",
      "a sussy baka"
    ];
    const model: ModelClient = {
      async generateJson(input) {
        if (input.task === "stage_sufficiency") {
          const payload = JSON.parse(input.messages.at(-1)?.content ?? "{}") as {
            currentStage?: string;
            studentMessage?: string;
          };
          const message = payload.studentMessage?.toLowerCase() ?? "";
          if (payload.currentStage === "analysis" && (
            message.includes("overzealous") ||
            message.includes("resources offered") ||
            message.includes("overconfident") ||
            message.includes("vibe coding tools")
          )) {
            return {
              stageComplete: true,
              confidence: 0.93,
              missing: [],
              probeQuestion: "What is one thing you learned from it?",
              reason: "The answer gives a plausible semantic cause."
            } as never;
          }
        }
        if (input.task === "contextual_reflection_reply") {
          const payload = JSON.parse(input.messages.at(-1)?.content ?? "{}") as {
            currentStage?: string;
            fallbackIfUnsure?: string;
          };
          const replies: Record<string, string> = {
            people: "A hackathon, got it. Who was involved?",
            feelings: "Going solo can be intense. What feeling stood out?",
            evaluation: "Rushed and excited gives us the vibe. What went well or did not?",
            analysis: "Not submitting after overplanning sounds frustrating. What do you think led to that?",
            conclusion: "That sounds like overzeal meeting limited time. What are you taking from this?",
            action_plan: "That takeaway is practical. What is one small next step?"
          };
          return {
            reply: replies[payload.currentStage ?? ""] ?? payload.fallbackIfUnsure ?? "What happened?",
            referencedUserContext: true,
            questionIntent: "stage aligned",
            reason: "Deterministic screenshot regression reply."
          } as never;
        }
        return input.fallback as never;
      }
    };

    for (const message of messages) {
      const stageBefore = session.currentStage;
      const result = await handleReflectionTurn({
        profile,
        session,
        studentMessage: message,
        recentTurns: turns.slice(-10),
        model
      });
      turns.push(makeTurn("student", stageBefore, message));
      session = result.session;
      const botTurn = makeTurn("bot", session.currentStage, result.botMessage);
      turns.push(botTurn);
      botTurns.push(botTurn);
      stageAfterMessages.push({ message, stage: session.currentStage });
    }

    const analysisProbeCount = botTurns.filter((turn) => turn.stage === "analysis" && turn.content.trim().endsWith("?")).length;
    const firstSemanticAnalysisStage = stageAfterMessages.find(
      (entry) => entry.message.includes("overzealous") || entry.message.includes("resources offered")
    )?.stage;

    expect(["conclusion", "action_plan"].includes(firstSemanticAnalysisStage ?? "") || session.status === "completed").toBe(true);
    expect(["conclusion", "action_plan"].includes(session.currentStage) || session.status === "completed").toBe(true);
    expect(session.answers.analysis).toBe("I was too overzealous and did not take into account my reduced time");
    expect(session.answers.analysis).not.toContain("sussy");
    expect(botTurns.some((turn) => turn.content.includes("That helps. Why do you think it happened that way?"))).toBe(false);
    expect(analysisProbeCount).toBeLessThanOrEqual(2);
  });

  it("does not count initial stage-entry prompts as probes", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("bot", "analysis", "Why do you think it happened that way?"),
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).not.toContain("looping");
  });

  it("does not count contextual-looking probes from the wrong stage", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("bot", "evaluation", "It sounds like the deadline was the hard part. What went well or did not?"),
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).not.toContain("looping");
  });

  it("does not count non-question bot messages as probes", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const recentTurns = [
      makeTurn("bot", "analysis", "Skipping that bit. Next: Why do you think it happened that way."),
      makeTurn("bot", "analysis", "I'm here with you. We can keep this gentle.")
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "idk", recentTurns });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).not.toContain("looping");
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

  it("uses contextual second probes instead of repeating the same prompt", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "description" as const };
    const recentTurns = [
      {
        id: "turn_probe",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Got it. What was the actual event or situation you want to reflect on?",
        stage: "description" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "a confusing thing after school",
      recentTurns
    });

    expect(result.session.currentStage).toBe("description");
    expect(result.botMessage).toContain("confusing thing");
    expect(result.botMessage).not.toBe("No stress. What was the actual event or situation you want to reflect on?");
  });

  it("uses the model to contextualize incomplete probes without stiff flagposting", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I wasn't realistic with my deadlines and had to leave halfway",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: false,
              confidence: 0.85,
              missing: ["cause"],
              probeQuestion: "Why do you think it happened that way?",
              reason: "Needs a clearer cause."
            } as never;
          }
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: "Sounds like the deadline pressure and leaving midway shaped the whole thing. What do you think led you to scope it that way?",
              referencedUserContext: true,
              questionIntent: "ask why it happened that way",
              reason: "References concrete context and asks an analysis question."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).toContain("deadline");
    expect(result.botMessage).toContain("leaving midway");
    expect(result.botMessage).toContain("What do you think");
    expect(result.botMessage).not.toMatch(/^(Got it|That helps|Okay|No stress|I hear)/);
  });

  it("uses the model to contextualize stage transitions", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I liked the vibe, but wasn't able to submit",
      model: {
        async generateJson(input) {
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: "So the vibe worked, but submitting was the hard bit. Why do you think it played out that way?",
              referencedUserContext: true,
              questionIntent: "ask why it happened that way",
              reason: "Balances the positive and negative evaluation."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).toContain("vibe");
    expect(result.botMessage).toContain("submitting");
    expect(result.botMessage).toContain("Why");
    expect(result.botMessage).not.toMatch(/^(Got it|That helps|Okay|No stress|I hear)/);
  });

  it("falls back when contextual composer asks the wrong stage question", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I wasn't realistic with deadlines",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: false,
              confidence: 0.85,
              missing: ["cause"],
              probeQuestion: "Why do you think it happened that way?",
              reason: "Needs a clearer cause."
            } as never;
          }
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: "Sounds stressful. Who was involved with you?",
              referencedUserContext: true,
              questionIntent: "ask who was involved",
              reason: "Wrong stage."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.session.currentStage).toBe("analysis");
    expect(result.botMessage).toContain("Why");
    expect(result.botMessage).not.toContain("Who");
  });

  it("falls back when contextual composer asks multiple questions", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I wasn't realistic with deadlines",
      model: {
        async generateJson(input) {
          if (input.task === "stage_sufficiency") {
            return {
              stageComplete: false,
              confidence: 0.85,
              missing: ["cause"],
              probeQuestion: "Why do you think it happened that way?",
              reason: "Needs a clearer cause."
            } as never;
          }
          if (input.task === "contextual_reflection_reply") {
            return {
              reply: "Sounds like deadlines mattered. Why did that happen? What would you do next time?",
              referencedUserContext: true,
              questionIntent: "ask why it happened that way",
              reason: "Two questions."
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.botMessage).toContain("Why");
    expect((result.botMessage.match(/\?/g) ?? []).length).toBe(1);
    expect(result.botMessage).not.toContain("next time");
  });

  it("treats move-on complaints as navigation instead of stage answers", async () => {
    const session = {
      ...createInitialReflection(profile.id),
      currentStage: "conclusion" as const,
      answers: { conclusion: "manage my time and expectations under pressure" }
    };

    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "You are repeating yourself, lets move on to the next stage"
    });

    expect(result.session.currentStage).toBe("action_plan");
    expect(result.session.answers.conclusion).toBe("manage my time and expectations under pressure");
  });

  it("acknowledges skip navigation and does not store it as an answer", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "analysis" as const };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "skip this stage pls"
    });

    expect(result.session.currentStage).toBe("conclusion");
    expect(result.session.answers.analysis).toBeUndefined();
    expect(result.botMessage.toLowerCase()).toContain("skipping");
  });

  it("does not echo reaction-only replies", async () => {
    const session = { ...createInitialReflection(profile.id), currentStage: "evaluation" as const };
    const recentTurns = [
      {
        id: "bot_eval_probe",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Got it. What was one thing that went well, or one thing that did not?",
        stage: "evaluation" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "bruh", recentTurns });

    expect(result.botMessage).not.toContain('I hear "bruh"');
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
    expect(result.botMessage).toContain("looping");
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
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
  });

  it("pauses acute suicidal language without storing or advancing", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I want to kill myself"
    });

    expect(result.safetyConcern.level).toBe("crisis");
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.session.status).toBe("in_progress");
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.completed).toBe(false);
    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
    expect(result.botMessage).not.toContain("I want to kill myself");
  });

  it.each([
    ["I want to kill myself", "suicidal_ideation"],
    ["I want to hurt myself", "self_harm"],
    ["I feel unsafe at home", "abuse_or_harm"]
  ])("still flags explicit safety text: %s", async (studentMessage, category) => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({ profile, session, studentMessage });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.safetyConcern.category).toBe(category);
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
  });

  it("does not let ambiguous distress bypass stage sufficiency", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I feel like disappearing after what happened",
      model: {
        async generateJson(input) {
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

    expect(result.safetyConcern.hasConcern).toBe(false);
    expect(result.session.safetyFlagged).toBe(false);
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
  });

  it("uses the model safety classifier for high-confidence immediate danger", async () => {
    const session = createInitialReflection(profile.id);
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "someone threatened me and I may not be safe after what happened",
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
              level: "high",
              category: "immediate_danger",
              reason: "Student may be in immediate danger",
              studentFacingSupport: "Your safety matters. Please contact a trusted adult or emergency support.",
              shouldFlag: true,
              allowNormalSummary: false
            } as never;
          }
          return input.fallback as never;
        }
      }
    });

    expect(result.safetyConcern.hasConcern).toBe(true);
    expect(result.safetyConcern.category).toBe("immediate_danger");
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.session.currentStage).toBe("description");
    expect(result.session.answers.description).toBeUndefined();
    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
  });

  it("pauses a crisis turn during analysis without advancing to conclusion", async () => {
    const session = {
      ...createInitialReflection(profile.id),
      currentStage: "analysis" as const,
      answers: {
        description: "hackathon",
        people: "just me",
        feelings: "excited",
        evaluation: "I did not submit because I overplanned"
      }
    };
    const result = await handleReflectionTurn({
      profile,
      session,
      studentMessage: "I want to hurt myself"
    });

    expect(result.safetyConcern.category).toBe("self_harm");
    expect(result.session.currentStage).toBe("analysis");
    expect(result.session.answers.analysis).toBeUndefined();
    expect(result.session.safetyFlagged).toBe(true);
    expect(result.botMessage).toBe(safetyPauseFollowupMessage);
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

  it("does not create a fake summary when the reflection is too thin", async () => {
    const session = {
      ...createInitialReflection(profile.id),
      currentStage: "action_plan" as const,
      answers: { description: "hackathon" }
    };
    const recentTurns = [
      {
        id: "bot_action_probe_1",
        reflectionId: session.id,
        role: "bot" as const,
        content: "Got it. What is one small next step you want to take?",
        stage: "action_plan" as const,
        createdAt: new Date().toISOString()
      },
      {
        id: "bot_action_probe_2",
        reflectionId: session.id,
        role: "bot" as const,
        content: "No stress. What is one small next step you want to take?",
        stage: "action_plan" as const,
        createdAt: new Date().toISOString()
      }
    ];

    const result = await handleReflectionTurn({ profile, session, studentMessage: "ok", recentTurns });

    expect(result.completed).toBe(true);
    expect(result.summary).toBeUndefined();
    expect(result.botMessage).toContain("don't have enough real reflection");
  });
});
