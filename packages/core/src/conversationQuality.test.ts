import { describe, expect, it } from "vitest";
import {
  analyzeConversationQuality,
  countSemanticStageProbes,
  hasExactRecentBotReply,
  normalizeReplyForRepeatDetection
} from "./conversationQuality.js";
import { stagePrompts, type GibbsStage } from "./gibbs.js";
import type { ReflectionTurn } from "./types.js";

function makeTurn(role: "student" | "bot", stage: GibbsStage, content: string, index = 0): ReflectionTurn {
  return {
    id: `${role}_${stage}_${index}`,
    reflectionId: "reflection_quality_test",
    role,
    stage,
    content,
    createdAt: new Date(index).toISOString()
  };
}

describe("conversation quality checks", () => {
  it("normalizes replies for exact duplicate detection", () => {
    expect(normalizeReplyForRepeatDetection(" That helps!  Why do you think it happened that way? ")).toBe(
      "that helps why do you think it happened that way"
    );
  });

  it("detects exact normalized bot reply repeats", () => {
    const turns = [
      makeTurn("bot", "analysis", "That helps. Why do you think it happened that way?", 1),
      makeTurn("student", "analysis", "I overplanned", 2),
      makeTurn("bot", "analysis", "that helps! why do you think it happened that way?", 3)
    ];

    const report = analyzeConversationQuality(turns);

    expect(report.issues).toContainEqual(expect.objectContaining({
      type: "exact_reply_repeat",
      stage: "analysis",
      count: 2
    }));
    expect(hasExactRecentBotReply("That helps, why do you think it happened that way?", turns)).toBe(true);
  });

  it("keeps differently worded same-intent probes separate from exact duplicates", () => {
    const turns = [
      makeTurn("bot", "analysis", "Why do you think it happened that way?", 1),
      makeTurn("bot", "analysis", "What do you think led things to turn out that way?", 2)
    ];

    const report = analyzeConversationQuality(turns);

    expect(report.issues.some((issue) => issue.type === "exact_reply_repeat")).toBe(false);
  });

  it("classifies repeated same-stage questions as semantic loops", () => {
    const turns = [
      makeTurn("bot", "analysis", "It sounds like time pressure was part of it. What do you think led to that?", 1),
      makeTurn("bot", "analysis", "What do you think led things to turn out that way?", 2),
      makeTurn("bot", "analysis", "What do you think was the main cause?", 3)
    ];

    const report = analyzeConversationQuality(turns);

    expect(report.issues).toContainEqual(expect.objectContaining({
      type: "semantic_stage_loop",
      stage: "analysis",
      count: 3
    }));
  });

  it("does not count initial stage-entry prompts as semantic probes", () => {
    const turns = [
      makeTurn("student", "description", "hackathon", 1),
      makeTurn("bot", "people", stagePrompts.people, 2),
      makeTurn("student", "people", "just me", 3),
      makeTurn("bot", "feelings", stagePrompts.feelings, 4)
    ];

    expect(countSemanticStageProbes(turns, "people")).toBe(0);
    expect(analyzeConversationQuality(turns).semanticStageLoopCount).toBe(0);
  });
});
