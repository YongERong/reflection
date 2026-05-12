import cors from "@fastify/cors";
import Fastify from "fastify";
import { createReflectionBot } from "./bot.js";
import { loadDashboardData } from "./dashboardData.js";
import { env } from "./env.js";
import {
  createGoogleOAuthUrl,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserInfo,
  parseGoogleCalendarScopes
} from "./googleCalendar.js";
import { setupBotObservability } from "./observability.js";
import { createComparisonModelRouter, createModelClient } from "./openAIModelClient.js";
import { createRuntimeStore } from "./storeFactory.js";
import { encryptToken, sha256Hex } from "./tokenCrypto.js";

setupBotObservability();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const store = createRuntimeStore();
const model = createModelClient();
const modelRouter = createComparisonModelRouter();
const googleCalendarConfigured = Boolean(
  env.GOOGLE_CLIENT_ID &&
  env.GOOGLE_CLIENT_SECRET &&
  env.GOOGLE_TOKEN_ENCRYPTION_KEY
);
const bot = env.TELEGRAM_BOT_TOKEN
  ? createReflectionBot(env.TELEGRAM_BOT_TOKEN, store, model, modelRouter, {
      responseDelaySeconds: env.BOT_RESPONSE_DELAY,
      replySplitRate: env.BOT_REPLY_SPLIT_RATE,
      googleCalendar: {
        enabled: googleCalendarConfigured,
        publicBaseUrl: env.PUBLIC_BASE_URL
      }
    })
  : null;

app.get("/health", async () => {
  const storage = store.healthCheck ? await store.healthCheck() : { ok: true };
  return {
    ok: storage.ok,
    telegramConfigured: Boolean(bot),
    storage: store.kind,
    supabase: storage,
    langwatchConfigured: Boolean(env.LANGWATCH_API_KEY),
    modelConfigured: Boolean(model),
    googleCalendarConfigured,
    botResponseDelaySeconds: env.BOT_RESPONSE_DELAY,
    botReplySplitRate: env.BOT_REPLY_SPLIT_RATE
  };
});

app.get("/google-calendar/connect", async (request, reply) => {
  if (!googleCalendarConfigured) {
    reply.code(503);
    return { ok: false, error: "Google Calendar linking is not configured" };
  }

  const token = typeof request.query === "object" && request.query && "token" in request.query
    ? String(request.query.token)
    : "";
  if (!token) {
    reply.code(400);
    return html(reply, "Invalid Google Calendar Link", "This Google Calendar link is missing its token.");
  }

  const link = await store.getValidGoogleCalendarAuthLinkByTokenHash({
    tokenHash: sha256Hex(token),
    now: new Date().toISOString()
  });
  if (!link) {
    reply.code(400);
    return html(reply, "Expired Google Calendar Link", "This link is expired or was already used. Return to Telegram and send /calendar for a fresh link.");
  }

  const authUrl = createGoogleOAuthUrl({
    clientId: env.GOOGLE_CLIENT_ID!,
    redirectUri: googleCalendarRedirectUri(),
    state: link.state,
    scopes: googleCalendarScopes()
  });
  return reply.redirect(authUrl);
});

app.get("/google-calendar/callback", async (request, reply) => {
  if (!googleCalendarConfigured) {
    reply.code(503);
    return { ok: false, error: "Google Calendar linking is not configured" };
  }

  const query = request.query as Record<string, unknown>;
  const error = typeof query.error === "string" ? query.error : "";
  const code = typeof query.code === "string" ? query.code : "";
  const state = typeof query.state === "string" ? query.state : "";
  if (error) {
    reply.code(400);
    return html(reply, "Google Calendar Not Connected", "Google did not grant calendar access. You can return to Telegram and try /calendar again.");
  }
  if (!code || !state) {
    reply.code(400);
    return html(reply, "Google Calendar Not Connected", "The Google callback was missing required information.");
  }

  const now = new Date().toISOString();
  const link = await store.consumeGoogleCalendarAuthLinkByState({
    state,
    now,
    usedAt: now
  });
  if (!link) {
    reply.code(400);
    return html(reply, "Expired Google Calendar Link", "This link is expired or was already used. Return to Telegram and send /calendar for a fresh link.");
  }

  try {
    const token = await exchangeGoogleAuthorizationCode({
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      redirectUri: googleCalendarRedirectUri(),
      code
    });
    if (!token.refresh_token) {
      reply.code(400);
      return html(reply, "Google Calendar Not Connected", "Google did not return offline calendar access. Return to Telegram and try /calendar again.");
    }

    const userInfo = await fetchGoogleUserInfo({ accessToken: token.access_token });
    await store.saveGoogleCalendarConnection({
      studentId: link.studentId,
      googleSub: userInfo.sub,
      googleEmail: userInfo.email,
      scopes: (token.scope ?? googleCalendarScopes().join(" ")).split(/\s+/).filter(Boolean),
      encryptedRefreshToken: encryptToken(token.refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY!),
      calendarId: "primary",
      connectedAt: now
    });

    if (bot && link.telegramChatId) {
      try {
        await bot.api.sendMessage(link.telegramChatId, `Google Calendar connected as ${userInfo.email}.`);
      } catch (sendError) {
        app.log.warn(sendError, "Failed to send Google Calendar connection confirmation to Telegram");
      }
    }

    return html(reply, "Google Calendar Connected", "You can close this tab and return to Telegram.");
  } catch (callbackError) {
    app.log.error(callbackError);
    reply.code(500);
    return html(reply, "Google Calendar Not Connected", "Something went wrong while connecting Google Calendar. Return to Telegram and try /calendar again.");
  }
});

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

function googleCalendarRedirectUri(): string {
  return new URL("/google-calendar/callback", env.PUBLIC_BASE_URL).toString();
}

function googleCalendarScopes(): string[] {
  return parseGoogleCalendarScopes(env.GOOGLE_CALENDAR_SCOPES);
}

function html(reply: { type: (contentType: string) => unknown; send: (payload: string) => unknown }, title: string, body: string) {
  reply.type("text/html; charset=utf-8");
  return reply.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f7f5; color: #1f2933; }
      main { max-width: 32rem; padding: 2rem; }
      h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
      p { margin: 0; line-height: 1.55; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
