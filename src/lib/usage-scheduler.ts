import { mkdir, rm, stat } from "fs/promises";
import { dirname, join } from "path";
import { getGatewayToken, getOpenClawHome } from "@/lib/paths";
import { gatewayCall } from "@/lib/openclaw";
import { usageDbGetMeta, usageDbSetMeta } from "@/lib/usage-db";

type CronJob = {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; everyMs?: number };
  payload?: { kind?: string; text?: string };
  delivery?: { mode?: string; to?: string };
};

type CronList = { jobs?: CronJob[] };

type SchedulerJob = {
  name: string;
  everyMs: number;
  task: string;
};

const ENSURE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ENSURE_LOCK_TTL_MS = 2 * 60 * 1000;
const ENSURE_LOCK_PATH = join(getOpenClawHome(), "mission-control", "locks", "usage-scheduler.ensure.lock");

const JOBS: SchedulerJob[] = [
  { name: "mc-usage-ingest", everyMs: 60_000, task: "ingest" },
  { name: "mc-billing-openrouter", everyMs: 15 * 60_000, task: "collect-provider&provider=openrouter" },
  { name: "mc-billing-openai", everyMs: 5 * 60_000, task: "collect-provider&provider=openai" },
  { name: "mc-billing-anthropic", everyMs: 2 * 60_000, task: "collect-provider&provider=anthropic" },
  { name: "mc-reconcile-usage", everyMs: 5 * 60_000, task: "reconcile" },
  { name: "mc-alert-evaluator", everyMs: 60_000, task: "alerts" },
];

function buildWebhookUrl(origin: string, task: string): string | null {
  const gatewayToken = getGatewayToken();
  if (!origin || !gatewayToken) return null;
  const url = new URL("/api/usage/internal", origin);
  url.searchParams.set("task", task.split("&")[0]);
  for (const chunk of task.split("&").slice(1)) {
    const [key, value] = chunk.split("=");
    if (key) url.searchParams.set(key, value || "");
  }
  url.searchParams.set("token", gatewayToken);
  return url.toString();
}

function needsUpdate(job: CronJob | undefined, expectedEveryMs: number, webhookUrl: string): boolean {
  if (!job) return true;
  return (
    job.enabled !== true ||
    job.schedule?.kind !== "every" ||
    Number(job.schedule?.everyMs || 0) !== expectedEveryMs ||
    job.delivery?.mode !== "webhook" ||
    String(job.delivery?.to || "") !== webhookUrl ||
    job.payload?.kind !== "systemEvent"
  );
}

function chooseCanonicalJob(jobs: CronJob[], expectedEveryMs: number, webhookUrl: string): CronJob | undefined {
  return (
    jobs.find((job) => !needsUpdate(job, expectedEveryMs, webhookUrl)) ||
    jobs.find((job) => job.enabled === true) ||
    jobs[0]
  );
}

async function tryAcquireEnsureLock(): Promise<boolean> {
  await mkdir(dirname(ENSURE_LOCK_PATH), { recursive: true });
  try {
    await mkdir(ENSURE_LOCK_PATH, { recursive: false });
    return true;
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err) || (err as { code?: string }).code !== "EEXIST") {
      throw err;
    }
  }

  try {
    const details = await stat(ENSURE_LOCK_PATH);
    const ageMs = Date.now() - details.mtimeMs;
    if (ageMs > ENSURE_LOCK_TTL_MS) {
      await rm(ENSURE_LOCK_PATH, { recursive: true, force: true });
      try {
        await mkdir(ENSURE_LOCK_PATH, { recursive: false });
        return true;
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "EEXIST") {
          return false;
        }
        throw err;
      }
    }
  } catch {
    // If we cannot inspect the lock reliably, treat it as held.
  }

  return false;
}

async function releaseEnsureLock(): Promise<void> {
  await rm(ENSURE_LOCK_PATH, { recursive: true, force: true });
}

export async function ensureUsageScheduler(origin: string): Promise<{ ensured: boolean; reason?: string }> {
  const lastEnsureRaw = await usageDbGetMeta("scheduler.last_ensure_ms");
  const lastEnsure = lastEnsureRaw ? Number(lastEnsureRaw) || 0 : 0;
  if (lastEnsure > 0 && Date.now() - lastEnsure < ENSURE_INTERVAL_MS) {
    return { ensured: false, reason: "recently-ensured" };
  }

  const token = getGatewayToken();
  if (!origin || !token) {
    return { ensured: false, reason: "missing-origin-or-token" };
  }

  const lockAcquired = await tryAcquireEnsureLock();
  if (!lockAcquired) {
    return { ensured: false, reason: "ensure-in-progress" };
  }

  try {
    const existing = await gatewayCall<CronList>("cron.list", {}, 15000);
    const jobs = Array.isArray(existing.jobs) ? existing.jobs : [];

    for (const desired of JOBS) {
      const webhookUrl = buildWebhookUrl(origin, desired.task);
      if (!webhookUrl) continue;

      const matches = jobs.filter((job) => job.name === desired.name);
      const canonical = chooseCanonicalJob(matches, desired.everyMs, webhookUrl);

      if (canonical?.id && needsUpdate(canonical, desired.everyMs, webhookUrl)) {
        await gatewayCall(
          "cron.update",
          {
            id: canonical.id,
            patch: {
              enabled: true,
              description: "Mission Control system-managed usage job",
              schedule: { kind: "every", everyMs: desired.everyMs },
              payload: { kind: "systemEvent", text: desired.name },
              delivery: { mode: "webhook", to: webhookUrl, bestEffort: true },
            },
          },
          15000,
        );
      } else if (!canonical?.id) {
        await gatewayCall(
          "cron.add",
          {
            name: desired.name,
            description: "Mission Control system-managed usage job",
            schedule: { kind: "every", everyMs: desired.everyMs },
            sessionTarget: "main",
            payload: { kind: "systemEvent", text: desired.name },
            delivery: { mode: "webhook", to: webhookUrl, bestEffort: true },
            enabled: true,
          },
          15000,
        );
      }

      const duplicateIds = matches
        .filter((job) => job.id && job.id !== canonical?.id)
        .map((job) => job.id as string);
      for (const duplicateId of duplicateIds) {
        await gatewayCall("cron.remove", { id: duplicateId }, 15000);
      }
    }

    await usageDbSetMeta("scheduler.last_ensure_ms", String(Date.now()));
    return { ensured: true };
  } finally {
    await releaseEnsureLock();
  }
}
