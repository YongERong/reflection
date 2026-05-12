import { createReflectionBot } from "./bot.js";
import { env } from "./env.js";
import { setupBotObservability } from "./observability.js";
import { createComparisonModelRouter, createModelClient } from "./openAIModelClient.js";
import { createRuntimeStore } from "./storeFactory.js";

if (!env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required for polling mode.");
}

setupBotObservability();

const store = createRuntimeStore();
const model = createModelClient();
const modelRouter = createComparisonModelRouter();
const googleCalendarConfigured = Boolean(
  env.GOOGLE_CLIENT_ID &&
  env.GOOGLE_CLIENT_SECRET &&
  env.GOOGLE_TOKEN_ENCRYPTION_KEY
);
const bot = createReflectionBot(env.TELEGRAM_BOT_TOKEN, store, model, modelRouter, {
  responseDelaySeconds: env.BOT_RESPONSE_DELAY,
  replySplitRate: env.BOT_REPLY_SPLIT_RATE,
  googleCalendar: {
    enabled: googleCalendarConfigured,
    publicBaseUrl: env.PUBLIC_BASE_URL
  }
});
const me = await bot.api.getMe();

console.log(`Reflection bot is running in Telegram polling mode as @${me.username}.`);
console.log(
  `Storage backend: ${store.kind}. LangWatch configured: ${Boolean(env.LANGWATCH_API_KEY)}. Model configured: ${Boolean(model)}. Bot response delay: ${env.BOT_RESPONSE_DELAY}s. Reply split rate: ${env.BOT_REPLY_SPLIT_RATE}.`
);
console.log(`Google Calendar configured: ${googleCalendarConfigured}. Public base URL: ${env.PUBLIC_BASE_URL}.`);
console.log("Use /start or /reflect in Telegram to test the full student flow.");

await bot.api.deleteWebhook({ drop_pending_updates: false });

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

await bot.start({
  drop_pending_updates: false
});
