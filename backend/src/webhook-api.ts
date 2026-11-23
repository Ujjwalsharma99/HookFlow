import express, { type Router } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import {
  MAX_DELIVERY_ATTEMPTS,
  type WebhookDeliveryResult,
  type WebhookEventData,
  type WebhookScenario,
} from "./webhook-jobs.js";
import { enqueueWebhookEvent, isValidIdempotencyKey } from "./webhook-idempotency.js";
import { processBusinessOperationOnce } from "./receiver-idempotency.js";
import { getPositiveInteger, receiverToken } from "./server-config.js";

const maxWebhookPayloadBytes = 8 * 1024;

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
    !["success", "transient", "failure", "permanent"].includes(String(scenario))
  ) {
    return null;
  }

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxWebhookPayloadBytes) {
    return null;
  }

  return {
    eventType: eventType.trim(),
    payload,
    scenario: scenario as WebhookScenario,
    attemptHistory: [],
  };
}

export function createWebhookApi(
  queue: Queue<WebhookEventData, WebhookDeliveryResult>,
  redis: Redis,
): Router {
  const router = express.Router();

  router.post("/webhook-events", async (request, response) => {
    const event = validateWebhookEvent(request.body);
    if (!event) {
      response.status(400).json({
        error: "Provide eventType (up to 100 characters), an object payload (up to 8 KB), and a valid delivery scenario",
      });
      return;
    }

    const idempotencyKey = request.header("Idempotency-Key");
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      response.status(400).json({
        error: "Idempotency-Key must contain 1 to 128 letters, digits, dots, underscores, tildes, or hyphens",
      });
      return;
    }

    try {
      const maximumPending = getPositiveInteger("MAX_PENDING_WEBHOOK_JOBS", 500, 100_000);
      const result = await enqueueWebhookEvent(queue, redis, event, idempotencyKey, maximumPending);
      if (result.status === 503) response.setHeader("Retry-After", String(result.retryAfter));
      response.status(result.status).json("jobId" in result ? { jobId: result.jobId } : { error: result.error });
    } catch {
      console.error("Could not enqueue webhook event because Redis is unavailable");
      response.setHeader("Retry-After", "1");
      response.status(503).json({ error: "Webhook service is temporarily unavailable" });
    }
  });

  router.get("/webhook-events/:id", async (request, response) => {
    try {
      const job = await queue.getJob(request.params.id);
      if (!job) {
        response.status(404).json({ error: "Webhook event not found" });
        return;
      }

      const state = await job.getState();
      const deliveryAttempts = job.data.attemptHistory ?? [];
      response.json({
        jobId: job.id,
        state,
        attemptsMade: job.attemptsMade,
        deliveryAttemptsMade: deliveryAttempts.length,
        maximumAttempts: job.opts.attempts ?? MAX_DELIVERY_ATTEMPTS,
        deliveryAttempts,
        retryScheduled: state === "delayed",
        result: job.returnvalue ?? null,
        failureReason: state === "failed" ? job.failedReason : null,
      });
    } catch {
      console.error("Could not retrieve webhook event because Redis is unavailable");
      response.status(503).json({ error: "Webhook service is temporarily unavailable" });
    }
  });

  // These local-only receivers simulate an idempotent business operation in Redis.
  router.post("/test-receivers/:scenario", async (request, response) => {
    if (process.env.NODE_ENV === "production") {
      const expected = Buffer.from(receiverToken());
      const presented = Buffer.from(request.header("x-hookflow-receiver-token") ?? "");
      if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
        response.status(404).json({ received: false });
        return;
      }
    }
    const scenario = request.params.scenario;
    if (!["success", "transient", "failure", "permanent"].includes(scenario)) {
      response.status(404).json({ received: false });
      return;
    }

    if (scenario === "permanent") {
      response.status(400).json({ received: false });
      return;
    }

    const eventId = request.header("x-hookflow-event-id");
    const attemptNumber = Number(request.header("x-hookflow-attempt"));
    if (!eventId || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
      response.status(400).json({ received: false });
      return;
    }

    try {
      const operation = await processBusinessOperationOnce(redis, eventId);
      if (scenario === "failure") {
        response.status(500).json({ received: false, businessOperationPerformed: operation.performed });
        return;
      }

      if (scenario === "transient" && attemptNumber <= 2) {
        response.status(500).json({ received: false, businessOperationPerformed: operation.performed });
        return;
      }

      response.status(200).json({ received: true, businessOperationPerformed: operation.performed });
    } catch {
      console.error("Local test receiver could not record the business operation in Redis");
      response.status(503).json({ received: false });
    }
  });

  return router;
}
