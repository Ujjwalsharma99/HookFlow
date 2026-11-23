import { Queue } from "bullmq";
import { createApiRedisConnection } from "./redis-connection.js";
import {
  WEBHOOK_DELIVERY_QUEUE_NAME,
  type WebhookDeliveryResult,
  type WebhookEventData,
} from "./webhook-jobs.js";

export const webhookQueueRedisConnection = createApiRedisConnection();

export const webhookDeliveryQueue = new Queue<WebhookEventData, WebhookDeliveryResult>(
  WEBHOOK_DELIVERY_QUEUE_NAME,
  { connection: webhookQueueRedisConnection },
);
