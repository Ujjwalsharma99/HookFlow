import type { RequestHandler } from "express";
import { configuredOrigins } from "./server-config.js";

export function createCorsMiddleware(): RequestHandler {
  const allowedOrigins = new Set(configuredOrigins("CORS_ALLOWED_ORIGINS"));
  if (process.env.NODE_ENV === "production" && allowedOrigins.size === 0) {
    throw new Error("Set CORS_ALLOWED_ORIGINS to the exact deployed frontend origin in production");
  }

  return (request, response, next) => {
    const origin = request.header("origin");
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
      response.setHeader("Access-Control-Max-Age", "600");
      if (request.method === "OPTIONS") {
        response.status(204).end();
        return;
      }
    } else if (request.method === "OPTIONS") {
      response.status(403).json({ error: "Origin is not allowed" });
      return;
    }
    next();
  };
}
