import { Queue } from "bullmq";
import { DEMO_QUEUE_NAME, type DemoJobData, type DemoJobResult } from "./demo-jobs.js";
import { createApiRedisConnection } from "./redis-connection.js";

export const demoQueueRedisConnection = createApiRedisConnection();

export const demoQueue = new Queue<DemoJobData, DemoJobResult>(DEMO_QUEUE_NAME, {
  connection: demoQueueRedisConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
  },
});
