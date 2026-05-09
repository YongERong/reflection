# Reflection Bot

A TypeScript monorepo for a Telegram reflection bot built around a modified Gibbs cycle:

1. Description
2. People
3. Feelings
4. Evaluation
5. Analysis
6. Conclusion
7. Action plan

The implementation keeps core safety, privacy, and pedagogy stable while allowing bounded configuration of mood, starting message, school/program context, summary format, and registered skills.

## Structure

- `apps/bot`: Fastify + grammY Telegram webhook server.
- `apps/dashboard`: React/Vite dashboard shell for teachers/admins.
- `packages/core`: Gibbs cycle, prompt configuration, skill registry, and reflection orchestration.
- `supabase/migrations`: Database schema and RLS policies.
- `better-agents`: scenario/evaluation seeds for LangWatch Better Agents.

## Run

```bash
npm install
npm run test
npm run dev:bot
npm run dev:dashboard
```

Copy `.env.example` to `.env` and fill credentials before connecting Telegram, Supabase, or model-backed coaching.

## Supabase

The bot automatically uses Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present. Apply the SQL in `supabase/migrations/202605090001_initial_reflection_schema.sql` before starting the bot; otherwise `/health` will report that the app tables are missing.

The local polling bot is useful for Telegram testing:

```bash
npm run dev:bot:polling
```

## Adaptive Safety and Coaching

Set `OPENAI_API_KEY` to enable the server-side model layer. `OPENAI_MODEL` defaults to `gpt-4o-mini` when unset. Without an OpenAI key, the bot falls back to deterministic safety matching and fixed Gibbs prompts.

Safety handling is non-configurable: obvious self-harm and danger phrases are caught deterministically, ambiguous messages can be classified by the model, and student-visible safety support is sent before the reflection continues.
