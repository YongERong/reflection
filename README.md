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

Copy `.env.example` to `.env` and fill credentials before connecting Telegram or Supabase.
