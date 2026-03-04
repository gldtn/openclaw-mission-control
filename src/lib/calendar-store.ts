import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { getDefaultWorkspace } from "@/lib/paths";

export type CalendarEntryKind = "reminder" | "event";
export type CalendarEntryStatus = "scheduled" | "sent" | "done" | "cancelled" | "failed";

export type CalendarEntry = {
  id: string;
  kind: CalendarEntryKind;
  title: string;
  notes?: string;
  dueAt: string;
  endAt?: string;
  status: CalendarEntryStatus;
  createdAt: string;
  updatedAt: string;
  source: "manual" | "channel" | "agent" | "provider";
  channel?: string;
  agentId?: string;
  provider?: "caldav";
  providerAccountId?: string;
  externalId?: string;
  providerItemUrl?: string;
  providerEtag?: string;
  providerComponent?: "VEVENT" | "VTODO";
  providerCalendarUrl?: string;
  readOnly?: boolean;
  lastSyncedAt?: string;
  deliveredAt?: string;
  lastError?: string;
  previousStatus?: CalendarEntryStatus;
};

type CalendarStore = {
  version: 1;
  entries: CalendarEntry[];
};

type KanbanTaskLike = {
  id?: number | string;
  title?: string;
  description?: string;
  dueAt?: string;
  dueDate?: string;
  due?: string;
  column?: string;
  priority?: string;
};

export type CalendarTaskDue = {
  id: string;
  kind: "task";
  title: string;
  notes?: string;
  dueAt: string;
  status: "open" | "done";
  priority?: string;
};

export function asIso(input: string): string | null {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toDateOnlyStartIso(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return null;
  return new Date(y, mo - 1, da, 9, 0, 0, 0).toISOString();
}

export function resolveDueAt(input: string): string | null {
  return asIso(input) || toDateOnlyStartIso(input);
}

function calendarPath(workspace: string): string {
  return join(workspace, "calendar-events.json");
}

export async function readCalendarEntries(workspace: string): Promise<CalendarEntry[]> {
  try {
    const raw = await readFile(calendarPath(workspace), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CalendarStore>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return entries
      .filter((e): e is CalendarEntry => Boolean(e && typeof e === "object" && typeof (e as CalendarEntry).id === "string"))
      .filter((e) => typeof e.dueAt === "string" && Boolean(resolveDueAt(e.dueAt)));
  } catch {
    return [];
  }
}

export async function writeCalendarEntries(workspace: string, entries: CalendarEntry[]): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const payload: CalendarStore = { version: 1, entries };
  await writeFile(calendarPath(workspace), JSON.stringify(payload, null, 2), "utf-8");
}

export async function upsertCalendarEntry(
  workspace: string,
  payload: Omit<CalendarEntry, "id" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<CalendarEntry> {
  const entries = await readCalendarEntries(workspace);
  const now = new Date().toISOString();
  const dueAt = resolveDueAt(payload.dueAt);
  if (!dueAt) throw new Error("Invalid dueAt");
  const endAt = payload.endAt ? resolveDueAt(payload.endAt) : null;

  const next: CalendarEntry = {
    id: payload.id || randomUUID(),
    kind: payload.kind,
    title: payload.title.trim(),
    notes: payload.notes?.trim() || undefined,
    dueAt,
    endAt: endAt || undefined,
    status: payload.status,
    source: payload.source,
    channel: payload.channel,
    agentId: payload.agentId,
    provider: payload.provider,
    providerAccountId: payload.providerAccountId,
    externalId: payload.externalId,
    readOnly: payload.readOnly,
    lastSyncedAt: payload.lastSyncedAt,
    deliveredAt: payload.deliveredAt,
    lastError: payload.lastError,
    createdAt: now,
    updatedAt: now,
  };

  const existingIdx = entries.findIndex((e) => e.id === next.id);
  if (existingIdx >= 0) {
    const existing = entries[existingIdx];
    entries[existingIdx] = {
      ...existing,
      ...next,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  } else {
    entries.push(next);
  }

  await writeCalendarEntries(workspace, entries);
  return existingIdx >= 0 ? entries[existingIdx] : next;
}

export async function patchCalendarEntry(
  workspace: string,
  id: string,
  patch: Partial<Pick<CalendarEntry, "kind" | "title" | "notes" | "dueAt" | "endAt" | "status" | "lastError" | "deliveredAt" | "providerEtag">> & {
    previousStatus?: CalendarEntryStatus | null;
  }
): Promise<CalendarEntry | null> {
  const entries = await readCalendarEntries(workspace);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const current = entries[idx];
  const now = new Date().toISOString();
  const nextDueAt = patch.dueAt != null ? resolveDueAt(patch.dueAt) : current.dueAt;
  if (!nextDueAt) throw new Error("Invalid dueAt");
  const next: CalendarEntry = { ...current, dueAt: nextDueAt, updatedAt: now };
  if (patch.endAt !== undefined) {
    if (!patch.endAt) {
      delete next.endAt;
    } else {
      const resolvedEndAt = resolveDueAt(patch.endAt);
      if (!resolvedEndAt) throw new Error("Invalid endAt");
      next.endAt = resolvedEndAt;
    }
  }

  if (patch.kind === "reminder" || patch.kind === "event") {
    next.kind = patch.kind;
  }

  if (typeof patch.title === "string") {
    const trimmed = patch.title.trim();
    if (trimmed) next.title = trimmed;
  }
  if (typeof patch.notes === "string") {
    next.notes = patch.notes.trim() || undefined;
  }
  if (typeof patch.status === "string") {
    next.status = patch.status as CalendarEntryStatus;
  }
  if (typeof patch.lastError === "string") {
    next.lastError = patch.lastError;
  }
  if (typeof patch.deliveredAt === "string") {
    next.deliveredAt = patch.deliveredAt;
  }
  if (typeof patch.providerEtag === "string") {
    next.providerEtag = patch.providerEtag;
  }
  if (patch.previousStatus === null) {
    delete next.previousStatus;
  } else if (typeof patch.previousStatus === "string") {
    next.previousStatus = patch.previousStatus;
  }

  entries[idx] = next;
  await writeCalendarEntries(workspace, entries);
  return next;
}

export async function deleteCalendarEntry(workspace: string, id: string): Promise<boolean> {
  const entries = await readCalendarEntries(workspace);
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  await writeCalendarEntries(workspace, next);
  return true;
}

export async function readTaskDueDates(workspace: string): Promise<CalendarTaskDue[]> {
  const path = join(workspace, "kanban.json");
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as { tasks?: KanbanTaskLike[] };
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const out: CalendarTaskDue[] = [];
    for (const task of tasks) {
      const dueRaw =
        typeof task.dueAt === "string" && task.dueAt.trim()
          ? task.dueAt
          : typeof task.dueDate === "string" && task.dueDate.trim()
            ? task.dueDate
            : typeof task.due === "string" && task.due.trim()
              ? task.due
              : "";
      if (!dueRaw) continue;
      const dueAt = resolveDueAt(dueRaw);
      if (!dueAt) continue;
      const id = String(task.id ?? randomUUID());
      out.push({
        id: `task:${id}`,
        kind: "task",
        title: String(task.title || `Task ${id}`),
        notes: typeof task.description === "string" ? task.description : undefined,
        dueAt,
        status: String(task.column || "").toLowerCase() === "done" ? "done" : "open",
        priority: typeof task.priority === "string" ? task.priority : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseChannelReminder(text: string): {
  kind: CalendarEntryKind;
  title: string;
  dueAt: string;
} | null {
  const clean = String(text || "").trim();
  if (!clean) return null;

  const iso = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/i.exec(clean);
  if (!iso) return null;
  const date = iso[1];
  const time = iso[2] || "09:00";
  const dueAt = resolveDueAt(`${date} ${time}`);
  if (!dueAt) return null;

  const lower = clean.toLowerCase();
  const kind: CalendarEntryKind = lower.includes("appointment") || lower.includes("meeting")
    ? "event"
    : "reminder";

  const withoutLead = clean
    .replace(/^\s*(remind me to|set (a )?reminder to|add reminder to)\s*/i, "")
    .replace(/\s*(on|at)\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?.*$/i, "")
    .trim();

  const title = withoutLead || clean;
  return { kind, title, dueAt };
}

export function runReminderDispatch(entries: CalendarEntry[], nowIso = new Date().toISOString()): {
  updated: CalendarEntry[];
  dispatched: CalendarEntry[];
} {
  const now = new Date(nowIso).getTime();
  const dispatched: CalendarEntry[] = [];
  const updated = entries.map((entry) => {
    if (entry.kind !== "reminder") return entry;
    if (entry.status !== "scheduled") return entry;
    const due = new Date(entry.dueAt).getTime();
    if (Number.isNaN(due) || due > now) return entry;
    const next: CalendarEntry = {
      ...entry,
      status: "sent",
      deliveredAt: nowIso,
      updatedAt: nowIso,
    };
    dispatched.push(next);
    return next;
  });
  return { updated, dispatched };
}

export const CALENDAR_PROVIDERS = ["local", "google", "apple", "zoho"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export type CalendarAccountConnection = "gog" | "oauth" | "caldav" | "api" | "manual";

export type CalendarProviderSettings = {
  enabled: boolean;
};

export type CalendarAccountRecord = {
  id: string;
  provider: CalendarProvider;
  label: string;
  connection: CalendarAccountConnection;
  providerAccountId?: string;
  enabled: boolean;
  importEvents: boolean;
  lastSyncedAt?: number;
  lastSyncStatus?: "success" | "error";
  lastSyncError?: string | null;
  updatedAt: number;
};

export type CalendarStoreFile = {
  version: 1;
  entries: CalendarEntry[];
  accounts: CalendarAccountRecord[];
  providerSettings: Record<CalendarProvider, CalendarProviderSettings>;
};

export function isExternalCalendarProvider(value: string): value is Exclude<CalendarProvider, "local"> {
  return value === "google" || value === "apple" || value === "zoho";
}

export function getCalendarProviderLabel(provider: CalendarProvider): string {
  if (provider === "google") return "Google";
  if (provider === "apple") return "Apple";
  if (provider === "zoho") return "Zoho";
  return "Mission Control";
}

function defaultProviderSettings(): Record<CalendarProvider, CalendarProviderSettings> {
  return {
    local: { enabled: true },
    google: { enabled: true },
    apple: { enabled: true },
    zoho: { enabled: true },
  };
}

export async function readCalendarStore(): Promise<CalendarStoreFile> {
  const workspace = await getDefaultWorkspace();
  const entries = await readCalendarEntries(workspace);
  return {
    version: 1,
    entries,
    accounts: [],
    providerSettings: defaultProviderSettings(),
  };
}

export async function saveCalendarStore(store: CalendarStoreFile): Promise<void> {
  const workspace = await getDefaultWorkspace();
  await writeCalendarEntries(workspace, store.entries);
}

export function summarizeCalendarStore(store: CalendarStoreFile) {
  const now = Date.now();
  const upcomingCount = store.entries.filter((entry) => new Date(entry.dueAt).getTime() >= now).length;
  return {
    totalEntries: store.entries.length,
    upcomingCount,
    accountCount: store.accounts.length,
  };
}

export function listCalendarEvents(
  store: CalendarStoreFile,
  options?: number | { startMs?: number; endMs?: number; limit?: number }
): CalendarEntry[] {
  const startMs = typeof options === "object" && options?.startMs != null ? options.startMs : Number.NEGATIVE_INFINITY;
  const endMs = typeof options === "object" && options?.endMs != null ? options.endMs : Number.POSITIVE_INFINITY;
  const limit = typeof options === "number"
    ? options
    : (typeof options === "object" && options?.limit != null ? options.limit : 50);

  return [...store.entries]
    .filter((entry) => {
      const due = new Date(entry.dueAt).getTime();
      return Number.isFinite(due) && due >= startMs && due <= endMs;
    })
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .slice(0, Math.max(1, limit));
}

type ImportedEventInput = {
  externalId: string;
  title: string;
  startMs: number;
  endMs?: number | null;
  notes?: string;
};

export function replaceImportedEventsForAccount(
  store: CalendarStoreFile,
  params: {
    provider: CalendarProvider;
    accountId: string;
    importedEvents: ImportedEventInput[];
    syncedAt: number;
  }
): CalendarStoreFile {
  const kept = store.entries.filter(
    (entry) => !(entry.source === "provider" && entry.providerAccountId === params.accountId)
  );

  const syncedIso = new Date(params.syncedAt).toISOString();
  const importedEntries: CalendarEntry[] = params.importedEvents.map((event) => ({
    id: randomUUID(),
    kind: "event",
    title: String(event.title || "Imported event"),
    notes: event.notes,
    dueAt: new Date(event.startMs).toISOString(),
    endAt: event.endMs ? new Date(event.endMs).toISOString() : undefined,
    status: "scheduled",
    createdAt: syncedIso,
    updatedAt: syncedIso,
    source: "provider",
    provider: "caldav",
    providerAccountId: params.accountId,
    externalId: event.externalId,
    readOnly: true,
    lastSyncedAt: syncedIso,
  }));

  return {
    ...store,
    entries: [...kept, ...importedEntries],
  };
}
