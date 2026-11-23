import type { JobsOptions } from "bullmq";

export const WEBHOOK_DELIVERY_QUEUE_NAME = "hookflow-webhook-delivery";
export const MAX_DELIVERY_ATTEMPTS = 3;
export const INITIAL_BACKOFF_MS = 2_000;

export type WebhookScenario = "success" | "transient" | "failure" | "permanent";

export type AttemptOutcome = "success" | "retryable_failure" | "permanent_failure";
export type AttemptErrorCategory = "timeout" | "network_error";

export interface DeliveryAttempt {
  attemptNumber: number;
  timestamp: string;
  httpStatus?: number;
  errorCategory?: AttemptErrorCategory;
  outcome: AttemptOutcome;
}

export interface WebhookEventData {
  eventType: string;
  payload: Record<string, unknown>;
  scenario: WebhookScenario;
  attemptHistory: DeliveryAttempt[];
}

export interface WebhookDeliveryResult {
  delivered: true;
  statusCode: number;
}

export const webhookJobOptions: JobsOptions = {
  attempts: MAX_DELIVERY_ATTEMPTS,
  backoff: { type: "exponential", delay: INITIAL_BACKOFF_MS },
  removeOnFail: false,
};
