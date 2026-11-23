import { Worker } from "bullmq";
import {
  DEMO_QUEUE_NAME,
  type DemoJobData,
  type DemoJobResult,
} from "./demo-jobs.js";
import { createWorkerRedisConnection } from "./redis-connection.js";

const redisConnection = createWorkerRedisConnection();
const worker = new Worker<DemoJobData, DemoJobResult>(
  DEMO_QUEUE_NAME,
  async (_job) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return { status: "success", message: "Demo job processed" };
  },
  { connection: redisConnection },
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

console.log(`HookFlow worker listening on queue ${DEMO_QUEUE_NAME}`);

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HookFlow worker received ${signal}; waiting for active jobs`);

  try {
    await worker.close();
    if (redisConnection.status !== "end") {
      await redisConnection.quit();
    }
    console.log("HookFlow worker shut down cleanly");
    process.exitCode = 0;
  } catch {
    redisConnection.disconnect();
    console.error("HookFlow worker shutdown encountered an error");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
