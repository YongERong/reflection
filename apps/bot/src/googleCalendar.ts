import type { ReflectionStore } from "@reflection/core";
import { decryptToken } from "./tokenCrypto.js";

export const defaultGoogleCalendarScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events"
];

export function parseGoogleCalendarScopes(value: string | undefined): string[] {
  const configured = value?.split(/\s+/).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : defaultGoogleCalendarScopes;
}

export type GoogleTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type GoogleUserInfo = {
  sub: string;
  email: string;
  email_verified?: boolean;
};

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly googleError?: string,
    readonly payload?: unknown
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export type CalendarEventPayload = {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string } | { date: string };
  end: { dateTime: string; timeZone?: string } | { date: string };
  attendees?: Array<{ email: string }>;
};

export function createGoogleOAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri
  });
  const response = await (input.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return parseGoogleResponse<GoogleTokenResponse>(response, "Google OAuth token exchange failed");
}

export async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken
  });
  const response = await (input.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return parseGoogleResponse<GoogleTokenResponse>(response, "Google OAuth token refresh failed");
}

export async function fetchGoogleUserInfo(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleUserInfo> {
  const response = await (input.fetchImpl ?? fetch)("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${input.accessToken}` }
  });
  const userInfo = await parseGoogleResponse<GoogleUserInfo>(response, "Google userinfo lookup failed");
  if (!userInfo.sub || !userInfo.email) {
    throw new Error("Google userinfo response did not include sub and email.");
  }
  return userInfo;
}

export class GoogleCalendarClient {
  constructor(
    private readonly input: {
      clientId: string;
      clientSecret: string;
      tokenEncryptionKey: string;
      store: ReflectionStore;
      fetchImpl?: typeof fetch;
    }
  ) {}

  async createEvent(input: {
    studentId: string;
    sourceKind: string;
    sourceId?: string;
    event: CalendarEventPayload;
  }) {
    const connection = await this.input.store.getGoogleCalendarConnection(input.studentId);
    const accessToken = await this.getAccessToken(input.studentId);
    const calendarId = connection?.calendarId ?? "primary";
    const response = await this.fetchCalendarJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.event)
      },
      accessToken
    );
    await this.input.store.upsertGoogleCalendarEvent({
      studentId: input.studentId,
      googleEventId: String(response.id),
      calendarId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      lastSyncedPayload: input.event,
      status: "active"
    });
    return response;
  }

  async updateEvent(input: {
    studentId: string;
    googleEventId: string;
    calendarId?: string;
    sourceKind: string;
    sourceId?: string;
    event: CalendarEventPayload;
  }) {
    const connection = await this.input.store.getGoogleCalendarConnection(input.studentId);
    const accessToken = await this.getAccessToken(input.studentId);
    const calendarId = input.calendarId ?? connection?.calendarId ?? "primary";
    const response = await this.fetchCalendarJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.googleEventId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.event)
      },
      accessToken
    );
    await this.input.store.upsertGoogleCalendarEvent({
      studentId: input.studentId,
      googleEventId: input.googleEventId,
      calendarId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      lastSyncedPayload: input.event,
      status: "active"
    });
    return response;
  }

  private async getAccessToken(studentId: string): Promise<string> {
    const encryptedRefreshToken = await this.input.store.getEncryptedGoogleCalendarRefreshToken(studentId);
    if (!encryptedRefreshToken) throw new Error("Google Calendar is not connected.");
    const refreshToken = decryptToken(encryptedRefreshToken, this.input.tokenEncryptionKey);
    try {
      const token = await refreshGoogleAccessToken({
        clientId: this.input.clientId,
        clientSecret: this.input.clientSecret,
        refreshToken,
        fetchImpl: this.input.fetchImpl
      });
      return token.access_token;
    } catch (error) {
      if (isPermanentRefreshTokenFailure(error)) {
        await this.input.store.markGoogleCalendarConnectionNeedsReauth(studentId);
      }
      throw error;
    }
  }

  private async fetchCalendarJson(url: string, init: RequestInit, accessToken: string) {
    const response = await (this.input.fetchImpl ?? fetch)(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${accessToken}`
      }
    });
    return parseGoogleResponse<Record<string, unknown>>(response, "Google Calendar API request failed");
  }
}

async function parseGoogleResponse<T>(response: Response, message: string): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const googleError = getGoogleError(payload);
    const details = googleError ? JSON.stringify(payload) : response.statusText;
    throw new GoogleApiError(`${message}: ${details}`, response.status, googleError, payload);
  }
  return payload as T;
}

function getGoogleError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function isPermanentRefreshTokenFailure(error: unknown): boolean {
  return error instanceof GoogleApiError && error.googleError === "invalid_grant";
}
