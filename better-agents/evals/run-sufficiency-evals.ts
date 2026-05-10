import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LangWatch } from "langwatch";
import { evaluateStageSufficiency, type StageSufficiency } from "../../packages/core/src/agent.js";
import type { GibbsStage } from "../../packages/core/src/gibbs.js";
import type { ModelClient } from "../../packages/core/src/model.js";
import type { ReflectionTurn } from "../../packages/core/src/types.js";

type ConfidenceBand = "hard-reject" | "model-accepted" | "ambiguous";

type SufficiencyEvalCase = {
  id: string;
  group: string;
  stage: GibbsStage;
  studentMessage: string;
  answers?: Partial<Record<string, string>>;
  recentTurns?: ReflectionTurn[];
  model?: ModelClient;
  expectedStageComplete: boolean;
  expectedBand: ConfidenceBand;
  expectedMissing?: string;
  expectProbeAligned?: boolean;
};

type EvalCheck = {
  name: string;
  passed: boolean;
  details: string;
};

type EvalResult = {
  id: string;
  group: string;
  passed: boolean;
  output: StageSufficiency;
  checks: EvalCheck[];
};

const semanticModel: ModelClient = {
  async generateJson(input) {
    if (input.task !== "stage_sufficiency") return input.fallback as never;
    const payload = JSON.parse(input.messages.at(-1)?.content ?? "{}") as {
      currentStage?: GibbsStage;
      studentMessage?: string;
    };
    return semanticDecision(payload.currentStage ?? "description", payload.studentMessage ?? "") as never;
  }
};

const acceptingModel: ModelClient = {
  async generateJson(input) {
    if (input.task !== "stage_sufficiency") return input.fallback as never;
    return {
      stageComplete: true,
      confidence: 0.99,
      missing: [],
      probeQuestion: "What is one thing you learned from it?",
      reason: "Bad eval model intentionally accepts everything."
    } as never;
  }
};

const cases: SufficiencyEvalCase[] = [
  {
    id: "analysis-resource-maximizing",
    group: "analysis-semantic-causes",
    stage: "analysis",
    studentMessage: "I wanted to make full use of the hackathon and the resources offered",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "analysis-overconfidence-abilities",
    group: "analysis-semantic-causes",
    stage: "analysis",
    studentMessage: "I was overconfident in my abilities",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "analysis-tool-optimism",
    group: "analysis-semantic-causes",
    stage: "analysis",
    studentMessage: "having vibe coding tools",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "analysis-time-pressure",
    group: "analysis-semantic-causes",
    stage: "analysis",
    studentMessage: "I was too overzealous and did not take into account my reduced time",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "analysis-reject-idk",
    group: "analysis-rejects-junk",
    stage: "analysis",
    studentMessage: "idk",
    model: acceptingModel,
    expectedStageComplete: false,
    expectedBand: "hard-reject",
    expectedMissing: "stage answer",
    expectProbeAligned: true
  },
  {
    id: "analysis-reject-bruh",
    group: "analysis-rejects-junk",
    stage: "analysis",
    studentMessage: "bruh",
    model: acceptingModel,
    expectedStageComplete: false,
    expectedBand: "hard-reject",
    expectedMissing: "stage answer",
    expectProbeAligned: true
  },
  {
    id: "analysis-reject-sussy-baka",
    group: "analysis-rejects-junk",
    stage: "analysis",
    studentMessage: "a sussy baka",
    model: acceptingModel,
    expectedStageComplete: false,
    expectedBand: "hard-reject",
    expectedMissing: "stage answer",
    expectProbeAligned: true
  },
  {
    id: "analysis-reject-repeated-overconfidence",
    group: "analysis-rejects-junk",
    stage: "analysis",
    studentMessage: "I was overconfident",
    answers: { analysis: "I was overconfident" },
    recentTurns: [
      makeTurn("bot", "analysis", "Why do you think it happened that way?"),
      makeTurn("bot", "analysis", "What do you think made it turn out that way?")
    ],
    model: acceptingModel,
    expectedStageComplete: false,
    expectedBand: "hard-reject",
    expectedMissing: "new cause",
    expectProbeAligned: true
  },
  {
    id: "conclusion-scope-time",
    group: "conclusion-semantic-takeaways",
    stage: "conclusion",
    studentMessage: "scope and time pressure are the main things to watch",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "conclusion-ask-help",
    group: "conclusion-semantic-takeaways",
    stage: "conclusion",
    studentMessage: "ask for help earlier when the scope gets too big",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "action-plan-apply-next-time",
    group: "action-plan-natural-steps",
    stage: "action_plan",
    studentMessage: "apply this to the next hackathon",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "action-plan-core-feature",
    group: "action-plan-natural-steps",
    stage: "action_plan",
    studentMessage: "write down the core feature before building",
    model: semanticModel,
    expectedStageComplete: true,
    expectedBand: "model-accepted"
  },
  {
    id: "description-basic-hackathon",
    group: "regression-basic-gibbs",
    stage: "description",
    studentMessage: "hackathon",
    expectedStageComplete: true,
    expectedBand: "hard-reject"
  },
  {
    id: "people-basic-alone",
    group: "regression-basic-gibbs",
    stage: "people",
    studentMessage: "just me",
    expectedStageComplete: true,
    expectedBand: "hard-reject"
  },
  {
    id: "feelings-basic-excitement",
    group: "regression-basic-gibbs",
    stage: "feelings",
    studentMessage: "excitement",
    expectedStageComplete: true,
    expectedBand: "hard-reject"
  },
  {
    id: "evaluation-basic-negative",
    group: "regression-basic-gibbs",
    stage: "evaluation",
    studentMessage: "it did not go well",
    expectedStageComplete: true,
    expectedBand: "ambiguous"
  }
];

const results: EvalResult[] = [];
const experiment = await initLangWatchExperiment();

for (const evalCase of cases) {
  const runCase = async () => {
    const output = await evaluateStageSufficiency({
      stage: evalCase.stage,
      studentMessage: evalCase.studentMessage,
      answers: evalCase.answers ?? {},
      recentTurns: evalCase.recentTurns ?? [],
      model: evalCase.model
    });
    const checks = buildChecks(evalCase, output);
    const passed = checks.every((check) => check.passed);
    results.push({ id: evalCase.id, group: evalCase.group, passed, output, checks });
    return { output, checks, passed };
  };

  if (experiment) {
    await experiment.run([evalCase], async ({ item, index, span }) => {
      span.setType("evaluation");
      span.setInput("json", {
        id: item.id,
        group: item.group,
        stage: item.stage,
        studentMessage: item.studentMessage
      });
      const { output, checks, passed } = await runCase();
      span.setOutput("json", { passed, output, checks });

      for (const check of checks) {
        experiment.log(check.name, {
          index,
          passed: check.passed,
          score: check.passed ? 1 : 0,
          details: check.details,
          data: { caseId: item.id, group: item.group }
        });
      }
    }, { concurrency: 1 });
  } else {
    await runCase();
  }
}

const summary = {
  passed: results.every((result) => result.passed),
  total: results.length,
  passedCount: results.filter((result) => result.passed).length,
  results
};

const outputPath = join("better-agents", "evals", "artifacts", `${new Date().toISOString().replace(/[:.]/g, "-")}-sufficiency-evals.json`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(summary, null, 2));

console.log(JSON.stringify({ ...summary, artifact: outputPath }, null, 2));
experiment?.printSummary(false);

if (!summary.passed) {
  process.exitCode = 1;
}

function semanticDecision(stage: GibbsStage, studentMessage: string): StageSufficiency {
  const normalized = studentMessage.toLowerCase();
  const complete = (reason: string): StageSufficiency => ({
    stageComplete: true,
    confidence: 0.92,
    missing: [],
    probeQuestion: probeFor(stage),
    reason
  });
  const incomplete = (missing: string, reason: string): StageSufficiency => ({
    stageComplete: false,
    confidence: 0.85,
    missing: [missing],
    probeQuestion: probeFor(stage),
    reason
  });

  if (stage === "analysis" && hasAny(normalized, ["wanted to make full use", "resources", "overconfident", "vibe coding tools", "overzealous", "reduced time"])) {
    return complete("The answer gives a plausible cause, motive, constraint, or tool effect.");
  }
  if (stage === "conclusion" && hasAny(normalized, ["scope", "time pressure", "watch", "ask for help", "earlier"])) {
    return complete("The answer gives a lesson or takeaway.");
  }
  if (stage === "action_plan" && hasAny(normalized, ["apply", "next hackathon", "write down", "core feature", "before building"])) {
    return complete("The answer gives a concrete next step.");
  }

  return incomplete(stage === "analysis" ? "why it happened" : "stage answer", "The answer is not sufficient for the stage.");
}

function buildChecks(evalCase: SufficiencyEvalCase, output: StageSufficiency): EvalCheck[] {
  return [
    {
      name: "stage-complete",
      passed: output.stageComplete === evalCase.expectedStageComplete,
      details: `Expected ${evalCase.expectedStageComplete}, got ${output.stageComplete}. Reason: ${output.reason}`
    },
    {
      name: "confidence-band",
      passed: matchesConfidenceBand(evalCase.expectedBand, output),
      details: `Expected ${evalCase.expectedBand}, got confidence=${output.confidence}.`
    },
    {
      name: "missing-shape",
      passed: evalCase.expectedStageComplete
        ? output.missing.length === 0
        : output.missing.length > 0 && (!evalCase.expectedMissing || output.missing.some((item) => item.includes(evalCase.expectedMissing!))),
      details: `Missing: ${output.missing.join(", ") || "none"}.`
    },
    {
      name: "probe-stage-aligned",
      passed: !evalCase.expectProbeAligned || isProbeAligned(evalCase.stage, output.probeQuestion),
      details: `Probe: ${output.probeQuestion}`
    }
  ];
}

function matchesConfidenceBand(band: ConfidenceBand, output: StageSufficiency): boolean {
  if (band === "hard-reject") return output.confidence >= 0.9;
  if (band === "model-accepted") return output.stageComplete && output.confidence >= 0.9;
  return output.confidence >= 0.75 && output.confidence < 0.9;
}

function isProbeAligned(stage: GibbsStage, probe: string): boolean {
  const normalized = probe.toLowerCase();
  const expectedTerms: Record<GibbsStage, string[]> = {
    description: ["event", "situation", "happened"],
    people: ["who", "involved"],
    feelings: ["thought", "feeling"],
    evaluation: ["went well", "did not", "not"],
    analysis: ["why", "made", "caused", "happened"],
    conclusion: ["learned", "taking", "takeaway", "next time"],
    action_plan: ["next step", "take"]
  };
  return expectedTerms[stage].some((term) => normalized.includes(term));
}

function probeFor(stage: GibbsStage): string {
  const probes: Record<GibbsStage, string> = {
    description: "What was the actual event or situation you want to reflect on?",
    people: "Who was involved, even if it was just you?",
    feelings: "What was one thought or feeling you remember from it?",
    evaluation: "What was one thing that went well, or one thing that did not?",
    analysis: "Why do you think it happened that way?",
    conclusion: "What is one thing you learned from it?",
    action_plan: "What is one small next step you want to take?"
  };
  return probes[stage];
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function makeTurn(role: "student" | "bot", stage: GibbsStage, content: string): ReflectionTurn {
  return {
    id: `${role}_${stage}_${Math.random().toString(36).slice(2)}`,
    reflectionId: "sufficiency_eval",
    role,
    stage,
    content,
    createdAt: new Date().toISOString()
  };
}

async function initLangWatchExperiment() {
  if (process.env.REFLECTION_EVAL_LOCAL_ONLY === "true") {
    console.warn("LangWatch experiment upload skipped: REFLECTION_EVAL_LOCAL_ONLY=true.");
    return undefined;
  }

  if (!process.env.LANGWATCH_API_KEY) {
    console.warn("LangWatch experiment upload skipped: LANGWATCH_API_KEY is not configured.");
    return undefined;
  }

  try {
    return await new LangWatch().experiments.init("reflection-bot-sufficiency-evals");
  } catch (error) {
    throw new Error(
      `LangWatch experiment upload failed while LANGWATCH_API_KEY is configured. Set REFLECTION_EVAL_LOCAL_ONLY=true for artifact-only local runs. Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
