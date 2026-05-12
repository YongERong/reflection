import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  PORT: z.coerce.number().int().positive().default(8787),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_CALENDAR_SCOPES: z.string().optional(),
  LANGWATCH_API_KEY: z.string().optional(),
  LANGWATCH_PROJECT_ID: z.string().optional(),
  LANGWATCH_ENDPOINT: z.string().url().optional(),
  LANGWATCH_CAPTURE_MODE: z.enum(["all", "input", "output", "none"]).default("all"),
  LANGWATCH_DEBUG: z.string().optional(),
  BOT_RESPONSE_DELAY: z
    .string()
    .optional()
    .transform((value) => parseBotResponseDelay(value)),
  BOT_REPLY_SPLIT_RATE: z
    .string()
    .optional()
    .transform((value) => parseBotReplySplitRate(value)),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  NODE_ENV: z.string().optional()
});

export const env = envSchema.parse(process.env);

export function parseBotResponseDelay(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error("BOT_RESPONSE_DELAY must be an integer number of seconds between 0 and 30.");
  }
  if (parsed < 0 || parsed > 30) {
    throw new Error("BOT_RESPONSE_DELAY must be between 0 and 30 seconds.");
  }
  return parsed;
}

export function parseBotReplySplitRate(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0.2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("BOT_REPLY_SPLIT_RATE must be a number between 0 and 1.");
  }
  if (parsed < 0 || parsed > 1) {
    throw new Error("BOT_REPLY_SPLIT_RATE must be between 0 and 1.");
  }
  return parsed;
}
