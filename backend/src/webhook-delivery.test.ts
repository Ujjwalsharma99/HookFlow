import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Queue, Worker } from "bullmq";
import {
  closeRedisConnection,
  createApiRedisConnection,
  createWorkerRedisConnection,
} from "./redis-connection.js";
import { deliverWebhook } from "./webhook-delivery.js";
import {
  INITIAL_BACKOFF_MS,
  MAX_DELIVERY_ATTEMPTS,
  type WebhookDeliveryResult,
  type WebhookEventData,
  type WebhookScenario,
  WEBHOOK_DELIVERY_QUEUE_NAME,
  webhookJobOptions,
} from "./webhook-jobs.js";

const previousPort = process.env.PORT;
const receiverRequests: Array<{ jobId: string; attempt: number; path: string; status: number }> = [];
let receiverServer: ReturnType<typeof createServer>;

before(async () => {
  receiverServer = createServer((request, response) => {
    const path = request.url ?? "";
    const jobId = request.headers["x-hookflow-job-id"];
    const attempt = Number(request.headers["x-hookflow-attempt"]);

    if (request.method !== "POST" || typeof jobId !== "string" || !Number.isInteger(attempt)) {
      response.writeHead(400).end();
      return;
    }

    const status = path.endsWith("/success")
      ? 200
      : path.endsWith("/transient")
        ? attempt <= 2
          ? 500
          : 200
        : path.endsWith("/failure")
          ? 500
          : path.endsWith("/permanent")
            ? 400
            : 404;

    receiverRequests.push({ jobId, attempt, path, status });
    request.resume();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ received: status >= 200 && status < 300 }));
  });

  await new Promise<void>((resolve, reject) => {
    receiverServer.once("error", reject);
    receiverServer.listen(0, "127.0.0.1", resolve);
  });
  process.env.PORT = String((receiverServer.address() as AddressInfo).port);
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    receiverServer.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
});

async function createHarness() {
  const queueName = `${WEBHOOK_DELIVERY_QUEUE_NAME}-test-${randomUUID()}`;
  const queueConnection = createApiRedisConnection();
  const workerConnection = createWorkerRedisConnection();
  const queue = new Queue<WebhookEventData, WebhookDeliveryResult>(queueName, {
    connection: queueConnection,
    defaultJobOptions: webhookJobOptions,
  });
  const worker = new Worker<WebhookEventData, WebhookDeliveryResult>(queueName, deliverWebhook, {
    connection: workerConnection,
  });

  return {
    queue,
    async close() {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await Promise.all([
        closeRedisConnection(queueConnection),
        closeRedisConnection(workerConnection),
      ]);
    },
  };
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
  receiverRequests.length = 0;
  assert.equal(webhookJobOptions.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.deepEqual(webhookJobOptions.backoff, { type: "exponential", delay: INITIAL_BACKOFF_MS });
  assert.equal(webhookJobOptions.removeOnFail, false);

  const harness = await createHarness();
  try {
    const job = await addJob(harness.queue, "success");
    const finished = await waitForJob(harness.queue, String(job.id));

    assert.equal(finished.state, "completed");
    assert.deepEqual(finished.job.returnvalue, { delivered: true, statusCode: 200 });
    assert.equal(finished.job.data.attemptHistory.length, 1);
    assert.equal(finished.job.data.attemptHistory[0]?.outcome, "success");
    assert.equal(receiverRequests.filter((entry) => entry.jobId === job.id).length, 1);
  } finally {
    await harness.close();
  }
});

test("transient receiver recovers on attempt three with isolated per-job numbering", async () => {
  receiverRequests.length = 0;
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
    }

    for (const job of jobs) {
      const attempts = receiverRequests
        .filter((entry) => entry.jobId === job.id)
        .map((entry) => [entry.attempt, entry.status]);
      assert.deepEqual(attempts, [[1, 500], [2, 500], [3, 200]]);
    }
  } finally {
    await harness.close();
  }
});

test("retryable HTTP 500 exhausts all three attempts and keeps history", async () => {
  receiverRequests.length = 0;
  const harness = await createHarness();
  try {
    const job = await addJob(harness.queue, "failure");
    const finished = await waitForJob(harness.queue, String(job.id));

    assert.equal(finished.state, "failed");
    assert.equal(finished.job.attemptsMade, 3);
    assert.equal(finished.job.data.attemptHistory.length, 3);
    assert.ok(finished.job.failedReason?.includes("HTTP 500"));
    assert.ok(receiverRequests.filter((entry) => entry.jobId === job.id).every((entry) => entry.status === 500));
  } finally {
    await harness.close();
  }
});

test("permanent HTTP 400 fails immediately without automatic retries", async () => {
  receiverRequests.length = 0;
  const harness = await createHarness();
  try {
    const job = await addJob(harness.queue, "permanent");
    const finished = await waitForJob(harness.queue, String(job.id));

    assert.equal(finished.state, "failed");
    assert.equal(finished.job.attemptsMade, 1);
    assert.equal(finished.job.data.attemptHistory.length, 1);
    assert.equal(finished.job.data.attemptHistory[0]?.outcome, "permanent_failure");
    assert.ok(finished.job.failedReason?.includes("permanent HTTP 400"));
    assert.equal(receiverRequests.filter((entry) => entry.jobId === job.id).length, 1);
  } finally {
    await harness.close();
  }
});
