import { describe, expect, it } from "vitest";

import {
  nqaSidecarHealthEndpoint,
  validateNqaSidecarEndpoint,
} from "./sidecarEndpoint";

describe("M28.1 NQA sidecar endpoint policy", () => {
  it("allows loopback endpoints without the private bridge gate", () => {
    expect(
      validateNqaSidecarEndpoint({
        endpoint: "http://127.0.0.1:8765/embed",
      }).hostname
    ).toBe("127.0.0.1");
  });

  it("requires the private bridge gate for private remote endpoints", () => {
    expect(() =>
      validateNqaSidecarEndpoint({
        endpoint: "http://192.168.1.50:8765/embed",
      })
    ).toThrow("Remote private NQA sidecar endpoints require the private bridge gate.");

    expect(
      validateNqaSidecarEndpoint({
        endpoint: "https://makelleley.internal/embed",
        privateBridge: true,
      }).hostname
    ).toBe("makelleley.internal");
  });

  it("rejects public remote hosts even when private bridge mode is enabled", () => {
    expect(() =>
      validateNqaSidecarEndpoint({
        endpoint: "https://example.com/embed",
        privateBridge: true,
      })
    ).toThrow("NQA sidecar endpoint must use loopback or a private bridge hostname.");
  });

  it("derives a bounded health endpoint from the configured origin", () => {
    expect(
      nqaSidecarHealthEndpoint("http://127.0.0.1:8767/adjudicate?x=1")
    ).toBe("http://127.0.0.1:8767/health");
  });
});
