import express from "express";
import type { Server } from "node:http";
import { demoQueue, demoQueueRedisConnection } from "./demo-queue.js";
import { closeRedisConnection } from "./redis-connection.js";
import { getApiPort, getInteger, getPositiveInteger } from "./server-config.js";
import { webhookDeliveryQueue, webhookQueueRedisConnection } from "./webhook-queue.js";
import { createWebhookApi } from "./webhook-api.js";
import { createCorsMiddleware } from "./cors.js";
import { createRateLimiter } from "./rate-limit.js";

const app = express();
const proxyHops = getInteger("TRUST_PROXY_HOPS", 0, 0, 10);
app.set("trust proxy", proxyHops);
app.use(createCorsMiddleware());
app.use("/api", createRateLimiter(
  webhookQueueRedisConnection,
  "api",
  getPositiveInteger("API_RATE_LIMIT_PER_MINUTE", 120, 100_000),
));
const webhookPostLimiter = createRateLimiter(
  webhookQueueRedisConnection,
  "webhook-submit",
  getPositiveInteger("WEBHOOK_SUBMISSION_RATE_LIMIT_PER_MINUTE", 10, 10_000),
);
const demoPostLimiter = createRateLimiter(
  webhookQueueRedisConnection,
  "demo-submit",
  getPositiveInteger("DEMO_SUBMISSION_RATE_LIMIT_PER_MINUTE", 20, 10_000),
);

app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "hookflow" });
});

let isShuttingDown = false;
app.get("/ready", async (_request, response) => {
  if (isShuttingDown) {
    response.status(503).json({ status: "not-ready" });
    return;
  }
  try {
    await Promise.all([demoQueueRedisConnection.ping(), webhookQueueRedisConnection.ping()]);
    response.json({ status: "ready", service: "hookflow" });
  } catch {
    response.status(503).json({ status: "not-ready", service: "hookflow" });
  }
});

app.post("/api/demo-jobs", (request, response, next) => {
  void demoPostLimiter(request, response, (error) => error ? next(error) : createDemoJob(request, response));
});

async function createDemoJob(request: express.Request, response: express.Response): Promise<void> {
  const message: unknown = request.body?.message;

  if (typeof message !== "string" || message.trim().length === 0 || message.length > 1_000) {
    response.status(400).json({
      error: "message must be a non-empty string of at most 1000 characters",
    });
    return;
  }

  try {
    const maximumPending = getPositiveInteger("MAX_PENDING_DEMO_JOBS", 100, 100_000);
    const counts = await demoQueue.getJobCounts("wait", "active", "delayed", "prioritized");
    if (Object.values(counts).reduce((total, count) => total + count, 0) >= maximumPending) {
      response.setHeader("Retry-After", "5");
      response.status(503).json({ error: "Demo queue is at capacity; retry shortly" });
      return;
    }
    const job = await demoQueue.add("process-demo-message", { message: message.trim() });
    response.status(202).json({ jobId: job.id });
  } catch {
    console.error("Could not enqueue demo job because Redis is unavailable");
    response.status(503).json({ error: "Job service is temporarily unavailable" });
  }
}

app.get("/api/demo-jobs/:id", async (request, response) => {
  try {
    const job = await demoQueue.getJob(request.params.id);

    if (!job) {
      response.status(404).json({ error: "Job not found" });
      return;
    }

    const state = await job.getState();
    response.json({ jobId: job.id, state, result: job.returnvalue ?? null });
  } catch {
    console.error("Could not retrieve demo job because Redis is unavailable");
    response.status(503).json({ error: "Job service is temporarily unavailable" });
  }
});

app.post("/api/webhook-events", (request, response, next) => {
  void webhookPostLimiter(request, response, (error) => error ? next(error) : next());
});
app.use("/api", createWebhookApi(webhookDeliveryQueue, webhookQueueRedisConnection));

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Request body must contain valid JSON" });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    response.status(413).json({ error: "Request body exceeds the 16 KB limit" });
    return;
  }
  console.error("Request failed due to an internal server error");
  response.status(500).json({ error: "Internal server error" });
});

demoQueue.on("error", () => {
  console.error("Demo job queue encountered a Redis error");
});
demoQueueRedisConnection.on("error", () => {
  console.error("Demo queue Redis connection encountered an error");
});

webhookDeliveryQueue.on("error", () => {
  console.error("Webhook delivery queue encountered a Redis error");
});
webhookQueueRedisConnection.on("error", () => {
  console.error("Webhook queue Redis connection encountered an error");
});

const apiPort = getApiPort();
const server: Server = app.listen(apiPort, "0.0.0.0", () => {
  console.log(`HookFlow API listening on port ${apiPort}`);
});

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HookFlow API received ${signal}; shutting down`);
  const deadline = setTimeout(() => {
    console.error("API graceful shutdown timed out; closing open connections");
    server.closeAllConnections();
    demoQueueRedisConnection.disconnect();
    webhookQueueRedisConnection.disconnect();
    process.exitCode = 1;
  }, 15_000);
  deadline.unref();
  server.close(async () => {
    try {
      await Promise.all([demoQueue.close(), webhookDeliveryQueue.close()]);
      await Promise.all([
        closeRedisConnection(demoQueueRedisConnection),
        closeRedisConnection(webhookQueueRedisConnection),
      ]);
      console.log("HookFlow API shut down cleanly");
      process.exitCode = 0;
    } catch {
      demoQueueRedisConnection.disconnect();
      webhookQueueRedisConnection.disconnect();
      console.error("HookFlow API shutdown encountered an error");
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
