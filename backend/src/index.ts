import express from "express";
import type { Server } from "node:http";
import { demoQueue, demoQueueRedisConnection } from "./demo-queue.js";
import { closeRedisConnection } from "./redis-connection.js";
import { apiPort } from "./server-config.js";
import { webhookDeliveryQueue, webhookQueueRedisConnection } from "./webhook-queue.js";
import type { WebhookEventData, WebhookScenario } from "./webhook-jobs.js";

const app = express();
const maxWebhookPayloadBytes = 8 * 1024;

app.use(express.json({ limit: "16kb" }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateWebhookEvent(body: unknown): WebhookEventData | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).some((key) => !["eventType", "payload", "scenario"].includes(key))) {
    return null;
  }

  const { eventType, payload, scenario } = body;
  if (
    typeof eventType !== "string" ||
    eventType.trim().length === 0 ||
    eventType.length > 100 ||
    !isRecord(payload) ||
    (scenario !== "success" && scenario !== "failure")
  ) {
    return null;
  }

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxWebhookPayloadBytes) {
    return null;
  }

  return { eventType: eventType.trim(), payload, scenario: scenario as WebhookScenario };
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "hookflow" });
});

app.post("/api/demo-jobs", async (request, response) => {
  const message: unknown = request.body?.message;

  if (typeof message !== "string" || message.trim().length === 0 || message.length > 1_000) {
    response.status(400).json({
      error: "message must be a non-empty string of at most 1000 characters",
    });
    return;
  }

  try {
    const job = await demoQueue.add("process-demo-message", { message: message.trim() });
    response.status(202).json({ jobId: job.id });
  } catch {
    console.error("Could not enqueue demo job because Redis is unavailable");
    response.status(503).json({ error: "Job service is temporarily unavailable" });
  }
});

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

app.post("/api/webhook-events", async (request, response) => {
  const event = validateWebhookEvent(request.body);
  if (!event) {
    response.status(400).json({
      error: "Provide eventType (up to 100 characters), an object payload (up to 8 KB), and scenario success or failure",
    });
    return;
  }

  try {
    const job = await webhookDeliveryQueue.add("deliver-webhook", event);
    response.status(202).json({ jobId: job.id });
  } catch {
    console.error("Could not enqueue webhook event because Redis is unavailable");
    response.status(503).json({ error: "Webhook service is temporarily unavailable" });
  }
});

app.get("/api/webhook-events/:id", async (request, response) => {
  try {
    const job = await webhookDeliveryQueue.getJob(request.params.id);
    if (!job) {
      response.status(404).json({ error: "Webhook event not found" });
      return;
    }

    const state = await job.getState();
    response.json({
      jobId: job.id,
      state,
      result: job.returnvalue ?? null,
      failure: state === "failed" ? job.failedReason : null,
    });
  } catch {
    console.error("Could not retrieve webhook event because Redis is unavailable");
    response.status(503).json({ error: "Webhook service is temporarily unavailable" });
  }
});

// These local-only receivers let us exercise real HTTP delivery without accepting URLs.
app.post("/api/test-receivers/success", (_request, response) => {
  response.status(200).json({ received: true });
});

app.post("/api/test-receivers/failure", (_request, response) => {
  response.status(500).json({ received: false });
});

demoQueue.on("error", () => {
  console.error("Demo job queue encountered a Redis error");
});

webhookDeliveryQueue.on("error", () => {
  console.error("Webhook delivery queue encountered a Redis error");
});

const server: Server = app.listen(apiPort, () => {
  console.log(`HookFlow API listening on port ${apiPort}`);
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HookFlow API received ${signal}; shutting down`);

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
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
