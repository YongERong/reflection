import { z } from "zod";
import { gibbsStageSchema, nextStage, stagePrompts, type GibbsStage } from "./gibbs.js";
import { gibbsAnswersSchema, safetyClassificationSchema, type SafetyClassification } from "./types.js";

export const skillPermissionSchema = z.enum(["safe", "sensitive", "admin"]);
export type SkillPermission = z.infer<typeof skillPermissionSchema>;

export type SkillDefinition<Input, Output> = {
  name: string;
  purpose: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  permission: SkillPermission;
  persistence: "none" | "proposed" | "writes_after_backend_validation";
  evalCoverage: string[];
  run(input: Input): Output;
};

export const skillRegistry = {
  ask_next_gibbs_question: {
    name: "ask_next_gibbs_question",
    purpose: "Return the next modified Gibbs prompt for the active stage.",
    inputSchema: z.object({ stage: gibbsStageSchema }),
    outputSchema: z.object({
      stage: gibbsStageSchema,
      prompt: z.string(),
      nextStage: gibbsStageSchema.nullable()
    }),
    permission: "safe",
    persistence: "none",
    evalCoverage: ["full_gibbs_cycle", "vague_people_answer"],
    run: ({ stage }) => {
      const typedStage = stage as GibbsStage;
      return { stage: typedStage, prompt: stagePrompts[typedStage], nextStage: nextStage(typedStage) };
    }
  },
  summarize_reflection: {
    name: "summarize_reflection",
    purpose: "Create a faithful short summary from the student's stage answers.",
    inputSchema: z.object({ answers: gibbsAnswersSchema }),
    outputSchema: z.object({ briefSummary: z.string(), keyLearnings: z.array(z.string()) }),
    permission: "safe",
    persistence: "proposed",
    evalCoverage: ["summary_faithfulness", "teacher_summary_privacy"],
    run: ({ answers }) => ({
      briefSummary: buildBriefSummary(answers),
      keyLearnings: extractKeyLearnings(answers)
    })
  },
  extract_actionables: {
    name: "extract_actionables",
    purpose: "Extract concrete non-judgmental next actions.",
    inputSchema: z.object({ answers: gibbsAnswersSchema }),
    outputSchema: z.object({ actionables: z.array(z.string()) }),
    permission: "safe",
    persistence: "proposed",
    evalCoverage: ["concrete_actionables"],
    run: ({ answers }) => ({ actionables: extractActionables(answers) })
  },
  propose_memory_update: {
    name: "propose_memory_update",
    purpose: "Propose durable student profile memory updates with a source reason.",
    inputSchema: z.object({ answers: gibbsAnswersSchema }),
    outputSchema: z.object({
      proposedUpdates: z.array(
        z.object({
          kind: z.enum(["profileFact", "recurringTheme", "strength", "goal", "preferredStyle"]),
          value: z.string(),
          reason: z.string()
        })
      )
    }),
    permission: "sensitive",
    persistence: "writes_after_backend_validation",
    evalCoverage: ["conservative_memory_updates"],
    run: ({ answers }) => ({ proposedUpdates: proposeMemoryUpdates(answers) })
  },
  detect_safety_concern: {
    name: "detect_safety_concern",
    purpose: "Detect text that should be reviewed by backend safety handling.",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: safetyClassificationSchema,
    permission: "sensitive",
    persistence: "writes_after_backend_validation",
    evalCoverage: ["safety_signal"],
    run: ({ text }) => detectSafetyConcern(text)
  },
  generate_teacher_summary: {
    name: "generate_teacher_summary",
    purpose: "Generate a teacher-visible summary without excessive raw detail.",
    inputSchema: z.object({
      briefSummary: z.string(),
      actionables: z.array(z.string()),
      keyLearnings: z.array(z.string())
    }),
    outputSchema: z.object({ teacherSummary: z.string() }),
    permission: "sensitive",
    persistence: "writes_after_backend_validation",
    evalCoverage: ["teacher_summary_privacy"],
    run: ({ briefSummary, actionables, keyLearnings }) => ({
      teacherSummary: [
        briefSummary,
        keyLearnings.length ? `Learning: ${keyLearnings[0]}` : undefined,
        actionables.length ? `Next step: ${actionables[0]}` : undefined
      ]
        .filter(Boolean)
        .join(" ")
    })
  }
} satisfies Record<string, SkillDefinition<any, any>>;

export type SkillName = keyof typeof skillRegistry;

function buildBriefSummary(answers: Partial<Record<string, string>>): string {
  const sanitized = sanitizeUnsafeAnswers(answers);
  const experience = sanitized.description ?? "The student reflected on an experience";
  const people = sanitized.people ? ` They noted who was involved: ${sanitized.people}` : "";
  const learning = sanitized.conclusion ? ` Their main learning was: ${sanitized.conclusion}` : "";
  return `${experience}.${people}${learning}`.replace(/\.+/g, ".").trim();
}

function extractKeyLearnings(answers: Partial<Record<string, string>>): string[] {
  const sanitized = sanitizeUnsafeAnswers(answers);
  return [sanitized.conclusion, sanitized.analysis].filter((item): item is string => Boolean(item));
}

function extractActionables(answers: Partial<Record<string, string>>): string[] {
  const sanitized = sanitizeUnsafeAnswers(answers);
  if (sanitized.action_plan) {
    return [sanitized.action_plan];
  }
  return ["Choose one small next step connected to the reflection."];
}

function proposeMemoryUpdates(answers: Partial<Record<string, string>>) {
  const updates = [];
  if (answers.action_plan) {
    updates.push({
      kind: "goal" as const,
      value: answers.action_plan.slice(0, 180),
      reason: "Student stated this during the action plan stage."
    });
  }
  if (answers.conclusion) {
    updates.push({
      kind: "recurringTheme" as const,
      value: answers.conclusion.slice(0, 180),
      reason: "Student described this as a learning from the experience."
    });
  }
  return updates;
}

export function detectSafetyConcern(text: string): SafetyClassification {
  const normalized = text.toLowerCase();
  const terms = [
    "kill myself",
    "end my life",
    "want to die",
    "i want to die",
    "end it all",
    "hurt myself",
    "self harm",
    "self-harm",
    "suicide",
    "abuse",
    "unsafe at home",
    "how to make a bomb",
    "make a bomb",
    "made a bomb",
    "build a bomb",
    "weapon instructions",
    "make a weapon",
    "build a weapon"
  ];
  const match = terms.find((term) => normalized.includes(term));
  if (!match) {
    return {
      hasConcern: false,
      level: "none",
      category: "none",
      shouldFlag: false,
      allowNormalSummary: true
    };
  }

  const category = ["kill myself", "end my life", "want to die", "i want to die", "end it all", "suicide"].includes(match)
    ? "suicidal_ideation"
    : match.includes("bomb") || match.includes("weapon")
      ? "dangerous_instruction"
      : match.includes("abuse") || match.includes("unsafe")
        ? "abuse_or_harm"
        : "self_harm";

  return {
    hasConcern: true,
    level: category === "suicidal_ideation" ? "crisis" : "high",
    category,
    reason: `Matched safety phrase: ${match}`,
    studentFacingSupport:
      category === "dangerous_instruction"
        ? "I cannot help with making weapons or causing harm. If you want to reflect on what happened or what led to that thought, we can keep it safe and talk about the situation."
        : "I am really sorry you are dealing with that. If you might be in immediate danger, please contact a trusted adult or local emergency support now. We can keep reflecting, but your safety matters first.",
    shouldFlag: true,
    allowNormalSummary: false
  };
}

export function sanitizeUnsafeAnswers(answers: Partial<Record<string, string>>): Partial<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      value && detectSafetyConcern(value).hasConcern ? "A safety concern was shared and flagged for review" : value
    ])
  );
}
