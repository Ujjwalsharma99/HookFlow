import { createHash, randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import type { WebhookDeliveryResult, WebhookEventData } from "./webhook-jobs.js";

export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const reservationLeaseMs = 30_000;
const pendingWaitMs = 5_000;
const pendingPollMs = 25;

const reserveScript = `
local recordJson = redis.call('GET', KEYS[1])
if not recordJson then
  local record = { fingerprint = ARGV[1], jobId = ARGV[2], state = 'pending' }
  redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[4])
  redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[5])
  return { 'owner', ARGV[2] }
end

local record = cjson.decode(recordJson)
if record.fingerprint ~= ARGV[1] then
  return { 'conflict', record.jobId }
end
if record.state == 'ready' then
  return { 'ready', record.jobId }
end
if redis.call('GET', KEYS[2]) then
  return { 'pending', record.jobId }
end

redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[5])
return { 'owner', record.jobId }
`;

const markReadyScript = `
local recordJson = redis.call('GET', KEYS[1])
if not recordJson then return 0 end
local record = cjson.decode(recordJson)
if record.fingerprint ~= ARGV[1] or record.jobId ~= ARGV[2] then return 0 end
record.state = 'ready'
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[3])
if redis.call('GET', KEYS[2]) == ARGV[4] then redis.call('DEL', KEYS[2]) end
return 1
`;

const releaseLeaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export type ReservationResult =
  | { state: "owner" | "pending" | "ready"; jobId: string }
  | { state: "conflict"; jobId: string };

export function isValidIdempotencyKey(key: string): boolean {
  return /^[A-Za-z0-9._~-]{1,128}$/.test(key);
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJsonKeys(child)]),
  );
}

export function fingerprintWebhookEvent(event: WebhookEventData): string {
  const canonical = JSON.stringify({
    eventType: event.eventType,
    payload: sortJsonKeys(event.payload),
    scenario: event.scenario,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function idempotencyKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function recordKey(keyHash: string): string {
  return `hookflow:idempotency:${keyHash}`;
}

function leaseKey(keyHash: string): string {
  return `${recordKey(keyHash)}:lease`;
}

export async function reserveIdempotencyKey(
  redis: Redis,
  keyHash: string,
  fingerprint: string,
  candidateJobId: string,
  ownerToken: string,
): Promise<ReservationResult> {
  const result = (await redis.eval(
    reserveScript,
    2,
    recordKey(keyHash),
    leaseKey(keyHash),
    fingerprint,
    candidateJobId,
    ownerToken,
    String(IDEMPOTENCY_RETENTION_MS),
    String(reservationLeaseMs),
  )) as [string, string];
  return { state: result[0] as ReservationResult["state"], jobId: result[1] } as ReservationResult;
}

export async function markIdempotencyKeyReady(
  redis: Redis,
  keyHash: string,
  fingerprint: string,
  jobId: string,
  ownerToken: string,
): Promise<void> {
  const result = await redis.eval(
    markReadyScript,
    2,
    recordKey(keyHash),
    leaseKey(keyHash),
    fingerprint,
    jobId,
    String(IDEMPOTENCY_RETENTION_MS),
    ownerToken,
  );
  if (result !== 1) throw new Error("Idempotency reservation could not be finalized");
}

export async function releaseIdempotencyLease(
  redis: Redis,
  keyHash: string,
  ownerToken: string,
): Promise<void> {
  await redis.eval(releaseLeaseScript, 1, leaseKey(keyHash), ownerToken);
}

export type EnqueueWebhookResult =
  | { status: 202; jobId: string }
  | { status: 409; error: string }
  | { status: 503; error: string; retryAfter: number };

export async function enqueueWebhookEvent(
  queue: Queue<WebhookEventData, WebhookDeliveryResult>,
  redis: Redis,
  event: WebhookEventData,
  idempotencyKey?: string,
  maximumPending = 500,
): Promise<EnqueueWebhookResult> {
  if (!idempotencyKey) {
    if (await hasReachedPendingLimit(queue, maximumPending)) {
      return { status: 503, error: "Webhook queue is at capacity; retry shortly", retryAfter: 5 };
    }
    const job = await queue.add("deliver-webhook", event);
    return { status: 202, jobId: String(job.id) };
  }

  const keyHash = idempotencyKeyHash(idempotencyKey);
  const fingerprint = fingerprintWebhookEvent(event);
  const ownerToken = randomUUID();
  const candidateJobId = `idem-${keyHash.slice(0, 24)}-${randomUUID()}`;
  const deadline = Date.now() + pendingWaitMs;

  while (true) {
    const reservation = await reserveIdempotencyKey(
      redis,
      keyHash,
      fingerprint,
      candidateJobId,
      ownerToken,
    );

    if (reservation.state === "conflict") {
      return { status: 409, error: "Idempotency-Key was already used for a different webhook event" };
    }
    if (reservation.state === "ready") {
      return { status: 202, jobId: reservation.jobId };
    }

    if (reservation.state === "pending") {
      const existingJob = await queue.getJob(reservation.jobId);
      if (existingJob) {
        await markIdempotencyKeyReady(redis, keyHash, fingerprint, reservation.jobId, ownerToken);
        return { status: 202, jobId: reservation.jobId };
      }
      if (Date.now() >= deadline) {
        return {
          status: 503,
          error: "Webhook submission is still being recorded; retry with the same Idempotency-Key",
          retryAfter: 1,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pendingPollMs));
      continue;
    }

    try {
      const existingJob = await queue.getJob(reservation.jobId);
      if (!existingJob) {
        if (await hasReachedPendingLimit(queue, maximumPending)) {
          await releaseIdempotencyLease(redis, keyHash, ownerToken);
          return { status: 503, error: "Webhook queue is at capacity; retry shortly", retryAfter: 5 };
        }
        await queue.add("deliver-webhook", event, { jobId: reservation.jobId });
      }
      await markIdempotencyKeyReady(redis, keyHash, fingerprint, reservation.jobId, ownerToken);
      return { status: 202, jobId: reservation.jobId };
    } catch {
      // A Redis timeout can make enqueue outcome ambiguous. Reconcile before releasing the lease.
      try {
        const existingJob = await queue.getJob(reservation.jobId);
        if (existingJob) {
          await markIdempotencyKeyReady(redis, keyHash, fingerprint, reservation.jobId, ownerToken);
          return { status: 202, jobId: reservation.jobId };
        }
        await releaseIdempotencyLease(redis, keyHash, ownerToken);
      } catch {
        // Leave the lease to expire if Redis is still unavailable; a same-key retry can recover it.
      }
      return {
        status: 503,
        error: "Webhook service is temporarily unavailable; retry with the same Idempotency-Key",
        retryAfter: 1,
      };
    }
  }
}

async function hasReachedPendingLimit(
  queue: Queue<WebhookEventData, WebhookDeliveryResult>,
  maximumPending: number,
): Promise<boolean> {
  const counts = await queue.getJobCounts("wait", "active", "delayed", "prioritized");
  return Object.values(counts).reduce((total, count) => total + count, 0) >= maximumPending;
}
