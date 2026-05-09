import cors from "@fastify/cors";
import Fastify from "fastify";
import { createReflectionBot } from "./bot.js";
import { env } from "./env.js";
import { createModelClient } from "./openAIModelClient.js";
import { createRuntimeStore } from "./storeFactory.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const store = createRuntimeStore();
const model = createModelClient();
const bot = env.TELEGRAM_BOT_TOKEN ? createReflectionBot(env.TELEGRAM_BOT_TOKEN, store, model) : null;

app.get("/health", async () => {
  const storage = store.healthCheck ? await store.healthCheck() : { ok: true };
  return {
    ok: storage.ok,
    telegramConfigured: Boolean(bot),
    storage: store.kind,
    supabase: storage,
    langwatchConfigured: Boolean(env.LANGWATCH_API_KEY),
    modelConfigured: Boolean(model)
  };
});

app.post("/telegram/webhook", async (request, reply) => {
  if (!bot) {
    reply.code(503);
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };
  }

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      reply.code(401);
      return { ok: false };
    }
  }

  await bot.handleUpdate(request.body as never);
  return { ok: true };
});

app.listen({ host: "0.0.0.0", port: env.PORT }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
