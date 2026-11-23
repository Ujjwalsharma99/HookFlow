# HookFlow deployment readiness (Stage 6A)

This repository is prepared for deployment, but this guide does not perform a deploy. The demo still delivers only to HookFlow's controlled test receiver; it does not support user-supplied webhook destinations.

## Services and host choice

The examples below use Render because it provides separate static-site, Node web-service, background-worker, and Redis-compatible Key Value service types. The architecture uses four services:

1. **Static site** — serves the Vite build and is free on Render's current plans, subject to included bandwidth and build-pipeline limits.
2. **API web service** — accepts browser requests and enqueues jobs.
3. **Background worker** — continuously reads BullMQ jobs and makes the controlled receiver HTTP request.
4. **Key Value** — managed Redis-compatible storage for queues, idempotency, rate limits, and simulated receiver records.

For a reliable public demo, budget paid compute for the **API** and **worker**, and a paid Key Value plan if queue/idempotency state must survive restarts. Render has no free background-worker instances. The API has a free preview plan, but it can spin down after 15 minutes and cannot receive private-network traffic; a cold start can also exceed HookFlow's 5-second receiver timeout. Free Key Value is memory-only and may restart with all data lost. So the API and free Key Value options can demonstrate the app, but are not dependable for a live queue demo. Static sites are free to host, while bandwidth/build usage may still count toward workspace allowances. Check the live [Render pricing page](https://render.com/pricing) before creating services: plan prices, quotas, included usage, and free-plan eligibility can change.

Render Key Value uses Valkey for newly created instances, which is Redis-compatible for this application's BullMQ/ioredis commands. Paid instances support persistence; choose a persistence option and `noeviction` policy appropriate for queue data. Render exposes internal and external connection URLs; keep API and worker in the same region and use the internal URL where available. Confirm that your selected plan allows the BullMQ commands/scripts and connections the project uses. See [Key Value docs](https://render.com/docs/key-value), [free-plan limitations](https://render.com/docs/free), and [background workers](https://render.com/docs/background-workers).

## Prepare the services

Before creating public services, push this repository yourself to the Git host connected to your Render account. This project was not pushed as part of Stage 6A.

1. Create a paid Redis-compatible Key Value instance. Select the same region as the API and worker. Choose persistence and `noeviction` where available; save its **internal** connection URL for service environment settings. Never paste it into source files or a frontend setting.
2. Create a backend **web service** with repository root directory `backend`, build command `npm ci && npm run build`, and start command `npm run start:api`.
3. Create a backend **background worker** from the same repository and root directory `backend`, using build command `npm ci && npm run build` and start command `npm run start:worker`. This service must remain a continuously running worker; do not use a one-off job or web service command.
4. Create a **static site** with root directory `frontend`, build command `npm ci && npm run build`, and publish directory `dist`.
5. Set the frontend's `VITE_API_BASE_URL` to the API's full public base URL ending in `/api`, for example `https://your-api.example/api`. Vite embeds this at build time, so changing it requires a new frontend build/deploy. Keep the committed local default `/api`; the local Vite proxy continues to forward `/api` and `/health` to `127.0.0.1:3000`.
6. Deploy the API once to obtain its public URL and the platform's internal service address. Configure the worker's receiver base URL to the API's **private service origin** (including its listening port), if the host supports private service-to-service traffic. Add the same exact origin to the receiver allowlist. If private service URLs are unavailable, use the API's HTTPS origin instead. The receiver token protects this test-only route in either case.
7. Set the environment variables below in the backend service settings. Apply the same Redis and receiver variables to API and worker where marked. Generate one random receiver token of at least 32 characters and use it as a secret in both services. Keep it out of the frontend.
8. Set `CORS_ALLOWED_ORIGINS` to the exact deployed frontend origin (scheme and hostname, no path or trailing slash). Configure the platform's actual trusted proxy hop count only after verifying how it forwards client IP headers.
9. Deploy the static site after setting `VITE_API_BASE_URL`. Configure any custom frontend domain and let the host provision HTTPS.
10. Set up service health checks. Use `/ready` for API readiness and `/health` for the existing liveness check. Configure the platform to use the service's configured `PORT`.

### Backend environment variables

| Variable | Required/behavior |
| --- | --- |
| `NODE_ENV` | Set to `production`; turns on mandatory receiver-origin/token checks. |
| `PORT` | Set by the host or set to its required listening port. API binds to `0.0.0.0`. |
| `REDIS_URL` | Managed Redis-compatible connection URL from the host. Use `rediss://` when TLS is required; user/password in the URL are consumed by ioredis. Store as a secret. If absent, local `REDIS_HOST`/`REDIS_PORT` settings remain in use. |
| `HOOKFLOW_RECEIVER_BASE_URL` | Trusted bare origin for the API's test receiver, e.g. the API private address. No path, query, fragment, or credentials. |
| `HOOKFLOW_RECEIVER_ALLOWED_ORIGINS` | Exact comma-separated origins allowed for the receiver target. Must include the receiver base URL's origin. No wildcard or paths. |
| `HOOKFLOW_RECEIVER_TOKEN` | Secret value, at least 32 characters, identical in API and worker. Protects the test receiver route from direct unauthenticated invocation. |
| `CORS_ALLOWED_ORIGINS` | Exact comma-separated browser frontend origins. Required in production, e.g. `https://demo.example.com`. Does not enable credentialed cookies. |
| `TRUST_PROXY_HOPS` | Number of trusted reverse-proxy hops used by Express for client IP rate limits. Default `0`; configure based on verified host behavior. |
| `API_RATE_LIMIT_PER_MINUTE` | Per-client limit for API requests; default `120`. |
| `WEBHOOK_SUBMISSION_RATE_LIMIT_PER_MINUTE` | Additional per-client POST webhook limit; default `10`. |
| `DEMO_SUBMISSION_RATE_LIMIT_PER_MINUTE` | Additional per-client demo-job POST limit; default `20`. |
| `MAX_PENDING_WEBHOOK_JOBS` | Queue backlog bound; default `500`. New submissions receive `503` with `Retry-After` when full. |
| `MAX_PENDING_DEMO_JOBS` | Demo queue backlog bound; default `100`. |
| `WEBHOOK_WORKER_CONCURRENCY` | Parallel webhook deliveries per worker instance; default `3`, maximum `50`. |
| `DEMO_WORKER_CONCURRENCY` | Parallel demo jobs per worker instance; default `2`, maximum `50`. |

`backend/.env.example` is a safe variable reference. The backend does not install a dotenv loader, so Node does not automatically read a backend `.env` file; export variables in the shell or set them in the host's environment UI. Do not put live values in the sample. `REDIS_URL` takes precedence over host/port fields. Explicit host/port mode also supports `REDIS_USERNAME`, `REDIS_PASSWORD`, and `REDIS_TLS=true`; ioredis verifies TLS certificates by default. Local Compose continues to use `127.0.0.1:6380` without TLS or authentication.

## Local pre-deployment checks

From the repository root:

```sh
cd backend
npm ci
npm run typecheck
npm test
npm run build
```

In two separate terminals, start Redis with `docker compose up -d redis`, then launch `npm run dev` in one backend terminal and `npm run dev:worker` in another. The production process commands are `npm run start:api` and `npm run start:worker`; they run compiled JavaScript from `build/`, never `tsx watch`.

Build the frontend with either the local proxy default or a production API URL:

```sh
cd frontend
npm ci
npm run build
VITE_API_BASE_URL=https://your-api.example/api npm run build
```

The Vite dev proxy is retained in `frontend/vite.config.ts`. For a separate production origin, browser fetches use the build-time URL and the API returns CORS headers only for `CORS_ALLOWED_ORIGINS`.

## Verify a live public demo

After you deploy and replace the example hostnames below:

```sh
curl -i https://your-api.example/health
curl -i https://your-api.example/ready
curl -i -X POST https://your-api.example/api/webhook-events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: stage6-live-check-001' \
  --data '{"eventType":"invoice.paid","payload":{"invoiceId":"live-demo-1"},"scenario":"success"}'
```

Expect `/health` and `/ready` to return `200`, and submission to return `202` with a `jobId`. Use that ID to inspect actual queue and delivery state:

```sh
curl -i https://your-api.example/api/webhook-events/JOB_ID_FROM_RESPONSE
```

Expect the successful scenario to reach `completed` with one HTTP 200 attempt. Repeat the POST with the same key and identical event; it should return the same ID. Then submit the same key with a changed payload and expect `409`. Test `transient` for eventual completion after two HTTP 500 attempts and a third HTTP 200; test `failure` for three HTTP 500 attempts followed by a failed job; test `permanent` for one HTTP 400 attempt and immediate failure. Verify the static site in a browser, then inspect API and worker logs for startup, enqueue, delivery completion/failure, and shutdown. Logs intentionally omit payloads, receiver token, and Redis URL.

## Operational behavior and limits

- Queue admission checks pending job counts before enqueueing and rate limits are atomic per client in Redis. Multiple new requests arriving at exactly the same time can briefly pass a queue-count check before each enqueue becomes visible; rate limits, bounded worker concurrency, and the configured maximum reduce this race. For strict hard-cap admission at larger scale, add a Redis-atomic global admission semaphore in a later stage.
- The anonymous demo shares IP-based limits. Correct client IP depends on `TRUST_PROXY_HOPS`; a wrong setting can collapse clients behind a proxy or allow spoofed forwarded IP headers. Verify the host's proxy behavior before raising limits.
- Job history retention is bounded: completed webhook jobs are kept up to two days/2,000 jobs and failed ones up to seven days/1,000 jobs. Demo jobs are kept for up to one day/1,000 completed and seven days/1,000 failed. BullMQ removes aged/count-excess jobs lazily; a status lookup after removal returns 404. Idempotency reservations live 24 hours, so during that interval a duplicate can receive its original job ID even if the job's status record is no longer available. Receiver-side dedupe records expire after 30 days.
- `/health` is a liveness response. `/ready` checks Redis and returns 503 when the queue store is unavailable or shutdown is underway. API enqueue/status requests use bounded Redis retries and return 503 on Redis failure. Workers use BullMQ's required `maxRetriesPerRequest: null` and reconnect while Redis recovers.
- API and worker handle SIGINT/SIGTERM, stop accepting or claiming new work, wait for active work, then close queues and Redis with bounded shutdown handling. A host's termination grace period must exceed the worker's 30-second shutdown window; verify this against the chosen service plan.
- The receiver is a fixed HookFlow route selected by one of four validated scenarios. `eventType` and payload do not select a destination. Production worker startup requires the configured origin allowlist and token.
- Verify the host supports Redis-compatible Lua scripts, BullMQ blocking/stream commands, the selected maxmemory policy, TLS/auth form, concurrent connections, internal routing, and persistence at the chosen tier. Also manually verify static-host SPA fallback behavior (not needed for current API-only routes), the host-assigned `PORT`, health-check path, build commands, per-service environment scoping, worker shutdown grace, IP forwarding, and outbound networking to the private API URL. These are platform-specific and are not validated by local builds.
