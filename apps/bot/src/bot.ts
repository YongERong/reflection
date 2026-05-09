import { Bot, type Context } from "grammy";
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

export const openReflectionMessage =
  "You already have a reflection in progress. Send /continue to keep going, or /new to start over.";

export function createReflectionBot(token: string, store: ReflectionStore, model?: ModelClient): Bot {
  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const student = await getStudent(ctx, store);
    const config = await store.getActiveConfig(student.programId);
    await ctx.reply(renderStartingMessage(config, student.displayName));
  });

  bot.command("reflect", async (ctx) => {
    const student = await getStudent(ctx, store);
    const replies = await handleReflectCommand({ store, student });
    for (const reply of replies) await ctx.reply(reply);
  });

  bot.command("new", async (ctx) => {
    const student = await getStudent(ctx, store);
    const replies = await handleNewReflectionCommand({ store, student });
    for (const reply of replies) await ctx.reply(reply);
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
    const session = (await store.getLatestOpenReflection(student.id)) ?? (await store.createReflection(student.id));
    const replies = await handleStudentReflectionMessage({
      store,
      model,
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
}): Promise<string[]> {
  const existing = await input.store.getLatestOpenReflection(input.student.id);
  if (existing) return [openReflectionMessage];
  return createReflectionWithPrompt(input.store, input.student.id);
}

export async function handleNewReflectionCommand(input: {
  store: ReflectionStore;
  student: StudentProfile;
}): Promise<string[]> {
  await input.store.abandonOpenReflections(input.student.id);
  return createReflectionWithPrompt(input.store, input.student.id);
}

export async function handleStudentReflectionMessage(input: {
  store: ReflectionStore;
  model?: ModelClient;
  session?: ReflectionSession;
  student: Awaited<ReturnType<typeof getStudent>>;
  text: string;
}): Promise<string[]> {
  const session = input.session ?? (await input.store.createReflection(input.student.id));
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
}

export async function processReflectionText(input: {
  store: ReflectionStore;
  model?: ModelClient;
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

async function createReflectionWithPrompt(store: ReflectionStore, studentId: string): Promise<string[]> {
  const session = await store.createReflection(studentId);
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

function formatSummary(briefSummary: string, actionables: string[]): string {
  return [`Latest reflection summary:`, briefSummary, "", "Actionables:", ...actionables.map((item) => `- ${item}`)].join("\n");
}

function toSafetySnippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}
