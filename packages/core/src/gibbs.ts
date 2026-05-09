import { z } from "zod";

export const gibbsStages = [
  "description",
  "people",
  "feelings",
  "evaluation",
  "analysis",
  "conclusion",
  "action_plan"
] as const;

export const gibbsStageSchema = z.enum(gibbsStages);
export type GibbsStage = z.infer<typeof gibbsStageSchema>;

export const stageLabels: Record<GibbsStage, string> = {
  description: "Description",
  people: "People",
  feelings: "Feelings",
  evaluation: "Evaluation",
  analysis: "Analysis",
  conclusion: "Conclusion",
  action_plan: "Action plan"
};

export const stagePrompts: Record<GibbsStage, string> = {
  description: "What happened? Share the event or experience in your own words.",
  people: "Who did you go with, or who else was involved?",
  feelings: "What were you thinking or feeling during and after it?",
  evaluation: "What went well, and what did not go so well?",
  analysis: "Why do you think it happened that way?",
  conclusion: "What did you learn about yourself, others, or the situation?",
  action_plan: "What would you do next time, or what action will you take now?"
};

export function nextStage(stage: GibbsStage): GibbsStage | null {
  const index = gibbsStages.indexOf(stage);
  return gibbsStages[index + 1] ?? null;
}

export function isStageAnswerSubstantial(answer: string): boolean {
  return answer.trim().split(/\s+/).filter(Boolean).length >= 4;
}
