import { fetchCalendarEvents, getAccessToken, getStoredTokens, isOAuthConfigured } from "@/lib/google-calendar";
import { fetchCalendarEventsViaGog, isGogAvailable } from "@/lib/gog-calendar";
import {
  CALENDAR_PROVIDERS,
  type CalendarAccountConnection,
  type CalendarAccountRecord,
  type CalendarProvider,
  type CalendarStoreFile,
  getCalendarProviderLabel,
  isExternalCalendarProvider,
  listCalendarEvents,
  readCalendarStore,
  replaceImportedEventsForAccount,
  saveCalendarStore,
  summarizeCalendarStore,
} from "@/lib/calendar-store";

export type CalendarConnectorStatus = {
  provider: CalendarProvider;
  label: string;
  connectorImplemented: boolean;
  multiAccount: boolean;
  supportedConnections: CalendarAccountConnection[];
  note: string;
  detection: {
    gogAvailable?: boolean;
    oauthConfigured?: boolean;
    storedAuth?: boolean;
  };
};

export type CalendarSnapshot = {
  store: CalendarStoreFile;
  summary: ReturnType<typeof summarizeCalendarStore>;
  upcomingEvents: ReturnType<typeof listCalendarEvents>;
  connectors: CalendarConnectorStatus[];
};

export type CalendarSyncResult = {
  accountId: string;
  provider: CalendarProvider;
  importedCount: number;
  syncedAt: number;
};

function buildGoogleConnectorStatus(params: {
  gogAvailable: boolean;
  oauthConfigured: boolean;
  storedAuth: boolean;
}): CalendarConnectorStatus {
  return {
    provider: "google",
    label: "Google",
    connectorImplemented: true,
    multiAccount: true,
    supportedConnections: ["gog", "oauth"],
    note:
      "Google import is live. Use gog for explicit multi-account sync or an OAuth account id such as primary.",
    detection: params,
  };
}

function buildPlannedConnectorStatus(provider: Exclude<CalendarProvider, "google" | "local">): CalendarConnectorStatus {
  return {
    provider,
    label: getCalendarProviderLabel(provider),
    connectorImplemented: false,
    multiAccount: true,
    supportedConnections: provider === "apple" ? ["caldav", "manual"] : ["api", "oauth", "manual"],
    note: `${getCalendarProviderLabel(provider)} sync metadata is ready, but the connector is not wired yet.`,
    detection: {},
  };
}

function buildLocalConnectorStatus(): CalendarConnectorStatus {
  return {
    provider: "local",
    label: "Mission Control",
    connectorImplemented: true,
    multiAccount: false,
    supportedConnections: ["manual"],
    note: "This is the canonical local calendar store that imported events sync into.",
    detection: {},
  };
}

export async function getCalendarConnectorStatuses(): Promise<CalendarConnectorStatus[]> {
  const [gogAvailable, oauthConfigured, storedTokens] = await Promise.all([
    isGogAvailable().catch(() => false),
    Promise.resolve(isOAuthConfigured()),
    getStoredTokens().catch(() => null),
  ]);

  return CALENDAR_PROVIDERS.map((provider) => {
    if (provider === "local") return buildLocalConnectorStatus();
    if (provider === "google") {
      return buildGoogleConnectorStatus({
        gogAvailable,
        oauthConfigured,
        storedAuth: Boolean(storedTokens?.refresh_token),
      });
    }
    return buildPlannedConnectorStatus(provider);
  });
}

async function fetchImportedEventsForAccount(
  account: CalendarAccountRecord,
  days: number
) {
  if (!isExternalCalendarProvider(account.provider)) {
    throw new Error(`Unsupported provider: ${account.provider}`);
  }

  switch (account.provider) {
    case "google": {
      if (account.connection === "oauth") {
        const token = await getAccessToken();
        if (!token) {
          throw new Error(
            "Google OAuth access is unavailable. Connect OAuth first and ensure the client id/secret are configured."
          );
        }
        return fetchCalendarEvents(token, days).then((events) =>
          events.map((event) => ({
            externalId: event.id,
            title: event.title,
            startMs: event.startMs,
            endMs: event.endMs,
            allDay: event.allDay,
            calendarName: event.calendarName,
            location: event.location,
            notes: event.notes,
          }))
        );
      }

      if (account.connection === "gog" || account.connection === "manual") {
        const result = await fetchCalendarEventsViaGog(days, account.providerAccountId);
        return result.events.map((event) => ({
          externalId: event.id,
          title: event.title,
          startMs: event.startMs,
          endMs: event.endMs,
          allDay: event.allDay,
          calendarName: event.calendarName,
          location: event.location,
          notes: event.notes,
        }));
      }

      throw new Error(
        "Google sync currently supports gog or oauth accounts."
      );
    }
    case "apple":
    case "zoho":
      throw new Error(
        `${getCalendarProviderLabel(account.provider)} sync is not implemented yet. The account is stored so the local model is ready when the connector lands.`
      );
    default:
      throw new Error(`Unsupported provider: ${account.provider satisfies never}`);
  }
}

export async function syncCalendarAccount(
  accountId: string,
  days = 14
): Promise<CalendarSyncResult> {
  const initialStore = await readCalendarStore();
  const account = initialStore.accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`Calendar account not found: ${accountId}`);

  const providerSettings = initialStore.providerSettings[account.provider];
  if (!providerSettings.enabled) {
    throw new Error(`${getCalendarProviderLabel(account.provider)} imports are disabled.`);
  }
  if (!account.enabled || !account.importEvents) {
    throw new Error(`Calendar account ${account.label} is disabled for event import.`);
  }

  try {
    const importedEvents = await fetchImportedEventsForAccount(account, Math.max(1, Math.min(days, 60)));
    const syncedAt = Date.now();
    const latestStore = await readCalendarStore();
    const latestAccount = latestStore.accounts.find((candidate) => candidate.id === accountId);
    if (!latestAccount) {
      throw new Error(`Calendar account was removed during sync: ${accountId}`);
    }

    const latestProviderSettings = latestStore.providerSettings[latestAccount.provider];
    if (!latestProviderSettings.enabled) {
      throw new Error(`${getCalendarProviderLabel(latestAccount.provider)} imports were disabled during sync.`);
    }
    if (!latestAccount.enabled || !latestAccount.importEvents) {
      throw new Error(`Calendar account ${latestAccount.label} was disabled during sync.`);
    }

    const nextStore = replaceImportedEventsForAccount(latestStore, {
      provider: latestAccount.provider,
      accountId,
      importedEvents,
      syncedAt,
    });
    const accountIndex = nextStore.accounts.findIndex((candidate) => candidate.id === accountId);
    if (accountIndex >= 0) {
      nextStore.accounts[accountIndex] = {
        ...nextStore.accounts[accountIndex],
        lastSyncedAt: syncedAt,
        lastSyncStatus: "success",
        lastSyncError: null,
        updatedAt: syncedAt,
      };
    }
    await saveCalendarStore(nextStore);
    return {
      accountId,
      provider: account.provider,
      importedCount: importedEvents.length,
      syncedAt,
    };
  } catch (error) {
    const failedStore = await readCalendarStore();
    const accountIndex = failedStore.accounts.findIndex((candidate) => candidate.id === accountId);
    if (accountIndex >= 0) {
      failedStore.accounts[accountIndex] = {
        ...failedStore.accounts[accountIndex],
        lastSyncStatus: "error",
        lastSyncError: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      };
      await saveCalendarStore(failedStore);
    }
    throw error;
  }
}

export async function buildCalendarSnapshot(days = 14): Promise<CalendarSnapshot> {
  const [store, connectors] = await Promise.all([
    readCalendarStore(),
    getCalendarConnectorStatuses(),
  ]);
  return {
    store,
    summary: summarizeCalendarStore(store),
    upcomingEvents: listCalendarEvents(store, {
      startMs: Date.now() - 24 * 60 * 60 * 1000,
      endMs: Date.now() + days * 24 * 60 * 60 * 1000,
      limit: 250,
    }),
    connectors,
  };
}
