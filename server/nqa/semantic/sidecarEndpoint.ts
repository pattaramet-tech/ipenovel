function isIpv4Private(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

export function isNqaLoopbackHost(hostname: string): boolean {
  return new Set(["127.0.0.1", "localhost", "::1"]).has(hostname);
}

export function isNqaPrivateSidecarHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    isNqaLoopbackHost(normalized) ||
    isIpv4Private(normalized) ||
    normalized === "host.docker.internal" ||
    normalized.endsWith(".internal")
  );
}

export function validateNqaSidecarEndpoint(input: {
  endpoint: string;
  privateBridge?: boolean;
}): URL {
  const parsed = new URL(input.endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NQA sidecar endpoint must use HTTP or HTTPS.");
  }
  if (!isNqaPrivateSidecarHost(parsed.hostname)) {
    throw new Error(
      "NQA sidecar endpoint must use loopback or a private bridge hostname."
    );
  }
  if (!isNqaLoopbackHost(parsed.hostname) && input.privateBridge !== true) {
    throw new Error(
      "Remote private NQA sidecar endpoints require the private bridge gate."
    );
  }
  return parsed;
}

export function nqaSidecarHealthEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  parsed.pathname = parsed.pathname.startsWith("/api/nqa/bridge/")
    ? "/api/nqa/bridge/health"
    : "/health";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
