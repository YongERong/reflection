import cors from "@fastify/cors";
import Fastify from "fastify";
import { createReflectionBot } from "./bot.js";
import { loadDashboardData } from "./dashboardData.js";
import { env } from "./env.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const store = new InMemoryReflectionStore();
const bot = env.TELEGRAM_BOT_TOKEN ? createReflectionBot(env.TELEGRAM_BOT_TOKEN, store) : null;

app.get("/health", async () => ({
  ok: true,
  telegramConfigured: Boolean(bot)
}));

app.get("/api/dashboard", async (_request, reply) => {
  try {
    return await loadDashboardData();
  } catch (error) {
    app.log.error(error);
    reply.code(500);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load dashboard data"
    };
  }
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
