import type { Job } from "bullmq";
import { apiPort } from "./server-config.js";
import type { WebhookDeliveryResult, WebhookEventData } from "./webhook-jobs.js";

const requestTimeoutMs = 5_000;

/** Send only to one of the two local receivers selected by the validated scenario. */
export async function deliverWebhook(
  job: Job<WebhookEventData>,
): Promise<WebhookDeliveryResult> {
  const receiverPath = job.data.scenario === "success" ? "success" : "failure";
  const receiverUrl = `http://127.0.0.1:${apiPort}/api/test-receivers/${receiverPath}`;
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventType: job.data.eventType, payload: job.data.payload }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      throw new Error(timedOut ? "Webhook request timed out" : "Could not reach local webhook receiver");
    }

    if (!response.ok) {
      throw new Error(`Webhook receiver returned HTTP ${response.status}`);
    }

    return { delivered: true, statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
