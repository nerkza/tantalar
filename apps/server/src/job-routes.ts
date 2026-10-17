import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { collectionPage } from "./collection-page.js";
import { safeJobError, type Scheduler } from "./scheduler.js";

export function registerJobRoutes(app: FastifyInstance, scheduler: Scheduler, requireAdmin: (request: any, reply: any) => Promise<unknown>, audit?: (actor: any, action: string, targetType: string, targetId: string, detail?: Record<string, unknown>) => Promise<void>) {
  const params = Type.Object({ key: Type.String({ minLength: 1, maxLength: 300 }) });
  app.get("/api/v1/jobs", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const rows = (await scheduler.listJobs()).map(job => ({ ...job, state: !job.registered ? "unavailable" : job.lockedAt ? "running" : job.enabled ? "enabled" : "disabled" }));
    return collectionPage(rows, request.query as Record<string, unknown>, {
      name: j => j.name, scope: j => j.scope, state: j => j.state, schedule: j => j.schedule,
      lastRunAt: j => j.lastRunAt, nextRunAt: j => j.nextRunAt, outcome: j => j.latestRun?.outcome ?? j.latestRun?.error,
    });
  });
  app.get("/api/v1/jobs/runs", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const q = request.query as Record<string, unknown>;
    return scheduler.listRuns(typeof q.jobKey === "string" ? q.jobKey : undefined, Number(q.page ?? 1), Number(q.pageSize ?? 25), q);
  });
  app.patch("/api/v1/jobs/:key", { schema: { params, body: Type.Object({
    schedule: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })), enabled: Type.Optional(Type.Boolean()), restoreDefault: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false, minProperties: 1 }) } }, async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    try {
      const key = (request.params as { key: string }).key;
      const job = await scheduler.updateJob(key, request.body as { schedule?: string; enabled?: boolean; restoreDefault?: boolean });
      await audit?.(admin, "job.updated", "job", key, { schedule: job.schedule, enabled: Boolean(job.enabled) });
      return { job };
    }
    catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: safeJobError(error) }); }
  });
  app.post("/api/v1/jobs/:key/run", { schema: { params } }, async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    try {
      const runId = await scheduler.dispatch((request.params as { key: string }).key);
      await audit?.(admin, "job.started", "job-run", runId);
      return reply.code(202).send({ runId });
    }
    catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: safeJobError(error) }); }
  });
  app.post("/api/v1/jobs/runs/:key/retry", { schema: { params } }, async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    try {
      const retryOf = (request.params as { key: string }).key;
      const runId = await scheduler.retryRun(retryOf);
      await audit?.(admin, "job.retried", "job-run", runId, { retryOf });
      return reply.code(202).send({ runId });
    }
    catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: safeJobError(error) }); }
  });
}
