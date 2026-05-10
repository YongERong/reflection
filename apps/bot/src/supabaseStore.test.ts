import { describe, expect, it, vi } from "vitest";
import { SupabaseReflectionStore } from "./supabaseStore.js";

describe("SupabaseReflectionStore Telegram pending batches", () => {
  it("passes separate ready and freshness timestamps to the claim RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        id: "11111111-1111-1111-1111-111111111111",
        student_id: "22222222-2222-2222-2222-222222222222",
        reflection_id: "33333333-3333-3333-3333-333333333333",
        telegram_chat_id: "tg_claim",
        messages: [{ text: "hello", receivedAt: "2026-05-10T12:00:00.000Z" }],
        message_count: 1,
        first_message_at: "2026-05-10T12:00:00.000Z",
        last_message_at: "2026-05-10T12:00:00.000Z",
        flush_after: "2026-05-10T12:00:05.000Z",
        status: "processing",
        stale: true,
        processing_expires_at: "2026-05-10T12:17:00.000Z",
        cancellation_reason: null,
        created_at: "2026-05-10T12:00:00.000Z",
        updated_at: "2026-05-10T12:16:00.000Z"
      }],
      error: null
    });
    const store = new SupabaseReflectionStore("https://example.supabase.co", "service-role-key");
    (store as unknown as { client: { rpc: typeof rpc } }).client = { rpc };

    const batches = await store.claimReadyTelegramPendingBatches({
      readyAt: "2026-05-10T12:15:58.000Z",
      now: "2026-05-10T12:16:00.000Z",
      staleAfterSeconds: 15 * 60,
      processingLeaseSeconds: 60,
      limit: 10
    });

    expect(rpc).toHaveBeenCalledWith("claim_ready_telegram_pending_batches", {
      p_ready_at: "2026-05-10T12:15:58.000Z",
      p_now: "2026-05-10T12:16:00.000Z",
      p_stale_after_seconds: 15 * 60,
      p_processing_lease_seconds: 60,
      p_limit: 10
    });
    expect(batches[0]).toMatchObject({
      telegramChatId: "tg_claim",
      stale: true,
      processingExpiresAt: "2026-05-10T12:17:00.000Z",
      status: "processing"
    });
  });
});
