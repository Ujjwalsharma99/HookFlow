import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { test } from "node:test";
import { Queue, Worker } from "bullmq";
import {
  closeRedisConnection,
  createApiRedisConnection,
  createWorkerRedisConnection,
  waitForRedisReady,
} from "./redis-connection.js";
import { deliverWebhook } from "./webhook-delivery.js";
import {
  deleteBusinessOperationRecord,
  getBusinessOperationRecord,
} from "./receiver-idempotency.js";
import {
  enqueueWebhookEvent,
  idempotencyKeyHash,
  IDEMPOTENCY_RETENTION_MS,
  isValidIdempotencyKey,
} from "./webhook-idempotency.js";
import {
  INITIAL_BACKOFF_MS,
  MAX_DELIVERY_ATTEMPTS,
  type WebhookDeliveryResult,
  type WebhookEventData,
  type WebhookScenario,
  WEBHOOK_DELIVERY_QUEUE_NAME,
  webhookJobOptions,
} from "./webhook-jobs.js";
import { createWebhookApi } from "./webhook-api.js";

async function createHarness() {
  const queueName = `${WEBHOOK_DELIVERY_QUEUE_NAME}-test-${randomUUID()}`;
  const previousPort = process.env.PORT;
  const queueConnection = createApiRedisConnection();
  await waitForRedisReady(queueConnection);
  const workerConnection = createWorkerRedisConnection();
  const queue = new Queue<WebhookEventData, WebhookDeliveryResult>(queueName, {
    connection: queueConnection,
    defaultJobOptions: webhookJobOptions,
  });
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", createWebhookApi(queue, queueConnection));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind to a TCP port");
  process.env.PORT = String(address.port);

  const worker = new Worker<WebhookEventData, WebhookDeliveryResult>(queueName, deliverWebhook, {
    connection: workerConnection,
  });
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);

  const idempotencyKeyHashes: string[] = [];
  const eventIds = new Set<string>();
  worker.on("active", (job) => eventIds.add(`${job.queueName}:${job.id}`));
  return {
    queue,
    redis: queueConnection,
    baseUrl: `http://127.0.0.1:${address.port}`,
    rememberIdempotencyKey(key: string) {
      idempotencyKeyHashes.push(idempotencyKeyHash(key));
    },
    async close() {
      await worker.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await queue.obliterate({ force: true });
      for (const eventId of eventIds) {
        await deleteBusinessOperationRecord(queueConnection, eventId);
      }
      for (const keyHash of idempotencyKeyHashes) {
        await queueConnection.del(`hookflow:idempotency:${keyHash}`, `hookflow:idempotency:${keyHash}:lease`);
      }
      await queue.close();
      await Promise.all([
        closeRedisConnection(queueConnection),
        closeRedisConnection(workerConnection),
      ]);
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    },
  };
}

async function postEvent(
  baseUrl: string,
  event: Pick<WebhookEventData, "eventType" | "payload" | "scenario">,
  idempotencyKey?: string,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return fetch(`${baseUrl}/api/webhook-events`, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  });
}

async function waitForJob(queue: Queue<WebhookEventData, WebhookDeliveryResult>, jobId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Test job ${jobId} disappeared`);
    const state = await job.getState();
    if (state === "completed" || state === "failed") return { job, state };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Test job ${jobId} did not finish before the timeout`);
}

async function waitForFirstDelayedAttempt(
  queue: Queue<WebhookEventData, WebhookDeliveryResult>,
  jobId: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === "delayed" && job.data.attemptHistory.length > 0) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Test job ${jobId} did not enter delayed state`);
}

async function addJob(
  queue: Queue<WebhookEventData, WebhookDeliveryResult>,
  scenario: WebhookScenario,
) {
  return queue.add("test-webhook-delivery", {
    eventType: "order.created",
    payload: { orderId: "test-order" },
    scenario,
    attemptHistory: [],
  });
}

test("successful receiver completes after one HTTP delivery", async () => {
  assert.equal(webhookJobOptions.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.deepEqual(webhookJobOptions.backoff, { type: "exponential", delay: INITIAL_BACKOFF_MS });
  assert.deepEqual(webhookJobOptions.removeOnComplete, { age: 2 * 24 * 60 * 60, count: 2_000 });
  assert.deepEqual(webhookJobOptions.removeOnFail, { age: 7 * 24 * 60 * 60, count: 1_000 });

  const harness = await createHarness();
  try {
    const job = await addJob(harness.queue, "success");
    const finished = await waitForJob(harness.queue, String(job.id));

    assert.equal(finished.state, "completed");
    assert.deepEqual(
      finished.job.returnvalue,
      { delivered: true, statusCode: 200 },
      `unexpected job state ${finished.state}; failure=${finished.job.failedReason}; attempts=${JSON.stringify(finished.job.data.attemptHistory)}`,
    );
    assert.equal(finished.job.data.attemptHistory.length, 1);
    assert.equal(finished.job.data.attemptHistory[0]?.outcome, "success");
    const operation = await getBusinessOperationRecord(harness.redis, `${job.queueName}:${job.id}`);
    assert.equal(operation?.executionCount, 1);
  } finally {
    await harness.close();
  }
});

test("transient receiver recovers on attempt three with isolated per-job numbering", async () => {
  const harness = await createHarness();
  try {
    const jobs = await Promise.all([
      addJob(harness.queue, "transient"),
      addJob(harness.queue, "transient"),
    ]);

    const delayed = await waitForFirstDelayedAttempt(harness.queue, String(jobs[0]?.id));
    assert.equal(await delayed.getState(), "delayed");
    assert.equal(delayed.data.attemptHistory.length, 1);

    const finished = await Promise.all(
      jobs.map((job) => waitForJob(harness.queue, String(job.id))),
    );
    for (const result of finished) {
      assert.equal(result.state, "completed");
      assert.deepEqual(result.job.returnvalue, { delivered: true, statusCode: 200 });
      assert.deepEqual(
        result.job.data.attemptHistory.map((attempt) => attempt.attemptNumber),
        [1, 2, 3],
      );
      assert.deepEqual(
        result.job.data.attemptHistory.map((attempt) => attempt.httpStatus),
        [500, 500, 200],
      );
    }

    for (const job of jobs) {
      const eventId = `${job.queueName}:${job.id}`;
      const operation = await getBusinessOperationRecord(harness.redis, eventId);
      assert.equal(operation?.executionCount, 1);
      assert.equal(operation?.deliveryAttempts, 3);
    }
  } finally {
    await harness.close();
  }
});

test("retryable HTTP 500 exhausts all three attempts and keeps history", async () => {
  const harness = await createHarness();
  try {
    const job = await addJob(harness.queue, "failure");
    const finished = await waitForJob(harness.queue, String(job.id));

    assert.equal(finished.state, "failed");
    assert.equal(finished.job.attemptsMade, 3);
    assert.equal(finished.job.data.attemptHistory.length, 3);
    assert.ok(finished.job.failedReason?.includes("HTTP 500"));
    assert.ok(finished.job.data.attemptHistory.every((attempt) => attempt.httpStatus === 500));
  } finally {
    await harness.close();
  }
});

test("permanent HTTP 400 fails immediately without automatic retries", async () => {
  const harness = await createHarness();
  try {
    const job = await addJob(harness.queue, "permanent");
    const finished = await waitForJob(harness.queue, String(job.id));

    assert.equal(finished.state, "failed");
    assert.equal(finished.job.attemptsMade, 1);
    assert.equal(finished.job.data.attemptHistory.length, 1);
    assert.equal(finished.job.data.attemptHistory[0]?.outcome, "permanent_failure");
    assert.ok(finished.job.failedReason?.includes("permanent HTTP 400"));
  } finally {
    await harness.close();
  }
});

const eventForIdempotency: WebhookEventData = {
  eventType: "order.created",
  payload: { orderId: "idempotent-order" },
  scenario: "success",
  attemptHistory: [],
};

test("submission without an idempotency key keeps normal enqueue behavior", async () => {
  const harness = await createHarness();
  try {
    const response = await postEvent(harness.baseUrl, {
      eventType: eventForIdempotency.eventType,
      payload: eventForIdempotency.payload,
      scenario: eventForIdempotency.scenario,
    });
    const body = (await response.json()) as { jobId: string };

    assert.equal(response.status, 202);
    assert.ok(body.jobId);
    assert.equal(body.jobId.startsWith("idem-"), false);
    assert.ok(await harness.queue.getJob(body.jobId));
  } finally {
    await harness.close();
  }
});

test("malformed idempotency keys are rejected before enqueue", async () => {
  const harness = await createHarness();
  try {
    const response = await postEvent(
      harness.baseUrl,
      {
        eventType: eventForIdempotency.eventType,
        payload: eventForIdempotency.payload,
        scenario: eventForIdempotency.scenario,
      },
      "invalid key with spaces",
    );
    assert.equal(response.status, 400);
    const jobs = await harness.queue.getJobCounts("wait", "active", "delayed", "completed", "failed");
    assert.equal(Object.values(jobs).reduce((sum, count) => sum + count, 0), 0);
  } finally {
    await harness.close();
  }
});

test("same idempotency key reuses its job and conflicts on different event data", async () => {
  const harness = await createHarness();
  const key = `same-key-${randomUUID()}`;
  harness.rememberIdempotencyKey(key);
  try {
    const event = {
      eventType: eventForIdempotency.eventType,
      payload: eventForIdempotency.payload,
      scenario: eventForIdempotency.scenario,
    };
    const firstResponse = await postEvent(harness.baseUrl, event, key);
    const first = (await firstResponse.json()) as { jobId: string };
    const duplicateResponse = await postEvent(harness.baseUrl, event, key);
    const duplicate = (await duplicateResponse.json()) as { jobId: string };
    const conflictResponse = await postEvent(
      harness.baseUrl,
      { ...event, payload: { orderId: "different-order" } },
      key,
    );

    assert.equal(firstResponse.status, 202);
    assert.equal(duplicateResponse.status, 202);
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(conflictResponse.status, 409);
    const jobs = await harness.queue.getJobCounts("wait", "active", "delayed", "completed", "failed");
    assert.equal(Object.values(jobs).reduce((sum, count) => sum + count, 0), 1);
  } finally {
    await harness.close();
  }
});

test("concurrent identical submissions create one logical BullMQ job", async () => {
  const harness = await createHarness();
  const key = `concurrent-${randomUUID()}`;
  harness.rememberIdempotencyKey(key);
  try {
    const event = {
      eventType: eventForIdempotency.eventType,
      payload: eventForIdempotency.payload,
      scenario: eventForIdempotency.scenario,
    };
    const submissions = await Promise.all(
      Array.from({ length: 8 }, () => postEvent(harness.baseUrl, event, key)),
    );

    assert.ok(submissions.every((response) => response.status === 202));
    const results = await Promise.all(
      submissions.map((response) => response.json() as Promise<{ jobId: string }>),
    );
    const jobIds = results.map((result) => result.jobId);
    assert.equal(new Set(jobIds).size, 1);
    const jobs = await harness.queue.getJobCounts("wait", "active", "delayed", "completed", "failed");
    assert.equal(Object.values(jobs).reduce((sum, count) => sum + count, 0), 1);
  } finally {
    await harness.close();
  }
});

test("enqueue failures release their lease so the same key can recover", async () => {
  const harness = await createHarness();
  const key = `recover-${randomUUID()}`;
  harness.rememberIdempotencyKey(key);
  const originalAdd = harness.queue.add.bind(harness.queue);
  try {
    harness.queue.add = (async () => {
      throw new Error("simulated queue enqueue failure");
    }) as typeof harness.queue.add;

    const failed = await enqueueWebhookEvent(harness.queue, harness.redis, eventForIdempotency, key);
    assert.equal(failed.status, 503);

    harness.queue.add = originalAdd;
    const recovered = await enqueueWebhookEvent(harness.queue, harness.redis, eventForIdempotency, key);
    assert.equal(recovered.status, 202);
    if (recovered.status !== 202) assert.fail("Expected retry after enqueue failure to be accepted");
    const reservation = JSON.parse(
      (await harness.redis.get(`hookflow:idempotency:${idempotencyKeyHash(key)}`)) ?? "{}",
    ) as { jobId?: string };
    assert.equal(recovered.jobId, reservation.jobId);
    assert.ok(await harness.queue.getJob(recovered.jobId));
  } finally {
    harness.queue.add = originalAdd;
    await harness.close();
  }
});

test("an expired idempotency record permits a new submission", async () => {
  const harness = await createHarness();
  const key = `expires-${randomUUID()}`;
  harness.rememberIdempotencyKey(key);
  try {
    const first = await enqueueWebhookEvent(harness.queue, harness.redis, eventForIdempotency, key);
    assert.equal(first.status, 202);
    const keyHash = idempotencyKeyHash(key);
    await harness.redis.pexpire(`hookflow:idempotency:${keyHash}`, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const afterExpiry = await enqueueWebhookEvent(harness.queue, harness.redis, eventForIdempotency, key);
    assert.equal(afterExpiry.status, 202);
    assert.notEqual(
      "jobId" in afterExpiry ? afterExpiry.jobId : "",
      "jobId" in first ? first.jobId : "",
    );
    assert.equal(IDEMPOTENCY_RETENTION_MS, 24 * 60 * 60 * 1_000);
  } finally {
    await harness.close();
  }
});

test("idempotency keys accept bounded safe characters", () => {
  assert.equal(isValidIdempotencyKey("order-123_A.~"), true);
  assert.equal(isValidIdempotencyKey("bad key"), false);
  assert.equal(isValidIdempotencyKey("x".repeat(129)), false);
});
