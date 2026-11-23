import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type Redis from "ioredis";

const fixedWindowScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

/** Redis-backed fixed-window limiter works consistently across API replicas. */
export function createRateLimiter(
  redis: Redis,
  label: string,
  limit: number,
  windowMs = 60_000,
): RequestHandler {
  return async (request, response, next) => {
    const address = request.ip || request.socket.remoteAddress || "unknown";
    const addressHash = createHash("sha256").update(address).digest("hex");
    try {
      const [count, ttl] = (await redis.eval(
        fixedWindowScript,
        1,
        `hookflow:rate:${label}:${addressHash}`,
        String(windowMs),
      )) as [number, number];
      if (Number(count) > limit) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil(Number(ttl) / 1_000))));
        response.status(429).json({ error: "Request limit reached; try again shortly" });
        return;
      }
      next();
    } catch {
      response.setHeader("Retry-After", "1");
      response.status(503).json({ error: "Request protection is temporarily unavailable" });
    }
  };
}
