import Redis from "ioredis";

function redisOptions(isWorker: boolean) {
  const maxRetriesPerRequest = isWorker ? null : 1;
  const common = {
    connectTimeout: isWorker ? 5_000 : 2_000,
    maxRetriesPerRequest,
    retryStrategy: (attempt: number) => Math.min(attempt * (isWorker ? 500 : 250), isWorker ? 5_000 : 1_000),
  };
  const url = process.env.REDIS_URL;

  if (url) {
    const options = { ...common, ...(isWorker ? {} : { enableOfflineQueue: false }) };
    return { url, options };
  }

  const port = Number(process.env.REDIS_PORT ?? 6380);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REDIS_PORT must be a valid TCP port");
  }
  return {
    options: {
      ...common,
      host: process.env.REDIS_HOST || "127.0.0.1",
      port,
      ...(process.env.REDIS_USERNAME ? { username: process.env.REDIS_USERNAME } : {}),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
      ...(isWorker ? {} : { enableOfflineQueue: false }),
    },
  };
}

/** API commands fail promptly, while the connection can recover after Redis returns. */
export function createApiRedisConnection(): Redis {
  const config = redisOptions(false);
  return config.url ? new Redis(config.url, config.options) : new Redis(config.options);
}

/** BullMQ workers require maxRetriesPerRequest: null so blocking commands can wait. */
export function createWorkerRedisConnection(): Redis {
  const config = redisOptions(true);
  return config.url ? new Redis(config.url, config.options) : new Redis(config.options);
}

export async function closeRedisConnection(connection: Redis): Promise<void> {
  if (connection.status !== "end") {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        connection.quit(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Redis shutdown timed out")), 5_000);
          timeout.unref();
        }),
      ]);
    } catch {
      connection.disconnect();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function waitForRedisReady(connection: Redis): Promise<void> {
  if (connection.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      connection.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      connection.off("ready", onReady);
      reject(error);
    };
    connection.once("ready", onReady);
    connection.once("error", onError);
  });
}
