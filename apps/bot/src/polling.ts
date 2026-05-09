import { createReflectionBot } from "./bot.js";
import { env } from "./env.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";

if (!env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required for polling mode.");
}

const store = new InMemoryReflectionStore();
const bot = createReflectionBot(env.TELEGRAM_BOT_TOKEN, store);
const me = await bot.api.getMe();

console.log(`Reflection bot is running in Telegram polling mode as @${me.username}.`);
console.log("Use /start or /reflect in Telegram to test the full student flow.");

await bot.api.deleteWebhook({ drop_pending_updates: false });

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

await bot.start({
  drop_pending_updates: false
});
