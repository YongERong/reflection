import { describe, expect, it, vi } from "vitest";
import {
  createGoogleOAuthUrl,
  defaultGoogleCalendarScopes,
  GoogleCalendarClient,
  parseGoogleCalendarScopes
} from "./googleCalendar.js";
import { InMemoryReflectionStore } from "./inMemoryStore.js";
import { encryptToken } from "./tokenCrypto.js";

describe("Google Calendar OAuth helpers", () => {
  it("uses default scopes when the scope override is unset or blank", () => {
    expect(parseGoogleCalendarScopes(undefined)).toEqual(defaultGoogleCalendarScopes);
    expect(parseGoogleCalendarScopes("")).toEqual(defaultGoogleCalendarScopes);
    expect(parseGoogleCalendarScopes("   \n\t  ")).toEqual(defaultGoogleCalendarScopes);
  });

  it("uses custom scopes when the scope override is non-empty", () => {
    expect(parseGoogleCalendarScopes("openid email custom.scope")).toEqual([
      "openid",
      "email",
      "custom.scope"
    ]);
  });

  it("builds an offline Google OAuth URL with requested scopes and state", () => {
    const url = new URL(createGoogleOAuthUrl({
      clientId: "client-id",
      redirectUri: "https://bot.example.com/google-calendar/callback",
      state: "state-token",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"]
    }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("marks the connection as needing reauth when refresh fails", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_google_refresh", displayName: "Asha" });
    await store.saveGoogleCalendarConnection({
      studentId: student.id,
      googleSub: "google-sub",
      googleEmail: "asha@example.com",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      encryptedRefreshToken: encryptToken("refresh-token", "secret"),
      calendarId: "primary",
      connectedAt: "2026-05-11T01:00:00.000Z"
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant"
    }), { status: 400 }));
    const client = new GoogleCalendarClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenEncryptionKey: "secret",
      store,
      fetchImpl
    });

    await expect(client.createEvent({
      studentId: student.id,
      sourceKind: "test",
      event: {
        summary: "Reflection",
        start: { dateTime: "2026-05-11T09:00:00+08:00" },
        end: { dateTime: "2026-05-11T09:30:00+08:00" }
      }
    })).rejects.toThrow("Google OAuth token refresh failed");
    expect(await store.getGoogleCalendarConnection(student.id)).toMatchObject({
      status: "needs_reauth"
    });
  });

  it("does not mark reauth on transient Google refresh errors", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_google_500", displayName: "Ben" });
    await store.saveGoogleCalendarConnection({
      studentId: student.id,
      googleSub: "google-sub",
      googleEmail: "ben@example.com",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      encryptedRefreshToken: encryptToken("refresh-token", "secret"),
      calendarId: "primary",
      connectedAt: "2026-05-11T01:00:00.000Z"
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "temporarily_unavailable"
    }), { status: 500 }));
    const client = new GoogleCalendarClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenEncryptionKey: "secret",
      store,
      fetchImpl
    });

    await expect(client.createEvent({
      studentId: student.id,
      sourceKind: "test",
      event: {
        summary: "Reflection",
        start: { dateTime: "2026-05-11T09:00:00+08:00" },
        end: { dateTime: "2026-05-11T09:30:00+08:00" }
      }
    })).rejects.toThrow("Google OAuth token refresh failed");
    expect(await store.getGoogleCalendarConnection(student.id)).toMatchObject({
      status: "active"
    });
  });

  it("does not mark reauth on network refresh errors", async () => {
    const store = new InMemoryReflectionStore();
    const student = await store.getOrCreateStudent({ telegramUserId: "tg_google_network", displayName: "Chloe" });
    await store.saveGoogleCalendarConnection({
      studentId: student.id,
      googleSub: "google-sub",
      googleEmail: "chloe@example.com",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      encryptedRefreshToken: encryptToken("refresh-token", "secret"),
      calendarId: "primary",
      connectedAt: "2026-05-11T01:00:00.000Z"
    });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const client = new GoogleCalendarClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenEncryptionKey: "secret",
      store,
      fetchImpl
    });

    await expect(client.createEvent({
      studentId: student.id,
      sourceKind: "test",
      event: {
        summary: "Reflection",
        start: { dateTime: "2026-05-11T09:00:00+08:00" },
        end: { dateTime: "2026-05-11T09:30:00+08:00" }
      }
    })).rejects.toThrow("network down");
    expect(await store.getGoogleCalendarConnection(student.id)).toMatchObject({
      status: "active"
    });
  });
});
