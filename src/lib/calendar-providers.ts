import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { getOpenClawHome } from "@/lib/paths";
import { readCalendarEntries, writeCalendarEntries, type CalendarEntry } from "@/lib/calendar-store";

export type CalendarProviderType = "caldav";

export type CalendarProviderAccount = {
  id: string;
  type: CalendarProviderType;
  vendor?: "icloud" | "google";
  label: string;
  serverUrl: string;
  calendarUrl: string;
  calendarId?: string;
  username: string;
  cutoffDate?: string;
  secretRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
};

type ProviderStore = {
  version: 1;
  accounts: CalendarProviderAccount[];
};

type SecretStore = {
  version: 1;
  values: Record<string, string>;
};

type GoogleOAuthClientStore = {
  version: 1;
  clientId: string;
  secretRef: string;
  redirectUri?: string;
  updatedAt: string;
};

type GoogleOAuthTokenStore = {
  version: 1;
  refreshTokenRef: string;
  accessTokenRef?: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  tokenType?: string;
  updatedAt: string;
};

function providersPath(workspace: string): string {
  return join(workspace, "calendar-providers.json");
}

function credentialsDir(): string {
  return join(getOpenClawHome(), "credentials");
}

function secretPath(): string {
  return join(credentialsDir(), "calendar-provider-secrets.json");
}

function keyPath(): string {
  return join(credentialsDir(), "calendar-provider-key.bin");
}

function googleOAuthClientPath(): string {
  return join(credentialsDir(), "calendar-google-oauth-client.json");
}

function googleOAuthTokenPath(): string {
  return join(credentialsDir(), "calendar-google-oauth-token.json");
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function getOrCreateKey(): Promise<Buffer> {
  await mkdir(credentialsDir(), { recursive: true });
  try {
    const existing = await readFile(keyPath());
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {
    // continue
  }
  const key = randomBytes(32);
  await writeFile(keyPath(), key);
  return key;
}

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decrypt(payload: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

async function readSecrets(): Promise<SecretStore> {
  try {
    const raw = await readFile(secretPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SecretStore>;
    return { version: 1, values: parsed.values || {} };
  } catch {
    return { version: 1, values: {} };
  }
}

async function writeSecrets(store: SecretStore): Promise<void> {
  await mkdir(credentialsDir(), { recursive: true });
  await writeFile(secretPath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function putCalendarProviderSecret(secret: string): Promise<string> {
  const key = await getOrCreateKey();
  const store = await readSecrets();
  const ref = `caldav:${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 18)}`;
  store.values[ref] = encrypt(secret, key);
  await writeSecrets(store);
  return ref;
}

export async function readCalendarProviderSecret(secretRef: string): Promise<string | null> {
  const key = await getOrCreateKey();
  const store = await readSecrets();
  const payload = store.values[secretRef];
  if (!payload) return null;
  try {
    return decrypt(payload, key);
  } catch {
    return null;
  }
}

export async function deleteCalendarProviderSecret(secretRef: string): Promise<void> {
  const store = await readSecrets();
  if (!store.values[secretRef]) return;
  delete store.values[secretRef];
  await writeSecrets(store);
}

export async function readGoogleOAuthClientConfig(): Promise<GoogleOAuthClientStore | null> {
  try {
    const raw = await readFile(googleOAuthClientPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GoogleOAuthClientStore>;
    if (!parsed.clientId || !parsed.secretRef) return null;
    return {
      version: 1,
      clientId: String(parsed.clientId),
      secretRef: String(parsed.secretRef),
      redirectUri: parsed.redirectUri ? String(parsed.redirectUri) : undefined,
      updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function readGoogleOAuthClientSecret(): Promise<string | null> {
  const cfg = await readGoogleOAuthClientConfig();
  if (!cfg?.secretRef) return null;
  return readCalendarProviderSecret(cfg.secretRef);
}

export async function upsertGoogleOAuthClientConfig(payload: {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<GoogleOAuthClientStore> {
  const clientId = payload.clientId.trim();
  const clientSecret = payload.clientSecret.trim();
  if (!clientId || !clientSecret) {
    throw new Error("clientId and clientSecret are required");
  }

  const existing = await readGoogleOAuthClientConfig();
  const secretRef = await putCalendarProviderSecret(clientSecret);
  if (existing?.secretRef) {
    await deleteCalendarProviderSecret(existing.secretRef);
  }

  const next: GoogleOAuthClientStore = {
    version: 1,
    clientId,
    secretRef,
    redirectUri: payload.redirectUri?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(credentialsDir(), { recursive: true });
  await writeFile(googleOAuthClientPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function deleteGoogleOAuthClientConfig(): Promise<void> {
  const existing = await readGoogleOAuthClientConfig();
  if (existing?.secretRef) {
    await deleteCalendarProviderSecret(existing.secretRef);
  }
  try {
    await unlink(googleOAuthClientPath());
  } catch {
    // ignore missing file
  }
}

async function readGoogleOAuthTokenStore(): Promise<GoogleOAuthTokenStore | null> {
  try {
    const raw = await readFile(googleOAuthTokenPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GoogleOAuthTokenStore>;
    if (!parsed.refreshTokenRef) return null;
    return {
      version: 1,
      refreshTokenRef: String(parsed.refreshTokenRef),
      accessTokenRef: parsed.accessTokenRef ? String(parsed.accessTokenRef) : undefined,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt ? String(parsed.accessTokenExpiresAt) : undefined,
      scope: parsed.scope ? String(parsed.scope) : undefined,
      tokenType: parsed.tokenType ? String(parsed.tokenType) : undefined,
      updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function writeGoogleOAuthTokenStore(store: GoogleOAuthTokenStore): Promise<void> {
  await mkdir(credentialsDir(), { recursive: true });
  await writeFile(googleOAuthTokenPath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function getGoogleOAuthStatus(): Promise<{ connected: boolean; expiresAt?: string }> {
  const store = await readGoogleOAuthTokenStore();
  return {
    connected: Boolean(store?.refreshTokenRef),
    expiresAt: store?.accessTokenExpiresAt,
  };
}

export async function clearGoogleOAuthTokens(): Promise<void> {
  const existing = await readGoogleOAuthTokenStore();
  if (existing?.refreshTokenRef) await deleteCalendarProviderSecret(existing.refreshTokenRef);
  if (existing?.accessTokenRef) await deleteCalendarProviderSecret(existing.accessTokenRef);
  try {
    await unlink(googleOAuthTokenPath());
  } catch {
    // ignore missing file
  }
}

export async function exchangeGoogleOAuthCode(code: string, redirectUri: string): Promise<void> {
  const client = await readGoogleOAuthClientConfig();
  const clientSecret = await readGoogleOAuthClientSecret();
  if (!client?.clientId || !clientSecret) {
    throw new Error("Google OAuth client is not configured");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${compactBody(text, 320)}`);
  }
  const data = JSON.parse(text) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  const existing = await readGoogleOAuthTokenStore();
  const refreshToken = (data.refresh_token || "").trim();
  const fallbackRefreshToken = existing?.refreshTokenRef ? await readCalendarProviderSecret(existing.refreshTokenRef) : null;
  const resolvedRefreshToken = refreshToken || (fallbackRefreshToken || "");
  const accessToken = (data.access_token || "").trim();
  if (!resolvedRefreshToken || !accessToken) {
    throw new Error("Google OAuth did not return usable refresh/access tokens");
  }

  const refreshTokenRef = await putCalendarProviderSecret(resolvedRefreshToken);
  const accessTokenRef = await putCalendarProviderSecret(accessToken);
  if (existing?.refreshTokenRef) await deleteCalendarProviderSecret(existing.refreshTokenRef);
  if (existing?.accessTokenRef) await deleteCalendarProviderSecret(existing.accessTokenRef);

  const expiresAt = data.expires_in
    ? new Date(Date.now() + Math.max(0, data.expires_in - 60) * 1000).toISOString()
    : undefined;

  await writeGoogleOAuthTokenStore({
    version: 1,
    refreshTokenRef,
    accessTokenRef,
    accessTokenExpiresAt: expiresAt,
    scope: data.scope,
    tokenType: data.token_type,
    updatedAt: new Date().toISOString(),
  });
}

export async function getGoogleOAuthAccessToken(): Promise<string> {
  const store = await readGoogleOAuthTokenStore();
  if (!store?.refreshTokenRef) {
    throw new Error("Google OAuth is not connected yet. Click Connect Google first.");
  }

  if (store.accessTokenRef && store.accessTokenExpiresAt) {
    const expiresMs = new Date(store.accessTokenExpiresAt).getTime();
    if (!Number.isNaN(expiresMs) && expiresMs > Date.now() + 15000) {
      const token = await readCalendarProviderSecret(store.accessTokenRef);
      if (token) return token;
    }
  }

  const client = await readGoogleOAuthClientConfig();
  const clientSecret = await readGoogleOAuthClientSecret();
  const refreshToken = await readCalendarProviderSecret(store.refreshTokenRef);
  if (!client?.clientId || !clientSecret || !refreshToken) {
    throw new Error("Google OAuth token refresh is not configured correctly");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${compactBody(text, 320)}`);
  }
  const data = JSON.parse(text) as { access_token?: string; expires_in?: number; scope?: string; token_type?: string };
  const nextAccess = (data.access_token || "").trim();
  if (!nextAccess) throw new Error("Google token refresh response missing access_token");

  const nextAccessRef = await putCalendarProviderSecret(nextAccess);
  if (store.accessTokenRef) await deleteCalendarProviderSecret(store.accessTokenRef);
  const expiresAt = data.expires_in
    ? new Date(Date.now() + Math.max(0, data.expires_in - 60) * 1000).toISOString()
    : store.accessTokenExpiresAt;

  await writeGoogleOAuthTokenStore({
    ...store,
    accessTokenRef: nextAccessRef,
    accessTokenExpiresAt: expiresAt,
    scope: data.scope || store.scope,
    tokenType: data.token_type || store.tokenType,
    updatedAt: new Date().toISOString(),
  });
  return nextAccess;
}

export async function readCalendarProviders(workspace: string): Promise<CalendarProviderAccount[]> {
  try {
    const raw = await readFile(providersPath(workspace), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProviderStore>;
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

export async function writeCalendarProviders(workspace: string, accounts: CalendarProviderAccount[]): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await writeFile(providersPath(workspace), JSON.stringify({ version: 1, accounts }, null, 2), "utf-8");
}

export async function upsertCalendarProvider(
  workspace: string,
  payload: Omit<CalendarProviderAccount, "id" | "createdAt" | "updatedAt" | "secretRef"> & {
    id?: string;
    secret?: string;
    secretRef?: string;
  }
): Promise<CalendarProviderAccount> {
  const now = new Date().toISOString();
  const accounts = await readCalendarProviders(workspace);
  const id = payload.id || randomUUID();
  const idx = accounts.findIndex((a) => a.id === id);

  let secretRef = payload.secretRef;
  const nextSecret = (payload.secret || "").trim();
  const isGoogleOAuth = payload.vendor === "google";
  if (!isGoogleOAuth) {
    if (!secretRef || nextSecret) {
      if (!nextSecret) throw new Error("Provider secret is required for new accounts");
      secretRef = await putCalendarProviderSecret(nextSecret);
    }
  } else {
    secretRef = secretRef || "";
  }

  const next: CalendarProviderAccount = {
    id,
    type: payload.type,
    vendor: payload.vendor || (payload.serverUrl.includes("googleusercontent.com") ? "google" : "icloud"),
    label: payload.label.trim(),
    serverUrl: payload.serverUrl.trim(),
    calendarUrl: payload.calendarUrl.trim(),
    calendarId: payload.calendarId?.trim() || undefined,
    username: payload.username.trim(),
    cutoffDate: payload.cutoffDate?.trim() || undefined,
    secretRef,
    enabled: payload.enabled,
    createdAt: idx >= 0 ? accounts[idx].createdAt : now,
    updatedAt: now,
    lastSyncAt: idx >= 0 ? accounts[idx].lastSyncAt : undefined,
    lastError: idx >= 0 ? accounts[idx].lastError : undefined,
  };

  if (idx >= 0) {
    if (accounts[idx].secretRef && accounts[idx].secretRef !== secretRef) {
      await deleteCalendarProviderSecret(accounts[idx].secretRef);
    }
    accounts[idx] = next;
  } else {
    accounts.push(next);
  }

  await writeCalendarProviders(workspace, accounts);
  return next;
}

export async function deleteCalendarProvider(workspace: string, id: string): Promise<boolean> {
  const accounts = await readCalendarProviders(workspace);
  const found = accounts.find((a) => a.id === id);
  if (!found) return false;
  if (found.secretRef) await deleteCalendarProviderSecret(found.secretRef);
  await writeCalendarProviders(workspace, accounts.filter((a) => a.id !== id));
  return true;
}

export async function markCalendarProviderStatus(
  workspace: string,
  id: string,
  patch: { lastSyncAt?: string; lastError?: string | null }
): Promise<void> {
  const accounts = await readCalendarProviders(workspace);
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const now = new Date().toISOString();
  const current = accounts[idx];
  accounts[idx] = {
    ...current,
    lastSyncAt: patch.lastSyncAt ?? current.lastSyncAt,
    lastError: patch.lastError === null ? undefined : patch.lastError ?? current.lastError,
    updatedAt: now,
  };
  await writeCalendarProviders(workspace, accounts);
}

export async function purgeProviderEvents(workspace: string, accountId: string): Promise<number> {
  const entries = await readCalendarEntries(workspace);
  const before = entries.length;
  const kept = entries.filter((entry) => entry.providerAccountId !== accountId);
  await writeCalendarEntries(workspace, kept);
  return before - kept.length;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function compactBody(value: string, max = 240): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function firstXmlTagValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match?.[1]?.trim() || null;
}

function formatCalDavHttpError(
  status: number,
  responseBody: string,
  ctx: { phase: string; vendor?: "icloud" | "google"; username?: string; calendarId?: string }
): Error {
  const snippet = compactBody(responseBody);
  const code = firstXmlTagValue(responseBody, "code");
  const reason = firstXmlTagValue(responseBody, "internalReason");

  if (ctx.vendor === "google" && status === 401) {
    const calendarTarget = (ctx.calendarId || ctx.username || "(not provided)").trim();
    return new Error(
      [
        `Google CalDAV login failed (401${code ? ` ${code}` : ""}).`,
        reason ? `Google says: ${reason}.` : "Google did not accept this OAuth access token.",
        "Reconnect Google OAuth from Providers and try again.",
        "If this is a Google Workspace account, make sure calendar scopes are allowed by admin policy.",
        `Calendar ID used: ${calendarTarget}.`,
      ].join(" ")
    );
  }

  if (ctx.vendor === "google" && status === 403) {
    if (code === "accessNotConfigured") {
      return new Error(
        [
          "Google CalDAV is disabled for your Google Cloud project (403 accessNotConfigured).",
          reason || "Enable the Calendar API/CalDAV service for the same project that owns this OAuth client.",
          "Open Google Cloud Console -> APIs & Services -> Library, enable Calendar API, then wait a few minutes and retry.",
        ].join(" ")
      );
    }
    return new Error(
      [
        `Google CalDAV access denied (403${code ? ` ${code}` : ""}).`,
        reason || "The OAuth token is valid but lacks permission for this calendar or API.",
        "Verify Calendar API is enabled and OAuth consent/scopes allow calendar.readonly.",
      ].join(" ")
    );
  }

  if (status === 401) {
    return new Error(
      `CalDAV authentication failed during ${ctx.phase} (401). Check username/password or app password settings.${snippet ? ` Response: ${snippet}` : ""}`
    );
  }

  if (status === 403) {
    return new Error(
      `CalDAV access was denied during ${ctx.phase} (403). The account can authenticate but lacks permission for this calendar URL.${snippet ? ` Response: ${snippet}` : ""}`
    );
  }

  return new Error(`CalDAV ${ctx.phase} failed (${status}).${snippet ? ` Response: ${snippet}` : ""}`);
}

function parseIcsField(block: string, key: string): string | null {
  const re = new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "im");
  const m = re.exec(block);
  return m?.[1]?.trim() || null;
}

function parseIcsDate(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const y = value.slice(0, 4);
    const mo = value.slice(4, 6);
    const d = value.slice(6, 8);
    const h = value.slice(9, 11);
    const mi = value.slice(11, 13);
    const s = value.slice(13, 15);
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }
  if (/^\d{8}T\d{6}$/.test(value)) {
    const y = value.slice(0, 4);
    const mo = value.slice(4, 6);
    const d = value.slice(6, 8);
    const h = value.slice(9, 11);
    const mi = value.slice(11, 13);
    const s = value.slice(13, 15);
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString();
  }
  if (/^\d{8}$/.test(value)) {
    const y = value.slice(0, 4);
    const mo = value.slice(4, 6);
    const d = value.slice(6, 8);
    return new Date(Number(y), Number(mo) - 1, Number(d), 9, 0, 0).toISOString();
  }
  return null;
}

type ParsedCalDavItem = {
  uid: string;
  kind: "event" | "reminder";
  title: string;
  notes?: string;
  dueAt: string;
  endAt?: string;
  status: "scheduled" | "done";
  component: "VEVENT" | "VTODO";
  itemUrl?: string;
  etag?: string;
  calendarUrl: string;
};

function parseCalendarData(xml: string, calendarUrl: string): ParsedCalDavItem[] {
  const out: ParsedCalDavItem[] = [];
  const responseMatches = xml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi);
  for (const responseMatch of responseMatches) {
    const responseXml = responseMatch[1] || "";
    const itemHref = firstTagValue(responseXml, ["href"]);
    const itemUrl = itemHref ? toAbsUrl(calendarUrl, itemHref) : undefined;
    const etag = firstTagValue(responseXml, ["getetag"]) || undefined;
    const calDataMatch = /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/i.exec(responseXml);
    if (!calDataMatch?.[1]) continue;
    const ics = decodeXmlEntities(calDataMatch[1]);

    const eventMatches = ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi);
    for (const event of eventMatches) {
      const block = event[1] || "";
      const status = (parseIcsField(block, "STATUS") || "").trim().toUpperCase();
      if (status === "CANCELLED") continue;
      const uid = parseIcsField(block, "UID");
      const title = parseIcsField(block, "SUMMARY") || "(untitled)";
      const notes = parseIcsField(block, "DESCRIPTION") || undefined;
      const dueAt = parseIcsDate(parseIcsField(block, "DTSTART"));
      const endAt = parseIcsDate(parseIcsField(block, "DTEND")) || undefined;
      if (!uid || !dueAt) continue;
      out.push({
        uid,
        kind: "event",
        title,
        notes,
        dueAt,
        endAt,
        status: "scheduled",
        component: "VEVENT",
        itemUrl,
        etag,
        calendarUrl,
      });
    }

    const todoMatches = ics.matchAll(/BEGIN:VTODO([\s\S]*?)END:VTODO/gi);
    for (const todo of todoMatches) {
      const block = todo[1] || "";
      const rawStatus = (parseIcsField(block, "STATUS") || "").trim().toUpperCase();
      if (rawStatus === "CANCELLED") continue;
      const uid = parseIcsField(block, "UID");
      const title = parseIcsField(block, "SUMMARY") || "(untitled)";
      const notes = parseIcsField(block, "DESCRIPTION") || undefined;
      const dueAt = parseIcsDate(parseIcsField(block, "DUE")) || parseIcsDate(parseIcsField(block, "DTSTART"));
      if (!uid || !dueAt) continue;
      const status: "scheduled" | "done" = rawStatus === "COMPLETED" ? "done" : "scheduled";
      out.push({
        uid,
        kind: "reminder",
        title,
        notes,
        dueAt,
        status,
        component: "VTODO",
        itemUrl,
        etag,
        calendarUrl,
      });
    }
  }

  return out;
}

function buildCalendarQueryBody(from: string, to: string): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${from}" end="${to}" />
      </c:comp-filter>
      <c:comp-filter name="VTODO">
        <c:time-range start="${from}" end="${to}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

function buildGoogleCalendarUrl(serverUrl: string, calendarId: string): string {
  const base = serverUrl.replace(/\/+$/, "");
  const id = encodeURIComponent(calendarId.trim());
  return `${base}/${id}/events`;
}

async function fetchCalDavEventsReport(
  account: CalendarProviderAccount,
  credential: string,
  calendarUrl: string
): Promise<string> {
  const authHeader = account.vendor === "google"
    ? `Bearer ${credential}`
    : `Basic ${Buffer.from(`${account.username}:${credential}`).toString("base64")}`;
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const to = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const body = buildCalendarQueryBody(from, to);

  const res = await fetch(calendarUrl, {
    method: "REPORT",
    headers: {
      Authorization: authHeader,
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 207) {
    throw formatCalDavHttpError(res.status, text, {
      phase: "sync report",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }
  return text;
}

function toAbsUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function firstTagValue(xml: string, tags: string[]): string | null {
  for (const tag of tags) {
    const re = new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*${tag}>`, "i");
    const m = re.exec(xml);
    if (m?.[1]?.trim()) return decodeXmlEntities(m[1].trim());
  }
  return null;
}

function nestedHref(xml: string, containerTag: string): string | null {
  const container = new RegExp(`<[^>]*${containerTag}[^>]*>([\\s\\S]*?)<\\/[^>]*${containerTag}>`, "i").exec(xml);
  if (!container?.[1]) return null;
  const href = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(container[1]);
  return href?.[1] ? decodeXmlEntities(href[1].trim()) : null;
}

async function discoverCalDavCalendarUrls(account: CalendarProviderAccount, password: string): Promise<string[]> {
  const auth = Buffer.from(`${account.username}:${password}`).toString("base64");
  const baseUrl = account.serverUrl || account.calendarUrl;
  if (!baseUrl) throw new Error("serverUrl is required for CalDAV discovery");

  const principalRes = await fetch(baseUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${auth}`,
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:current-user-principal/></d:prop></d:propfind>",
  });
  const principalXml = await principalRes.text();
  if (!principalRes.ok && principalRes.status !== 207) {
    throw formatCalDavHttpError(principalRes.status, principalXml, {
      phase: "principal discovery",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }

  const principalHref = nestedHref(principalXml, "current-user-principal") || firstTagValue(principalXml, ["href"]);
  if (!principalHref) throw new Error("Could not resolve current-user-principal href");
  const principalUrl = toAbsUrl(baseUrl, principalHref);

  const homeRes = await fetch(principalUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${auth}`,
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><c:calendar-home-set/></d:prop></d:propfind>",
  });
  const homeXml = await homeRes.text();
  if (!homeRes.ok && homeRes.status !== 207) {
    throw formatCalDavHttpError(homeRes.status, homeXml, {
      phase: "calendar-home discovery",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }

  const homeHref = nestedHref(homeXml, "calendar-home-set") || firstTagValue(homeXml, ["href"]);
  if (!homeHref) throw new Error("Could not resolve calendar-home-set href");
  const homeUrl = toAbsUrl(baseUrl, homeHref);

  const calendarsReq = {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${auth}`,
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>",
  } as const;

  let calendarsRes = await fetch(homeUrl, calendarsReq);
  let calendarsXml = await calendarsRes.text();
  if (calendarsRes.status === 400 && !homeUrl.endsWith("/")) {
    calendarsRes = await fetch(`${homeUrl}/`, calendarsReq);
    calendarsXml = await calendarsRes.text();
  }
  if (!calendarsRes.ok && calendarsRes.status !== 207) {
    throw formatCalDavHttpError(calendarsRes.status, calendarsXml, {
      phase: "calendar collection listing",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }

  const tryReport = async (url: string): Promise<boolean> => {
    try {
      await fetchCalDavEventsReport(account, password, url);
      return true;
    } catch {
      return false;
    }
  };

  const responses = [...calendarsXml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi)].map((m) => m[1] || "");
  const normalizedHome = homeUrl.replace(/\/+$/, "");
  const calendarCandidates: string[] = [];
  const fallbackCandidates: string[] = [];
  for (const response of responses) {
    const href = firstTagValue(response, ["href"]);
    if (!href) continue;
    const abs = toAbsUrl(homeUrl, href);
    if (abs.replace(/\/+$/, "") === normalizedHome) continue;
    if (/^https?:\/\//i.test(abs)) {
      fallbackCandidates.push(abs);
      const hasCalendarResource = /<[^>]*resourcetype[^>]*>[\s\S]*?<[^>]*calendar(?:\s*\/\s*>|>)/i.test(response)
        && !/calendar-home-set/i.test(response);
      if (hasCalendarResource) {
        calendarCandidates.push(abs);
      }
    }
  }

  const tried = new Set<string>();
  const okCandidates: string[] = [];
  for (const candidate of [...calendarCandidates, ...fallbackCandidates]) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    if (await tryReport(candidate)) okCandidates.push(candidate);
  }

  if (okCandidates.length === 0) {
    throw new Error("Could not discover a calendar collection URL");
  }
  return okCandidates;
}

async function resolveCalDavCalendarUrls(account: CalendarProviderAccount, password: string): Promise<string[]> {
  if (account.vendor === "google") {
    const calendarId = (account.calendarId || account.username || "").trim();
    if (!calendarId) throw new Error("Google calendar ID (or username) is required");
    const base = account.serverUrl || "https://apidata.googleusercontent.com/caldav/v2";
    return [buildGoogleCalendarUrl(base, calendarId)];
  }
  const given = (account.calendarUrl || "").trim();
  const isRootHost = /^https?:\/\/[^/]+\/?$/i.test(given);
  const isCalendarHome = /\/calendars\/?$/i.test(given);
  if (!given || isRootHost || isCalendarHome) {
    return discoverCalDavCalendarUrls(account, password);
  }
  return [given];
}

export async function testCalDavConnection(
  account: Pick<CalendarProviderAccount, "calendarUrl" | "username" | "vendor" | "calendarId">,
  credential: string
): Promise<void> {
  const authHeader = account.vendor === "google"
    ? `Bearer ${credential}`
    : `Basic ${Buffer.from(`${account.username}:${credential}`).toString("base64")}`;
  const res = await fetch(account.calendarUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader,
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/></d:prop></d:propfind>",
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.text().catch(() => "");
    throw formatCalDavHttpError(res.status, body, {
      phase: "connection test",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }
}

export async function testOrDiscoverCalDavConnection(
  account: Pick<CalendarProviderAccount, "serverUrl" | "calendarUrl" | "username">
  & { serverUrl: string; vendor?: "icloud" | "google"; calendarId?: string },
  password: string
): Promise<{ calendarUrl: string }> {
  const normalized: CalendarProviderAccount = {
    id: "tmp",
    type: "caldav",
    vendor: account.vendor,
    label: "tmp",
    serverUrl: account.serverUrl,
    calendarUrl: account.calendarUrl,
    calendarId: account.calendarId,
    username: account.username,
    secretRef: "",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const calendarUrls = await resolveCalDavCalendarUrls(normalized, password);
  const calendarUrl = calendarUrls[0];
  await testCalDavConnection({
    calendarUrl,
    username: account.username,
    vendor: account.vendor,
    calendarId: account.calendarId,
  }, password);
  return { calendarUrl };
}

async function getProviderCredential(account: CalendarProviderAccount): Promise<string> {
  if (account.vendor === "google") {
    return getGoogleOAuthAccessToken();
  }
  const secret = await readCalendarProviderSecret(account.secretRef);
  if (!secret) throw new Error("Provider credentials are missing");
  return secret;
}

function buildCalDavAuthHeader(account: CalendarProviderAccount, credential: string): string {
  return account.vendor === "google"
    ? `Bearer ${credential}`
    : `Basic ${Buffer.from(`${account.username}:${credential}`).toString("base64")}`;
}

function toIcsDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date for provider write");
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${da}T${hh}${mm}${ss}Z`;
}

function escapeIcsText(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function ensureCalUrlSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildProviderItemIcs(payload: {
  uid: string;
  kind: "event" | "reminder";
  title: string;
  notes?: string;
  dueAt: string;
  endAt?: string;
  status?: "scheduled" | "done";
}): string {
  const now = toIcsDateTime(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenClaw//Mission Control//EN",
  ];

  if (payload.kind === "event") {
    const dtStart = toIcsDateTime(payload.dueAt);
    const dtEnd = payload.endAt
      ? toIcsDateTime(payload.endAt)
      : toIcsDateTime(new Date(new Date(payload.dueAt).getTime() + 60 * 60 * 1000).toISOString());
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(payload.uid)}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${dtStart}`);
    lines.push(`DTEND:${dtEnd}`);
    lines.push(`SUMMARY:${escapeIcsText(payload.title)}`);
    if (payload.notes) lines.push(`DESCRIPTION:${escapeIcsText(payload.notes)}`);
    lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  } else {
    const due = toIcsDateTime(payload.dueAt);
    const dtStart = toIcsDateTime(payload.dueAt);
    lines.push("BEGIN:VTODO");
    lines.push(`UID:${escapeIcsText(payload.uid)}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${dtStart}`);
    lines.push(`DUE:${due}`);
    lines.push(`SUMMARY:${escapeIcsText(payload.title)}`);
    if (payload.notes) lines.push(`DESCRIPTION:${escapeIcsText(payload.notes)}`);
    if (payload.status === "done") {
      lines.push("STATUS:COMPLETED");
      lines.push(`COMPLETED:${now}`);
    } else {
      lines.push("STATUS:NEEDS-ACTION");
    }
    lines.push("END:VTODO");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export async function createCalDavProviderItem(
  account: CalendarProviderAccount,
  payload: {
    kind: "event" | "reminder";
    title: string;
    notes?: string;
    dueAt: string;
    endAt?: string;
  }
): Promise<{ externalId: string; itemUrl: string; etag?: string; component: "VEVENT" | "VTODO"; calendarUrl: string }> {
  const credential = await getProviderCredential(account);
  const authHeader = buildCalDavAuthHeader(account, credential);
  if (!account.calendarUrl) throw new Error("Provider calendar URL is missing. Re-test and save provider first.");
  const calendarUrl = ensureCalUrlSlash(account.calendarUrl);

  const uid = randomUUID();
  const itemUrl = toAbsUrl(calendarUrl, `${encodeURIComponent(uid)}.ics`);
  const body = buildProviderItemIcs({ ...payload, uid, status: "scheduled" });
  const res = await fetch(itemUrl, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    },
    body,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw formatCalDavHttpError(res.status, text, {
      phase: "remote create",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }

  return {
    externalId: uid,
    itemUrl,
    etag: res.headers.get("etag") || undefined,
    component: payload.kind === "event" ? "VEVENT" : "VTODO",
    calendarUrl,
  };
}

export async function updateCalDavProviderItem(
  account: CalendarProviderAccount,
  current: CalendarEntry,
  payload: {
    kind: "event" | "reminder";
    title: string;
    notes?: string;
    dueAt: string;
    endAt?: string;
    status?: "scheduled" | "done";
  }
): Promise<{ etag?: string; itemUrl: string; component: "VEVENT" | "VTODO" }> {
  const credential = await getProviderCredential(account);
  const authHeader = buildCalDavAuthHeader(account, credential);
  const uid = current.externalId || randomUUID();
  const fallbackBase = account.calendarUrl ? ensureCalUrlSlash(account.calendarUrl) : "";
  const itemUrl = current.providerItemUrl || (fallbackBase ? toAbsUrl(fallbackBase, `${encodeURIComponent(uid)}.ics`) : "");
  if (!itemUrl) throw new Error("Provider item URL is missing. Sync the provider and retry.");

  const body = buildProviderItemIcs({
    uid,
    kind: payload.kind,
    title: payload.title,
    notes: payload.notes,
    dueAt: payload.dueAt,
    endAt: payload.endAt,
    status: payload.status,
  });
  const headers: Record<string, string> = {
    Authorization: authHeader,
    "Content-Type": "text/calendar; charset=utf-8",
  };
  if (current.providerEtag) headers["If-Match"] = current.providerEtag;
  const res = await fetch(itemUrl, { method: "PUT", headers, body });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw formatCalDavHttpError(res.status, text, {
      phase: "remote update",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }
  return {
    etag: res.headers.get("etag") || undefined,
    itemUrl,
    component: payload.kind === "event" ? "VEVENT" : "VTODO",
  };
}

export async function deleteCalDavProviderItem(account: CalendarProviderAccount, entry: CalendarEntry): Promise<void> {
  const itemUrl = entry.providerItemUrl;
  if (!itemUrl) throw new Error("Provider item URL is missing. Sync the provider and retry.");
  const credential = await getProviderCredential(account);
  const authHeader = buildCalDavAuthHeader(account, credential);
  const headers: Record<string, string> = { Authorization: authHeader };
  if (entry.providerEtag) headers["If-Match"] = entry.providerEtag;
  const res = await fetch(itemUrl, { method: "DELETE", headers });
  const text = await res.text().catch(() => "");
  if (!res.ok && res.status !== 404) {
    throw formatCalDavHttpError(res.status, text, {
      phase: "remote delete",
      vendor: account.vendor,
      username: account.username,
      calendarId: account.calendarId,
    });
  }
}

export async function syncCalDavProvider(workspace: string, account: CalendarProviderAccount): Promise<number> {
  const credential = await getProviderCredential(account);

  const calendarUrls = await resolveCalDavCalendarUrls(account, credential);
  const remoteEvents = new Map<string, ParsedCalDavItem>();
  for (const url of calendarUrls) {
    try {
      const evXml = await fetchCalDavEventsReport(account, credential, url);
      for (const event of parseCalendarData(evXml, url)) remoteEvents.set(event.uid, event);
    } catch {
      // ignore collection-specific errors
    }
  }
  const entries = await readCalendarEntries(workspace);
  const kept: CalendarEntry[] = entries.filter((entry) => entry.providerAccountId !== account.id);

  const nowIso = new Date().toISOString();
  const imported: CalendarEntry[] = Array.from(remoteEvents.values())
    .filter((event) => {
      if (!account.cutoffDate) return true;
      const cutoff = new Date(account.cutoffDate).getTime();
      if (Number.isNaN(cutoff)) return true;
      return new Date(event.dueAt).getTime() >= cutoff;
    })
    .map((event) => ({
    id: `provider:${account.id}:${event.uid}`,
    kind: event.kind,
    title: event.title,
    notes: event.notes,
    dueAt: event.dueAt,
    endAt: event.endAt,
    status: event.status,
    createdAt: nowIso,
    updatedAt: nowIso,
    source: "provider",
    provider: account.type,
    providerAccountId: account.id,
    externalId: event.uid,
    providerItemUrl: event.itemUrl,
    providerEtag: event.etag,
    providerComponent: event.component,
    providerCalendarUrl: event.calendarUrl,
    readOnly: false,
    lastSyncedAt: nowIso,
  }));

  const mergedById = new Map<string, CalendarEntry>();
  for (const entry of kept) mergedById.set(entry.id, entry);
  for (const entry of imported) {
    const existing = mergedById.get(entry.id);
    mergedById.set(entry.id, {
      ...(existing || entry),
      ...entry,
      createdAt: existing?.createdAt || entry.createdAt,
    });
  }
  await writeCalendarEntries(workspace, Array.from(mergedById.values()));

  const accounts = await readCalendarProviders(workspace);
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], lastSyncAt: nowIso, lastError: undefined, updatedAt: nowIso };
    await writeCalendarProviders(workspace, accounts);
  }

  return imported.length;
}
