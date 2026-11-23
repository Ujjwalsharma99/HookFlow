import { Worker } from "bullmq";
import {
  DEMO_QUEUE_NAME,
  type DemoJobData,
  type DemoJobResult,
} from "./demo-jobs.js";
import { closeRedisConnection, createWorkerRedisConnection } from "./redis-connection.js";
import { deliverWebhook } from "./webhook-delivery.js";
import { WEBHOOK_DELIVERY_QUEUE_NAME, type WebhookEventData, type WebhookDeliveryResult } from "./webhook-jobs.js";

const redisConnection = createWorkerRedisConnection();
const worker = new Worker<DemoJobData, DemoJobResult>(
  DEMO_QUEUE_NAME,
  async (_job) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return { status: "success", message: "Demo job processed" };
  },
  { connection: redisConnection },
);

const webhookRedisConnection = createWorkerRedisConnection();
const webhookWorker = new Worker<WebhookEventData, WebhookDeliveryResult>(
  WEBHOOK_DELIVERY_QUEUE_NAME,
  deliverWebhook,
  { connection: webhookRedisConnection },
);

worker.on("completed", (job) => {
  console.log(`Demo job ${job.id} completed successfully`);
});

worker.on("failed", (job) => {
  console.error(`Demo job ${job?.id ?? "unknown"} failed`);
});

worker.on("error", () => {
  console.error("Demo worker encountered a Redis error");
});

webhookWorker.on("completed", (job, result) => {
  console.log(`Webhook delivery job ${job.id} completed with HTTP ${result.statusCode}`);
});

webhookWorker.on("failed", (job) => {
  console.error(`Webhook delivery job ${job?.id ?? "unknown"} failed`);
});

webhookWorker.on("error", () => {
  console.error("Webhook delivery worker encountered a Redis error");
});

console.log(`HookFlow worker listening on queues ${DEMO_QUEUE_NAME} and ${WEBHOOK_DELIVERY_QUEUE_NAME}`);

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HookFlow worker received ${signal}; waiting for active jobs`);

  try {
    await Promise.all([worker.close(), webhookWorker.close()]);
    await Promise.all([
      closeRedisConnection(redisConnection),
      closeRedisConnection(webhookRedisConnection),
    ]);
    console.log("HookFlow worker shut down cleanly");
    process.exitCode = 0;
  } catch {
    redisConnection.disconnect();
    webhookRedisConnection.disconnect();
    console.error("HookFlow worker shutdown encountered an error");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
