import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LangWatch } from "langwatch";
import {
  discardedReflectionMessage,
  handleModelCommand,
  handleModelSelectionCallback,
  handleNewReflectionCommand,
  handleReflectCommand,
  handleStudentReflectionMessage,
  homeMessage
} from "../../apps/bot/src/bot.js";
import { InMemoryReflectionStore } from "../../apps/bot/src/inMemoryStore.js";
import { createModelRouter } from "../../apps/bot/src/modelRouter.js";
import { safetyPauseFollowupMessage } from "../../packages/core/src/agent.js";

type Step =
  | { kind: "text"; text: string }
  | { kind: "command"; command: "reflect" | "new" | "model" }
  | { kind: "callback"; data: string };

type EvalCase = {
  id: string;
  description: string;
  steps: Step[];
  expectations: Array<(context: EvalContext) => EvalCheck>;
};

type EvalContext = Awaited<ReturnType<typeof runEvalCase>>;

type EvalCheck = {
  name: string;
  passed: boolean;
  details: string;
};

const evalCases: EvalCase[] = [
  {
    id: "home-does-not-autostart",
    description: "Idle free text stays in home and does not create a reflection.",
    steps: [{ kind: "text", text: "hi" }],
    expectations: [
      ({ replies }) => ({
        name: "home-reply",
        passed: replies.at(-1)?.includes(homeMessage) === true,
        details: replies.join(" | ")
      }),
      ({ reflections, turns }) => ({
        name: "no-reflection-created",
        passed: reflections.length === 0 && turns.length === 0,
        details: `reflections=${reflections.length}; turns=${turns.length}`
      })
    ]
  },
  {
    id: "new-discards-to-home",
    description: "/new abandons the open reflection and allows /model from home.",
    steps: [
      { kind: "command", command: "reflect" },
      { kind: "command", command: "new" },
      { kind: "command", command: "model" }
    ],
    expectations: [
      ({ replies, openReflection }) => ({
        name: "discarded-to-home",
        passed: replies.includes(discardedReflectionMessage) && !openReflection,
        details: `openReflection=${openReflection?.id ?? "none"}; replies=${replies.join(" | ")}`
      }),
      ({ modelButtonsShown }) => ({
        name: "model-buttons-available",
        passed: modelButtonsShown,
        details: `modelButtonsShown=${modelButtonsShown}`
      })
    ]
  },
  {
    id: "reflect-starts-flow",
    description: "/reflect remains the explicit entry into description stage.",
    steps: [{ kind: "command", command: "reflect" }],
    expectations: [
      ({ openReflection, replies }) => ({
        name: "reflection-started",
        passed: openReflection?.currentStage === "description" && replies.at(-1)?.includes("What happened?") === true,
        details: `stage=${openReflection?.currentStage ?? "none"}; reply=${replies.at(-1) ?? "missing"}`
      })
    ]
  },
  {
    id: "model-switch-between-reflections",
    description: "Model can switch after discarding to home, but assignments stay per reflection.",
    steps: [
      { kind: "callback", data: "model:gpt-4o-mini" },
      { kind: "command", command: "reflect" },
      { kind: "command", command: "new" },
      { kind: "callback", data: "model:gpt-5-mini" },
      { kind: "command", command: "reflect" }
    ],
    expectations: [
      ({ assignments }) => ({
        name: "first-reflection-used-4o-mini",
        passed: assignments[0]?.modelName === "gpt-4o-mini",
        details: JSON.stringify(assignments)
      }),
      ({ assignments, openReflection }) => ({
        name: "latest-reflection-used-5-mini",
        passed: assignments.at(-1)?.modelName === "gpt-5-mini" && openReflection?.status === "in_progress",
        details: JSON.stringify({ assignments, openReflectionStatus: openReflection?.status })
      })
    ]
  },
  {
    id: "safety-pause-keeps-reflection-open",
    description: "A safety pause keeps the reflection open and creates an admin-review concern.",
    steps: [
      { kind: "command", command: "reflect" },
      { kind: "text", text: "I want to hurt myself" }
    ],
    expectations: [
      ({ openReflection }) => ({
        name: "reflection-still-open",
        passed: openReflection?.status === "in_progress" && openReflection.currentStage === "description" && openReflection.safetyFlagged,
        details: JSON.stringify({
          status: openReflection?.status,
          stage: openReflection?.currentStage,
          safetyFlagged: openReflection?.safetyFlagged
        })
      }),
      ({ safetyConcerns }) => ({
        name: "safety-concern-opened",
        passed: safetyConcerns.length === 1 && safetyConcerns[0]?.status === "open" && safetyConcerns[0]?.stage === "description",
        details: JSON.stringify(safetyConcerns)
      }),
      ({ replies }) => ({
        name: "safety-pause-replied",
        passed: replies.includes(safetyPauseFollowupMessage),
        details: replies.join(" | ")
      })
    ]
  },
  {
    id: "safety-paused-reflection-can-be-discarded",
    description: "/new explicitly discards a reflection after a safety pause.",
    steps: [
      { kind: "command", command: "reflect" },
      { kind: "text", text: "I want to hurt myself" },
      { kind: "command", command: "new" }
    ],
    expectations: [
      ({ openReflection, reflections }) => ({
        name: "paused-reflection-discarded",
        passed: !openReflection && reflections.some((reflection) => reflection.status === "abandoned" && reflection.safetyFlagged),
        details: JSON.stringify({
          openReflection: openReflection?.id ?? "none",
          statuses: reflections.map((reflection) => ({ status: reflection.status, safetyFlagged: reflection.safetyFlagged }))
        })
      })
    ]
  },
  {
    id: "model-blocked-during-safety-pause",
    description: "/model remains blocked because a safety-paused reflection is still open.",
    steps: [
      { kind: "command", command: "reflect" },
      { kind: "text", text: "I want to hurt myself" },
      { kind: "command", command: "model" }
    ],
    expectations: [
      ({ openReflection, replies, modelButtonsShown }) => ({
        name: "model-change-blocked",
        passed: openReflection?.status === "in_progress" && !modelButtonsShown && replies.at(-1)?.includes("reflection in progress") === true,
        details: JSON.stringify({
          stage: openReflection?.currentStage,
          modelButtonsShown,
          finalReply: replies.at(-1)
        })
      })
    ]
  }
];

const results = [];
const experiment = await initLangWatchExperiment();

for (const evalCase of evalCases) {
  const runCase = async () => {
    const context = await runEvalCase(evalCase);
    const checks = evalCase.expectations.map((expectation) => expectation(context));
    const passed = checks.every((check) => check.passed);
    results.push({
      id: evalCase.id,
      description: evalCase.description,
      passed,
      checks,
      replies: context.replies
    });
    return { context, checks, passed };
  };

  if (experiment) {
    await experiment.run([evalCase], async ({ item, index, span }) => {
      span.setType("evaluation");
      span.setInput("json", { id: item.id, steps: item.steps });
      const { context, checks, passed } = await runCase();
      span.setOutput("json", {
        passed,
        checks,
        replies: context.replies,
        reflectionCount: context.reflections.length,
        openReflection: context.openReflection
      });

      for (const check of checks) {
        experiment.log(check.name, {
          index,
          passed: check.passed,
          score: check.passed ? 1 : 0,
          details: check.details,
          data: { caseId: item.id }
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

const outputPath = join("better-agents", "evals", "artifacts", `${new Date().toISOString().replace(/[:.]/g, "-")}-bot-flow-evals.json`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(summary, null, 2));

console.log(JSON.stringify({ ...summary, artifact: outputPath }, null, 2));
experiment?.printSummary(false);

if (!summary.passed) {
  process.exitCode = 1;
}

async function runEvalCase(evalCase: EvalCase) {
  const store = new InMemoryReflectionStore();
  const modelRouter = createModelRouter({});
  const student = await store.getOrCreateStudent({
    telegramUserId: `eval_${evalCase.id}`,
    displayName: "Asha"
  });
  const replies: string[] = [];
  let modelButtonsShown = false;

  for (const step of evalCase.steps) {
    if (step.kind === "text") {
      const session = await store.getLatestOpenReflection(student.id);
      replies.push(...await handleStudentReflectionMessage({
        store,
        session: session ?? undefined,
        student,
        text: step.text
      }));
      continue;
    }

    if (step.kind === "callback") {
      const response = await handleModelSelectionCallback({
        store,
        student,
        modelRouter,
        callbackData: step.data
      });
      replies.push(response.text);
      continue;
    }

    if (step.command === "reflect") {
      replies.push(...await handleReflectCommand({ store, student, modelRouter }));
    } else if (step.command === "new") {
      replies.push(...await handleNewReflectionCommand({ store, student, modelRouter }));
    } else {
      const response = await handleModelCommand({ store, student, modelRouter });
      modelButtonsShown = modelButtonsShown || Boolean(response.replyMarkup?.inline_keyboard.length);
      replies.push(response.text);
    }
  }

  const reflections = store.getReflections();
  return {
    replies,
    reflections,
    turns: store.getTurns(),
    safetyConcerns: store.getSafetyConcerns(),
    openReflection: await store.getLatestOpenReflection(student.id),
    assignments: reflections.map((reflection) => modelRouter.getReflectionAssignment(reflection.id)),
    modelButtonsShown
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
    return await new LangWatch().experiments.init("reflection-bot-flow-evals");
  } catch (error) {
    throw new Error(
      `LangWatch experiment upload failed while LANGWATCH_API_KEY is configured. Set REFLECTION_EVAL_LOCAL_ONLY=true for artifact-only local runs. Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
