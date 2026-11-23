import type { ApiErrorBody, ApiResponse, WebhookEventInput, WebhookJobStatus } from "./types";

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL || "/api";
export const apiBaseUrl = configuredBaseUrl.replace(/\/$/, "");

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export async function submitWebhookEvent(
  event: WebhookEventInput,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<ApiResponse<ApiErrorBody>> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  const response = await fetch(`${apiBaseUrl}/webhook-events`, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal,
  });
  return { status: response.status, data: await readJson<ApiErrorBody>(response) };
}

export async function getWebhookJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<WebhookJobStatus> {
  const response = await fetch(`${apiBaseUrl}/webhook-events/${encodeURIComponent(jobId)}`, { signal });
  const body = await readJson<WebhookJobStatus & ApiErrorBody>(response);
  if (!response.ok) {
    throw new ApiRequestError(body.error || `Could not load job (${response.status})`, response.status);
  }
  return body;
}

export async function getHealth(signal?: AbortSignal): Promise<void> {
  const healthPath = apiBaseUrl.startsWith("http")
    ? new URL("/health", apiBaseUrl).toString()
    : `${apiBaseUrl.replace(/\/api\/?$/, "")}/health` || "/health";
  const response = await fetch(healthPath, { signal });
  if (!response.ok) throw new Error("API health check failed");
  const body = await readJson<ApiErrorBody>(response);
  if (body.status !== "ok") throw new Error("API health check failed");
}
