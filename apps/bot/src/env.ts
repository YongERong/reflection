import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  PORT: z.coerce.number().int().positive().default(8787),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  LANGWATCH_API_KEY: z.string().optional(),
  LANGWATCH_PROJECT_ID: z.string().optional(),
  LANGWATCH_ENDPOINT: z.string().url().optional(),
  LANGWATCH_CAPTURE_MODE: z.enum(["all", "input", "output", "none"]).default("all"),
  LANGWATCH_DEBUG: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  NODE_ENV: z.string().optional()
});

export const env = envSchema.parse(process.env);
