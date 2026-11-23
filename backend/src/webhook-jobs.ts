export const WEBHOOK_DELIVERY_QUEUE_NAME = "hookflow-webhook-delivery";

export type WebhookScenario = "success" | "failure";

export interface WebhookEventData {
  eventType: string;
  payload: Record<string, unknown>;
  scenario: WebhookScenario;
}

export interface WebhookDeliveryResult {
  delivered: true;
  statusCode: number;
}
