import express from "express";
import type { Server } from "node:http";
import { demoQueue, demoQueueRedisConnection } from "./demo-queue.js";
import { closeRedisConnection } from "./redis-connection.js";
import { getApiPort } from "./server-config.js";
import { webhookDeliveryQueue, webhookQueueRedisConnection } from "./webhook-queue.js";
import { createWebhookApi } from "./webhook-api.js";

const app = express();

app.use(express.json({ limit: "16kb" }));

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

app.use("/api", createWebhookApi(webhookDeliveryQueue, webhookQueueRedisConnection));

demoQueue.on("error", () => {
  console.error("Demo job queue encountered a Redis error");
});

webhookDeliveryQueue.on("error", () => {
  console.error("Webhook delivery queue encountered a Redis error");
});

const apiPort = getApiPort();
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
