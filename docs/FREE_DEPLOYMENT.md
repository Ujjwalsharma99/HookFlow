# HookFlow zero-monthly-cost demo

This setup uses only free tiers:

| Part | Host | Plan |
| --- | --- | --- |
| React/Vite frontend | GitHub Pages | Free, with a public repository on GitHub Free |
| Express API + BullMQ worker | One Render Web Service | Free |
| Redis-compatible queue, rate limits, and idempotency state | Render Key Value | Free |

No paid add-on, payment provider, paid database, or billing details are used by the application or its workflow. Free-tier availability, account enrollment rules, and quotas can change; choose only options explicitly shown as Free in the host UI. If the host requires a payment method or paid upgrade for your account, stop rather than proceeding with a paid plan.

## Free-tier limitations to understand

- Render Free Web Services can spin down after 15 minutes without inbound traffic. The API and worker share this one service, so the worker is **not always on**. A sleeping service is not processing the queue; a later request may take about a minute while Render wakes it. A webhook accepted just before the service sleeps may wait until it wakes. Do not describe this demo as real-time or highly available.
- Render Free Key Value is small (currently 25 MB), memory-only, and can be restarted. A restart clears queue jobs, rate-limit keys, idempotency reservations, and receiver dedupe records. This can lose queued work and can make an earlier event appear new. The no-eviction policy prevents Redis from silently evicting arbitrary keys, but full memory causes writes to fail; HookFlow then returns `503` for protected API work. See [Render Free Key Value limitations](https://render.com/docs/free) and [Key Value memory policies](https://render.com/docs/key-value).
- Render's current free web tier has one instance and limited memory (512 MB). Running API and worker in the same service keeps the service count at one, but both Node processes share that memory and CPU. The supervisor exits the service if either child exits unexpectedly.
- The separate Render background-worker service has no free instance. That is why this deployment combines the worker and API inside the free **web** service. Use the preserved `start:api` and `start:worker` scripts only if you later move to a host/plan that supports separate continuously running services.
- GitHub Pages on GitHub Free requires a **public** repository. Its project site is available at `https://OWNER.github.io/HookFlow/`; the browser origin for CORS is `https://OWNER.github.io` and does not include `/HookFlow/`. Confirm the public repository is safe to publish before enabling Pages. GitHub Pages is a static host and must not contain private environment variables.

Render documents the free web-service sleep behavior and free Key Value data loss in its [free deployment guide](https://render.com/docs/free). New Render Key Value instances use Valkey, which is Redis-compatible; configure `noeviction` for BullMQ queues as recommended in the [Key Value docs](https://render.com/docs/key-value). The Render [private-network documentation](https://render.com/docs/private-network) says Free web services can send private-network requests but cannot receive them. In this single-service design the worker calls the receiver over `127.0.0.1`, so it does not need API private networking.

## 1. Prepare GitHub Pages

These instructions prepare the repository; they do not push or deploy it.

1. Make sure the repository name is exactly `HookFlow`, because Vite is built with the case-sensitive `/HookFlow/` project-site base path.
2. For GitHub Free, set the repository visibility to **Public**. GitHub Pages is not available for a private repository on GitHub Free; see [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
3. In the GitHub repository, open **Settings → Pages**. Set the publishing source to **GitHub Actions**.
4. Open **Settings → Secrets and variables → Actions → Variables** and create the repository variable:

   - Name: `VITE_API_BASE_URL`
   - Value: the public Render service API URL ending exactly in `/api`, for example `https://hookflow-demo.onrender.com/api`

   This is a public API URL, not a secret. It is embedded into JavaScript during the build. The workflow rejects an empty value, localhost, non-HTTPS URLs, or a path other than `/api`.
5. The workflow at `.github/workflows/pages.yml` builds with `VITE_BASE_PATH=/HookFlow/`, runs `npm ci` and `npm run build` from `frontend/`, uploads `frontend/dist`, then publishes it. It runs on pushes to `main` or from **Actions → Build and deploy HookFlow frontend → Run workflow**. If your repository's default branch is not `main`, update the workflow's branch filter before deployment.

The Vite development server still uses the existing local proxy and `/` base path. To make a local production bundle with the GitHub Pages path, use the build command below.

## 2. Create the free Render service

1. Create a Render account and choose **New → Web Service** for this repository. Connect the GitHub repository after you decide it is safe to make public for Pages.
2. Set **Root Directory** to `backend`.
3. Choose the **Free** instance type. Do not create a separate Background Worker service.
4. Use these commands:

   - Build: `npm ci && npm run build`
   - Start: `npm run start:combined`

5. Set the health-check path to `/ready`. Render supplies the `PORT` environment variable (default `10000`); the API binds to `0.0.0.0` on that port.
6. Under the service's environment settings add:

   | Variable | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `CORS_ALLOWED_ORIGINS` | `https://OWNER.github.io` (replace `OWNER`; do **not** append `/HookFlow/`) |
   | `HOOKFLOW_RECEIVER_BASE_URL` | `http://127.0.0.1:10000` |
   | `HOOKFLOW_RECEIVER_ALLOWED_ORIGINS` | `http://127.0.0.1:10000` |
   | `HOOKFLOW_RECEIVER_TOKEN` | A private random value of at least 32 characters |
   | `TRUST_PROXY_HOPS` | `1` for Render's single inbound proxy hop; verify the forwarded client IP behavior in Render before relying on per-IP limits |
   | `NODE_OPTIONS` | `--max-old-space-size=160` to cap each of the two Node processes for the free instance's 512 MB memory limit |
   | `WEBHOOK_WORKER_CONCURRENCY` | `1` to keep the combined free instance modest |
   | `DEMO_WORKER_CONCURRENCY` | `1` |

   The configured receiver is loopback within this same service; the worker cannot choose a host or path from event data. Keep the same token private in the Render service settings. It is never placed in GitHub variables, frontend code, or logs. Render's default web-service port is `10000`; if you change `PORT`, change both loopback receiver origins to the same port.

7. Do not set `REDIS_URL` yet. Create the free Redis-compatible datastore in the next section, then add its internal URL as a Render environment variable.

## 3. Create the free Redis-compatible Key Value

1. In Render, choose **New → Key Value**.
2. Choose the **Free** tier, select the same region as the web service, and set its maxmemory policy to **`noeviction`**. Do not enable or select a paid tier.
3. Create the datastore and copy its **internal** connection URL from the Connect panel.
4. Add the URL as `REDIS_URL` in the web service's Render environment settings. Use the exact scheme Render provides (`redis://` internally, or `rediss://` if its connection details require TLS). Keep it out of GitHub and source files.
5. Save the service settings and redeploy/restart the Render web service so both child processes receive the Redis URL.

If the free datastore creation flow does not offer `noeviction`, check the instance's settings after creation. BullMQ needs writes; `noeviction` means a full 25 MB store rejects writes instead of silently deleting queue keys. When memory fills, inspect retained jobs and Redis usage. Do not assume Redis data survives maintenance or a restart.

## 4. Set up the Pages API URL and publish

After Render deploys, find the service's public `onrender.com` URL, such as `https://hookflow-demo.onrender.com`. Set the GitHub Actions variable to that URL plus `/api`:

```text
https://hookflow-demo.onrender.com/api
```

The API's `CORS_ALLOWED_ORIGINS` value remains only the origin:

```text
https://OWNER.github.io
```

The Pages URL contains the repository path `/HookFlow/`, but CORS origins contain only scheme, hostname, and optional port. Save changes, then run the workflow from the Actions tab or let a push to `main` trigger it. The Pages build will fail early if `VITE_API_BASE_URL` was not configured correctly.

## 5. Verify the public demo

The first request after idle may take about a minute while the free service wakes. If a request times out during that wake, wait for Render to show the service as live and submit again.

Check the API first:

```sh
curl -i https://YOUR-RENDER-SERVICE.onrender.com/health
curl -i https://YOUR-RENDER-SERVICE.onrender.com/ready
```

Both should return `200` after the service is awake and connected to Redis. Submit a success event:

```sh
curl -i -X POST https://YOUR-RENDER-SERVICE.onrender.com/api/webhook-events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: free-demo-check-001' \
  --data '{"eventType":"invoice.paid","payload":{"invoiceId":"free-check-1"},"scenario":"success"}'
```

Copy the returned job ID and inspect it:

```sh
curl -i https://YOUR-RENDER-SERVICE.onrender.com/api/webhook-events/JOB_ID
```

Expect the worker to process the job when the service is awake. The success scenario should report a completed job with HTTP 200. The transient scenario returns two HTTP 500 attempts and then HTTP 200; failure exhausts three HTTP 500 attempts; permanent fails after one HTTP 400. Repeat the same request and idempotency key to verify it returns the original job ID; change the payload while reusing that key and expect `409`.

Then visit `https://OWNER.github.io/HookFlow/` and submit from the dashboard. If the browser console reports a CORS error, compare the request's `Origin` with `CORS_ALLOWED_ORIGINS` exactly. The correct value has no `/HookFlow/` path and no trailing slash.

## 6. Test the combined service locally

Use the existing local Redis service. From the project root:

```sh
docker compose up -d redis
cd backend
npm ci
npm run build
NODE_ENV=development PORT=3000 npm run start:combined
```

In a second terminal, verify API readiness:

```sh
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/ready
```

Submit and poll a real job:

```sh
curl -sS -X POST http://127.0.0.1:3000/api/webhook-events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-combined-check-001' \
  --data '{"eventType":"invoice.paid","payload":{"invoiceId":"local-1"},"scenario":"success"}'

curl -sS http://127.0.0.1:3000/api/webhook-events/JOB_ID
```

The POST returns a job ID; replace `JOB_ID` in the second command. Confirm the combined terminal logs both API and worker startup and the delivery completion. Press `Ctrl-C`: the supervisor forwards SIGTERM to both children and exits after they shut down. To check failure propagation without damaging the normal local Redis setup, run this separate command from `backend/`; it should exit non-zero after the worker rejects the missing receiver allowlist, and the supervisor stops the API child:

```sh
NODE_ENV=production PORT=3001 CORS_ALLOWED_ORIGINS=https://owner.github.io \
HOOKFLOW_RECEIVER_BASE_URL=http://127.0.0.1:3001 npm run start:combined
```

The command deliberately omits `HOOKFLOW_RECEIVER_ALLOWED_ORIGINS` and `HOOKFLOW_RECEIVER_TOKEN`; do not copy this invalid configuration into Render settings.

## 7. Useful commands and operations

Build the GitHub Pages artifact locally:

```sh
cd frontend
npm ci
VITE_BASE_PATH=/HookFlow/ \
VITE_API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com/api \
npm run build
```

Build and check the backend locally:

```sh
cd backend
npm ci
npm run typecheck
npm run build
npm test
```

Render logs include both child processes because the supervisor inherits their standard output and error. `/health` is liveness; `/ready` returns 503 if Redis is unavailable or shutdown is in progress. Production retains bounded anonymous rate limits, pending-job caps, and BullMQ job retention. Queue count checks can briefly overshoot under simultaneous arrivals; the limits are demo controls, not a strict admission semaphore.

Use this as an educational public demo, not a durable webhook service. The free web instance sleeps, Redis can lose all data, and API/worker share a small resource limit. A `202` means the event was accepted into the current Redis queue; it does not promise immediate processing or survive a free Redis restart.
