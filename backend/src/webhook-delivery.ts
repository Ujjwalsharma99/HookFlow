import { UnrecoverableError, type Job } from "bullmq";
import { receiverBaseUrl, receiverToken } from "./server-config.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  type DeliveryAttempt,
  type WebhookDeliveryResult,
  type WebhookEventData,
  type WebhookScenario,
} from "./webhook-jobs.js";

const requestTimeoutMs = 5_000;
const receiverPaths: Record<WebhookScenario, string> = {
  success: "/api/test-receivers/success",
  transient: "/api/test-receivers/transient",
  failure: "/api/test-receivers/failure",
  permanent: "/api/test-receivers/permanent",
};

async function saveAttempt(job: Job<WebhookEventData>, attempt: DeliveryAttempt): Promise<void> {
  const history = Array.isArray(job.data.attemptHistory) ? job.data.attemptHistory : [];
  const attemptHistory = [...history, attempt].slice(-MAX_DELIVERY_ATTEMPTS);
  await job.updateData({ ...job.data, attemptHistory });
}

/** Select a fixed receiver path from a validated scenario under the trusted configured origin. */
export async function deliverWebhook(
  job: Job<WebhookEventData>,
): Promise<WebhookDeliveryResult> {
  const token = receiverToken();
  const receiverUrl = new URL(receiverPaths[job.data.scenario], receiverBaseUrl());
  const attemptNumber = job.attemptsMade + 1;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(receiverUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hookflow-event-id": `${job.queueName}:${job.id}`,
          "x-hookflow-job-id": String(job.id),
          "x-hookflow-attempt": String(attemptNumber),
          ...(token ? { "x-hookflow-receiver-token": token } : {}),
        },
        body: JSON.stringify({ eventType: job.data.eventType, payload: job.data.payload }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      const errorCategory = timedOut ? "timeout" : "network_error";
      await saveAttempt(job, {
        attemptNumber,
        timestamp: new Date().toISOString(),
        errorCategory,
        outcome: "retryable_failure",
      });
      throw new Error(timedOut ? "Webhook request timed out" : "Could not reach configured webhook receiver");
    }

    if (response.ok) {
      await saveAttempt(job, {
        attemptNumber,
        timestamp: new Date().toISOString(),
        httpStatus: response.status,
        outcome: "success",
      });
      return { delivered: true, statusCode: response.status };
    }

    const retryableStatus =
      response.status === 408 || response.status === 429 || response.status >= 500;
    const permanentClientError = response.status >= 400 && response.status < 500;
    const outcome = retryableStatus || !permanentClientError ? "retryable_failure" : "permanent_failure";

    await saveAttempt(job, {
      attemptNumber,
      timestamp: new Date().toISOString(),
      httpStatus: response.status,
      outcome,
    });

    if (permanentClientError && !retryableStatus) {
      throw new UnrecoverableError(`Webhook receiver returned permanent HTTP ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`Webhook receiver returned HTTP ${response.status}`);
    }
    throw new Error("Webhook receiver returned a non-success status");
  } finally {
    clearTimeout(timeout);
  }
}
