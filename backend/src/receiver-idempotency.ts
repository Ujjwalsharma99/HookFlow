import { createHash } from "node:crypto";
import type Redis from "ioredis";

export interface BusinessOperationRecord {
  eventIdHash: string;
  processedAt: string;
  executionCount: 1;
  deliveryAttempts: number;
}

export interface BusinessOperationResult {
  performed: boolean;
  record: BusinessOperationRecord;
}

const receiverRetentionSeconds = 30 * 24 * 60 * 60;
const processBusinessOperationScript = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local record = cjson.decode(existing)
  record.deliveryAttempts = record.deliveryAttempts + 1
  local remainingTtl = redis.call('TTL', KEYS[1])
  if remainingTtl < 1 then remainingTtl = tonumber(ARGV[3]) end
  local updated = cjson.encode(record)
  redis.call('SET', KEYS[1], updated, 'EX', remainingTtl)
  return { 0, updated }
end
local record = cjson.encode({
  eventIdHash = ARGV[1],
  processedAt = ARGV[2],
  executionCount = 1,
  deliveryAttempts = 1
})
redis.call('SET', KEYS[1], record, 'EX', ARGV[3], 'NX')
return { 1, record }
`;

function eventRecordKey(eventId: string): string {
  const eventIdHash = createHash("sha256").update(eventId).digest("hex");
  return `hookflow:receiver:processed:${eventIdHash}`;
}

export async function processBusinessOperationOnce(
  redis: Redis,
  eventId: string,
): Promise<BusinessOperationResult> {
  const key = eventRecordKey(eventId);
  const eventIdHash = createHash("sha256").update(eventId).digest("hex");
  const result = (await redis.eval(
    processBusinessOperationScript,
    1,
    key,
    eventIdHash,
    new Date().toISOString(),
    String(receiverRetentionSeconds),
  )) as [number, string];

  return {
    performed: Number(result[0]) === 1,
    record: JSON.parse(result[1]) as BusinessOperationRecord,
  };
}

export async function getBusinessOperationRecord(
  redis: Redis,
  eventId: string,
): Promise<BusinessOperationRecord | null> {
  const record = await redis.get(eventRecordKey(eventId));
  return record ? (JSON.parse(record) as BusinessOperationRecord) : null;
}

export async function deleteBusinessOperationRecord(redis: Redis, eventId: string): Promise<void> {
  await redis.del(eventRecordKey(eventId));
}
