import { Bot, InlineKeyboard, type Context } from "grammy";
import {
  createId,
  fixedSafetySupportMessage,
  handleReflectionTurn,
  renderStartingMessage,
  stagePrompts,
  type ModelClient,
  type ReflectionSession,
  type ReflectionStore,
  type StudentProfile
} from "@reflection/core";
import { captureTraceInput, captureTraceOutput, getBotTracer } from "./observability.js";
import {
  comparisonModelNames,
  createModelRouter,
  defaultComparisonModel,
  isComparisonModelName,
  type ModelAssignment,
  type ModelRouter
} from "./modelRouter.js";

export const openReflectionMessage =
  "You already have a reflection in progress. Send /continue to keep going, or /new to start over.";
export const homeMessage =
  "Hey. I can help you reflect on something. Send /reflect to start, or /model to choose the model.";
export const discardedReflectionMessage =
  "Discarded that reflection. Send /reflect to start again, or /model to choose the model.";

export function createReflectionBot(token: string, store: ReflectionStore, model?: ModelClient, router?: ModelRouter): Bot {
  const bot = new Bot(token);
  const modelRouter = router ?? createModelRouter({ [defaultComparisonModel]: model });

  bot.command("start", async (ctx) => {
    const student = await getStudent(ctx, store);
    const config = await store.getActiveConfig(student.programId);
    await ctx.reply(renderStartingMessage(config, student.displayName));
  });

  bot.command("reflect", async (ctx) => {
    const student = await getStudent(ctx, store);
    const replies = await handleReflectCommand({ store, student, modelRouter });
    for (const reply of replies) await ctx.reply(reply);
  });

  bot.command("new", async (ctx) => {
    const student = await getStudent(ctx, store);
    const replies = await handleNewReflectionCommand({ store, student, modelRouter });
    for (const reply of replies) await ctx.reply(reply);
  });

  bot.command("model", async (ctx) => {
    const student = await getStudent(ctx, store);
    const response = await handleModelCommand({ store, student, modelRouter });
    await ctx.reply(response.text, response.replyMarkup ? { reply_markup: response.replyMarkup } : undefined);
  });

  bot.callbackQuery(/^model:/, async (ctx) => {
    const student = await getStudent(ctx, store);
    const callbackData = ctx.callbackQuery.data ?? "";
    const response = await handleModelSelectionCallback({
      store,
      student,
      modelRouter,
      callbackData
    });
    await ctx.answerCallbackQuery({ text: response.callbackText });
    await ctx.reply(response.text);
  });

  bot.command("continue", async (ctx) => {
    const student = await getStudent(ctx, store);
    const session = await store.getLatestOpenReflection(student.id);
    if (!session) {
      await ctx.reply("You do not have an unfinished reflection. Send /reflect to start one.");
      return;
    }
    await ctx.reply(stagePrompts[session.currentStage]);
  });

  bot.command("summary", async (ctx) => {
    const student = await getStudent(ctx, store);
    const summary = await store.getLatestSummary(student.id);
    if (!summary) {
      await ctx.reply("No completed reflection summary yet. Send /reflect when you are ready.");
      return;
    }
    await ctx.reply(formatSummary(summary.briefSummary, summary.actionables));
  });

  bot.command("privacy", async (ctx) => {
    await ctx.reply(
      [
        "Your reflections are stored with your student profile.",
        "Teachers/admins can view summaries and actionables in the dashboard when they have permission.",
        "The bot uses structured memory themes to adapt over time; core privacy and safety rules cannot be changed by custom prompts."
      ].join("\n")
    );
  });

  bot.on("message:text", async (ctx) => {
    const student = await getStudent(ctx, store);
    const session = await store.getLatestOpenReflection(student.id);
    if (!session) {
      await ctx.reply(homeMessage);
      return;
    }

    const assignment = modelRouter.assignReflection(session.id, modelRoutingKey(student));
    const replies = await handleStudentReflectionMessage({
      store,
      model: modelRouter.getClient(assignment) ?? model,
      modelAssignment: assignment,
      session,
      student,
      text: ctx.message.text
    });

    for (const reply of replies) {
      await ctx.reply(reply);
    }
  });

  return bot;
}

export async function handleReflectCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter?: ModelRouter;
}): Promise<string[]> {
  const existing = await input.store.getLatestOpenReflection(input.student.id);
  if (existing) return [openReflectionMessage];
  return createReflectionWithPrompt(input.store, input.student, input.modelRouter);
}

export async function handleNewReflectionCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter?: ModelRouter;
}): Promise<string[]> {
  const existing = await input.store.getLatestOpenReflection(input.student.id);
  await input.store.abandonOpenReflections(input.student.id);
  return [existing ? discardedReflectionMessage : homeMessage];
}

export async function handleModelCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter: ModelRouter;
}): Promise<{ text: string; replyMarkup?: InlineKeyboard }> {
  const openReflection = await input.store.getLatestOpenReflection(input.student.id);
  if (openReflection) {
    const assignment = input.modelRouter.assignReflection(openReflection.id, modelRoutingKey(input.student));
    return {
      text: `You have a reflection in progress using ${assignment.modelName}. Finish it or send /new to discard it before changing models.`
    };
  }

  const preference = input.modelRouter.getPreference(modelRoutingKey(input.student));
  return {
    text: `Choose the model for new reflections. Current choice: ${preference.modelName}.`,
    replyMarkup: buildModelPickerKeyboard()
  };
}

export async function handleModelSelectionCallback(input: {
  store: ReflectionStore;
  student: StudentProfile;
  modelRouter: ModelRouter;
  callbackData: string;
}): Promise<{ text: string; callbackText: string }> {
  const [, modelName = ""] = input.callbackData.split(":");
  if (!isComparisonModelName(modelName)) {
    return {
      text: "That model option is not available.",
      callbackText: "Model not available"
    };
  }

  const openReflection = await input.store.getLatestOpenReflection(input.student.id);
  if (openReflection) {
    const assignment = input.modelRouter.assignReflection(openReflection.id, modelRoutingKey(input.student));
    return {
      text: `You have a reflection in progress using ${assignment.modelName}. Finish it or send /new to discard it before changing models.`,
      callbackText: "Finish or discard the current reflection first"
    };
  }

  input.modelRouter.setPreference(modelRoutingKey(input.student), modelName);
  return {
    text: `New reflections will use ${modelName}.`,
    callbackText: `New reflections will use ${modelName}`
  };
}

export async function handleStudentReflectionMessage(input: {
  store: ReflectionStore;
  model?: ModelClient;
  modelAssignment?: ModelAssignment;
  session?: ReflectionSession;
  student: Awaited<ReturnType<typeof getStudent>>;
  text: string;
}): Promise<string[]> {
  return getBotTracer().withActiveSpan("reflection.student_message", async (span) => {
    const session = input.session ?? (await input.store.getLatestOpenReflection(input.student.id));
    if (!session) {
      span.setType("workflow");
      captureTraceInput(span, "json", {
        studentId: input.student.id,
        status: "home",
        text: input.text
      });
      span.setAttributes({
        "reflection.student_id": input.student.id,
        "reflection.session_status": "home",
        "reflection.home_state": true
      });
      captureTraceOutput(span, {
        replies: [homeMessage],
        completed: false,
        currentStage: "home",
        replyKind: "home"
      });
      return [homeMessage];
    }

    span.setType("workflow");
    captureTraceInput(span, "json", {
      reflectionId: session.id,
      studentId: input.student.id,
      stage: session.currentStage,
      status: session.status,
      text: input.text,
      model: input.modelAssignment?.modelName
    });
    span.setAttributes({
      "reflection.id": session.id,
      "reflection.student_id": input.student.id,
      "reflection.stage": session.currentStage,
      "reflection.session_status": session.status,
      ...modelTraceAttributes(input.modelAssignment)
    });

    const studentTurn = {
      id: createId("turn"),
      reflectionId: session.id,
      role: "student",
      content: input.text,
      stage: session.currentStage,
      createdAt: new Date().toISOString()
    } as const;
    await input.store.addTurn(studentTurn);

    const result = await processReflectionText({
      store: input.store,
      model: input.model,
      session,
      student: input.student,
      text: input.text,
      studentTurnId: studentTurn.id
    });

    await input.store.saveReflection(result.session);

    if (result.summary) {
      await input.store.saveSummary(result.summary);
    }

    const replies = buildReflectionReplies(result);
    span.setAttributes({
      "reflection.completed": result.completed,
      "reflection.next_stage": result.session.currentStage,
      "reflection.reply_kind": result.replyKind,
      "reflection.safety_flagged": result.safetyConcern.hasConcern,
      "reflection.safety_pause": result.replyKind === "safety_followup" && result.safetyConcern.hasConcern,
      ...modelTraceAttributes(input.modelAssignment)
    });
    captureTraceOutput(span, {
      replies,
      completed: result.completed,
      currentStage: result.session.currentStage,
      replyKind: result.replyKind,
      safetyConcern: {
        hasConcern: result.safetyConcern.hasConcern,
        level: result.safetyConcern.level,
        category: result.safetyConcern.category
      },
      summary: result.summary
        ? {
            promptVersionId: result.summary.promptVersionId,
            actionablesCount: result.summary.actionables.length,
            keyLearningsCount: result.summary.keyLearnings.length
          }
        : undefined
    });

    for (const reply of replies) {
      await input.store.addTurn({
        id: createId("turn"),
        reflectionId: result.session.id,
        role: "bot",
        content: reply,
        stage: result.session.currentStage,
        createdAt: new Date().toISOString()
      });
    }

    return replies;
  });
}

export async function processReflectionText(input: {
  store: ReflectionStore;
  model?: ModelClient;
  modelAssignment?: ModelAssignment;
  session: ReflectionSession;
  student: Awaited<ReturnType<typeof getStudent>>;
  text: string;
  studentTurnId: string;
}) {
  const memory = await input.store.getMemory(input.student.id);
  const config = await input.store.getActiveConfig(input.student.programId);
  const recentTurns = await input.store.getRecentTurns(input.session.id, 10);
  const result = await handleReflectionTurn({
    profile: input.student,
    memory,
    config,
    model: input.model,
    recentTurns,
    session: input.session,
    studentMessage: input.text
  });

  if (result.safetyConcern.hasConcern) {
    await input.store.saveSafetyConcern({
      id: createId("safety"),
      reflectionId: input.session.id,
      studentId: input.student.id,
      stage: input.session.currentStage,
      studentTurnId: input.studentTurnId,
      reason: `${result.safetyConcern.category}: ${result.safetyConcern.reason ?? "Safety concern detected."}`,
      messageSnippet: toSafetySnippet(input.text),
      status: "open",
      createdAt: new Date().toISOString()
    });
  }

  return result;
}

export function buildReflectionReplies(result: {
  botMessage: string;
  safetyConcern: { hasConcern: boolean; category?: string };
}): string[] {
  return result.safetyConcern.hasConcern && result.safetyConcern.category !== "dangerous_instruction"
    ? [fixedSafetySupportMessage, result.botMessage]
    : [result.botMessage];
}

async function getStudent(ctx: Context, store: ReflectionStore) {
  const telegramUserId = String(ctx.from?.id ?? "unknown");
  const displayName = ctx.from?.first_name ?? ctx.from?.username ?? "there";
  return store.getOrCreateStudent({ telegramUserId, displayName });
}

function buildModelPickerKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  comparisonModelNames.forEach((modelName, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(modelName, `model:${modelName}`);
  });
  return keyboard;
}

async function createReflectionWithPrompt(
  store: ReflectionStore,
  student: StudentProfile,
  modelRouter?: ModelRouter
): Promise<string[]> {
  const session = await store.createReflection(student.id);
  modelRouter?.assignReflection(session.id, modelRoutingKey(student));
  await store.addTurn({
    id: createId("turn"),
    reflectionId: session.id,
    role: "bot",
    content: stagePrompts.description,
    stage: "description",
    createdAt: new Date().toISOString()
  });
  return [stagePrompts.description];
}

export function modelTraceAttributes(assignment?: ModelAssignment): Record<string, string> {
  if (!assignment) return {};
  return {
    "reflection.model.variant": assignment.modelName,
    "reflection.model.assignment_source": assignment.source,
    "reflection.model.comparison_group": "in_situ_manual"
  };
}

function modelRoutingKey(student: StudentProfile): string {
  return student.telegramUserId ?? student.id;
}

function formatSummary(briefSummary: string, actionables: string[]): string {
  return [`Latest reflection summary:`, briefSummary, "", "Actionables:", ...actionables.map((item) => `- ${item}`)].join("\n");
}

function toSafetySnippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}
