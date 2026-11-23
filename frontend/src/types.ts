export type Scenario = "success" | "transient" | "failure" | "permanent";
export type JobState = "waiting" | "active" | "delayed" | "completed" | "failed" | "unknown";

export interface WebhookEventInput {
  eventType: string;
  payload: Record<string, unknown>;
  scenario: Scenario;
}

export interface DeliveryAttempt {
  attemptNumber: number;
  timestamp: string;
  httpStatus?: number;
  errorCategory?: "timeout" | "network_error";
  outcome: "success" | "retryable_failure" | "permanent_failure";
}

export interface WebhookJobStatus {
  jobId: string;
  state: JobState;
  attemptsMade: number;
  deliveryAttemptsMade: number;
  maximumAttempts: number;
  deliveryAttempts: DeliveryAttempt[];
  retryScheduled: boolean;
  result: { delivered: true; statusCode: number } | null;
  failureReason: string | null;
}

export interface ApiErrorBody {
  error?: string;
  jobId?: string;
  status?: string;
  service?: string;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}
