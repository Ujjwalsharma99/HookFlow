import express from "express";
import type { Server } from "node:http";
import { demoQueue, demoQueueRedisConnection } from "./demo-queue.js";

const app = express();
const port = Number(process.env.PORT) || 3000;

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

demoQueue.on("error", () => {
  console.error("Demo job queue encountered a Redis error");
});

const server: Server = app.listen(port, () => {
  console.log(`HookFlow API listening on port ${port}`);
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HookFlow API received ${signal}; shutting down`);

  server.close(async () => {
    try {
      await demoQueue.close();
      if (demoQueueRedisConnection.status !== "end") {
        await demoQueueRedisConnection.quit();
      }
      console.log("HookFlow API shut down cleanly");
      process.exitCode = 0;
    } catch {
      demoQueueRedisConnection.disconnect();
      console.error("HookFlow API shutdown encountered an error");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
