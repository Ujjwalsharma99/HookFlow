export function getApiPort(): number {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  return port;
}

export function getPositiveInteger(name: string, fallback: number, maximum: number): number {
  return getInteger(name, fallback, 1, maximum);
}

export function getInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function configuredOrigins(name: string): string[] {
  const origins = (process.env[name] ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error(`${name} must contain valid origins`); }
    if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error(`${name} entries must be exact http(s) origins without paths or credentials`);
    }
  }
  return origins;
}

export function receiverBaseUrl(): URL {
  const raw = process.env.HOOKFLOW_RECEIVER_BASE_URL ?? `http://127.0.0.1:${getApiPort()}`;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("HOOKFLOW_RECEIVER_BASE_URL must be a valid URL"); }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("HOOKFLOW_RECEIVER_BASE_URL must be an http(s) origin without credentials, path, query, or fragment");
  }
  if (process.env.NODE_ENV === "production") {
    const allowed = configuredOrigins("HOOKFLOW_RECEIVER_ALLOWED_ORIGINS");
    if (!allowed.includes(url.origin)) throw new Error("Receiver URL origin must appear in HOOKFLOW_RECEIVER_ALLOWED_ORIGINS");
    receiverToken();
  }
  return url;
}

export function receiverToken(): string {
  const token = process.env.HOOKFLOW_RECEIVER_TOKEN ?? "";
  if (process.env.NODE_ENV === "production" && token.length < 32) {
    throw new Error("HOOKFLOW_RECEIVER_TOKEN must contain at least 32 characters in production");
  }
  return token;
}
