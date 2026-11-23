import { UnrecoverableError, type Job } from "bullmq";
import { getApiPort } from "./server-config.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  type DeliveryAttempt,
  type WebhookDeliveryResult,
  type WebhookEventData,
} from "./webhook-jobs.js";

const requestTimeoutMs = 5_000;

async function saveAttempt(job: Job<WebhookEventData>, attempt: DeliveryAttempt): Promise<void> {
  const history = Array.isArray(job.data.attemptHistory) ? job.data.attemptHistory : [];
  const attemptHistory = [...history, attempt].slice(-MAX_DELIVERY_ATTEMPTS);
  await job.updateData({ ...job.data, attemptHistory });
}

/** Send only to a server-configured local receiver selected by the validated scenario. */
export async function deliverWebhook(
  job: Job<WebhookEventData>,
): Promise<WebhookDeliveryResult> {
  const receiverUrl = `http://127.0.0.1:${getApiPort()}/api/test-receivers/${job.data.scenario}`;
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
      throw new Error(timedOut ? "Webhook request timed out" : "Could not reach local webhook receiver");
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
