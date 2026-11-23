import Redis from "ioredis";

const host = process.env.REDIS_HOST || "127.0.0.1";
const port = Number(process.env.REDIS_PORT) || 6380;

/** API commands fail promptly, while the connection can recover after Redis returns. */
export function createApiRedisConnection(): Redis {
  return new Redis({
    host,
    port,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 250, 1_000),
  });
}

/** BullMQ workers require maxRetriesPerRequest: null so blocking commands can wait. */
export function createWorkerRedisConnection(): Redis {
  return new Redis({
    host,
    port,
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  });
}
