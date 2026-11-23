# Stage 4B: Idempotency behavior

## Producer keys

`POST /api/webhook-events` accepts an optional `Idempotency-Key` header containing 1–128 ASCII letters, digits, dots, underscores, tildes, or hyphens. The API fingerprints the normalized event type, payload, and scenario. Object keys in JSON payloads are sorted before fingerprinting, so key ordering alone does not make a different request.

The key record is stored in Redis for 24 hours after the job is successfully associated with it. During that window, an identical request returns the original job ID; a different request using the key returns `409 Conflict`. Failed or completed jobs are still associated with the key and are not automatically re-enqueued by a duplicate request.

An atomic Lua reservation stores the request fingerprint, a reserved job ID, and a short enqueue lease. A second request cannot claim the same key for a different event, and identical concurrent requests either observe the ready record or wait for/recover the reserved job. BullMQ's custom job ID is an additional duplicate guard; the Redis key record is the source of idempotency state. If enqueue fails, the API checks whether the job was actually created before releasing the lease. If Redis is unavailable, it leaves the lease to expire and responds `503`; retry the same request with the same key.

If an operator removes a BullMQ job before the 24-hour key record expires, the producer still returns the recorded job ID and does not silently create a replacement. The status endpoint can then return `404` because the job data was removed. After the idempotency record expires, the same key is treated as a new submission and receives a fresh job ID. A pending reservation that is never completed expires after 24 hours; its shorter enqueue lease expires after 30 seconds so a later same-key request can recover it.

## Receiver deduplication

Each delivery includes `x-hookflow-event-id`, built from the queue name and stable BullMQ job ID. The controlled receiver uses a Redis Lua operation to create one simulated business-operation record per event ID. The record is kept for 30 days. On repeated deliveries, Redis returns the existing record and the simulated operation is not performed again. The transient receiver deliberately returns HTTP 500 for the first two transport attempts and HTTP 200 on the third to demonstrate a completed operation whose acknowledgement was not received.

The 30-day receiver record is a demonstration retention limit, not a universal exactly-once guarantee. A real receiver must keep its deduplication record at least as long as the sender can retry or replay an event, and coordinate that record atomically with its actual business transaction where possible.
