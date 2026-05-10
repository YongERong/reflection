import { stagePrompts, type GibbsStage } from "./gibbs.js";
import type { ReflectionTurn } from "./types.js";

export type ConversationQualityIssueType =
  | "exact_reply_repeat"
  | "near_reply_repeat"
  | "semantic_stage_loop";

export type ConversationQualityIssue = {
  type: ConversationQualityIssueType;
  stage: GibbsStage;
  reply?: string;
  normalizedReply?: string;
  count: number;
  details: string;
};

export type ConversationQualityReport = {
  issues: ConversationQualityIssue[];
  exactReplyRepeatCount: number;
  nearReplyRepeatCount: number;
  semanticStageLoopCount: number;
  maxExactReplyRepeatCount: number;
};

export function normalizeReplyForRepeatDetection(reply: string): string {
  return reply
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function analyzeConversationQuality(turns: ReflectionTurn[]): ConversationQualityReport {
  const issues: ConversationQualityIssue[] = [
    ...findExactReplyRepeats(turns),
    ...findNearReplyRepeats(turns),
    ...findSemanticStageLoops(turns)
  ];
  const exactReplyIssues = issues.filter((issue) => issue.type === "exact_reply_repeat");
  const nearReplyIssues = issues.filter((issue) => issue.type === "near_reply_repeat");
  const semanticLoopIssues = issues.filter((issue) => issue.type === "semantic_stage_loop");

  return {
    issues,
    exactReplyRepeatCount: exactReplyIssues.length,
    nearReplyRepeatCount: nearReplyIssues.length,
    semanticStageLoopCount: semanticLoopIssues.length,
    maxExactReplyRepeatCount: exactReplyIssues.reduce((max, issue) => Math.max(max, issue.count), 0)
  };
}

export function hasExactRecentBotReply(reply: string, turns: ReflectionTurn[]): boolean {
  const normalized = normalizeReplyForRepeatDetection(reply);
  if (!normalized) return false;
  return turns.some(
    (turn) => turn.role === "bot" && normalizeReplyForRepeatDetection(turn.content) === normalized
  );
}

export function countSemanticStageProbes(turns: ReflectionTurn[], stage: GibbsStage): number {
  return turns.filter((turn, index) => isSemanticStageProbeTurn(turn, stage, turns, index)).length;
}

export function isSemanticStageProbeTurn(
  turn: ReflectionTurn,
  stage: GibbsStage,
  turns: ReflectionTurn[],
  index: number
): boolean {
  if (turn.role !== "bot" || turn.stage !== stage) return false;
  if (!turn.content.trim().endsWith("?")) return false;
  if (isInitialStageEntryPrompt(stage, turn.content)) return false;
  return !isStageEntryBySequence(turns, index, stage);
}

function findExactReplyRepeats(turns: ReflectionTurn[]): ConversationQualityIssue[] {
  const botTurns = turns.filter((turn) => turn.role === "bot");
  const grouped = new Map<string, ReflectionTurn[]>();
  for (const turn of botTurns) {
    const normalized = normalizeReplyForRepeatDetection(turn.content);
    if (!normalized) continue;
    grouped.set(normalized, [...(grouped.get(normalized) ?? []), turn]);
  }

  return [...grouped.entries()]
    .filter(([, repeatedTurns]) => repeatedTurns.length > 1)
    .map(([normalizedReply, repeatedTurns]) => ({
      type: "exact_reply_repeat" as const,
      stage: repeatedTurns[0]?.stage ?? "description",
      reply: repeatedTurns[0]?.content,
      normalizedReply,
      count: repeatedTurns.length,
      details: `Repeated exact bot reply ${repeatedTurns.length} times.`
    }));
}

function findNearReplyRepeats(turns: ReflectionTurn[]): ConversationQualityIssue[] {
  const botTurns = turns.filter((turn) => turn.role === "bot");
  const issues: ConversationQualityIssue[] = [];

  for (let index = 0; index < botTurns.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < botTurns.length; otherIndex += 1) {
      const first = botTurns[index];
      const second = botTurns[otherIndex];
      if (!first || !second || first.stage !== second.stage) continue;
      const firstNormalized = normalizeReplyForRepeatDetection(first.content);
      const secondNormalized = normalizeReplyForRepeatDetection(second.content);
      if (!firstNormalized || firstNormalized === secondNormalized) continue;
      if (jaccardSimilarity(firstNormalized, secondNormalized) < 0.82) continue;
      issues.push({
        type: "near_reply_repeat",
        stage: first.stage,
        reply: second.content,
        normalizedReply: secondNormalized,
        count: 2,
        details: "Two same-stage bot replies are highly similar but not exact duplicates."
      });
    }
  }

  return issues;
}

function findSemanticStageLoops(turns: ReflectionTurn[]): ConversationQualityIssue[] {
  const stages = new Set(turns.map((turn) => turn.stage));
  return [...stages].flatMap((stage) => {
    const count = countSemanticStageProbes(turns, stage);
    return count >= 3
      ? [{
          type: "semantic_stage_loop" as const,
          stage,
          count,
          details: `Detected ${count} same-stage semantic probes.`
        }]
      : [];
  });
}

function jaccardSimilarity(first: string, second: string): number {
  const firstTokens = new Set(first.split(" ").filter(Boolean));
  const secondTokens = new Set(second.split(" ").filter(Boolean));
  if (firstTokens.size === 0 || secondTokens.size === 0) return 0;
  const intersection = [...firstTokens].filter((token) => secondTokens.has(token)).length;
  const union = new Set([...firstTokens, ...secondTokens]).size;
  return intersection / union;
}

function isStageEntryBySequence(turns: ReflectionTurn[], index: number, stage: GibbsStage): boolean {
  const previousTurn = turns[index - 1];
  return Boolean(previousTurn && previousTurn.stage !== stage);
}

function isInitialStageEntryPrompt(stage: GibbsStage, content: string): boolean {
  const normalized = normalizePromptForCounting(content);
  return initialStageEntryPrompts[stage].some((prompt) => normalizePromptForCounting(prompt) === normalized);
}

function normalizePromptForCounting(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[^\w'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const initialStageEntryPrompts: Record<GibbsStage, string[]> = {
  description: [
    stagePrompts.description
  ],
  people: [
    stagePrompts.people,
    "Got the event. Who was involved, even if it was just you?",
    "Thanks for sharing that. Who was around when it happened?"
  ],
  feelings: [
    stagePrompts.feelings,
    "That gives us the setup. What was one thought or feeling you remember from it?"
  ],
  evaluation: [
    stagePrompts.evaluation,
    "Okay, staying with that. What was one thing that went well, or one thing that did not?"
  ],
  analysis: [
    stagePrompts.analysis
  ],
  conclusion: [
    stagePrompts.conclusion,
    "What are you taking from this?",
    "That points to something useful. What does it tell you for next time?"
  ],
  action_plan: [
    stagePrompts.action_plan,
    "That sounds like a takeaway. What is one small next step you want to take?"
  ]
};
