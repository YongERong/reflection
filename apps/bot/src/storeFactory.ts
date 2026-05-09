import type { ReflectionStore } from "@reflection/core";
import { env } from "./env.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";
import { SupabaseReflectionStore } from "./supabaseStore.js";

export type RuntimeStore = ReflectionStore & {
  kind: "memory" | "supabase";
  healthCheck?: () => Promise<{ ok: boolean; error?: string }>;
};

export function createRuntimeStore(): RuntimeStore {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const store = new SupabaseReflectionStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    return Object.assign(store, { kind: "supabase" as const });
  }

  return Object.assign(new InMemoryReflectionStore(), { kind: "memory" as const });
}
