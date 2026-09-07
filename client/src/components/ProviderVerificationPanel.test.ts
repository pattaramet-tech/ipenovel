import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderVerificationPanel } from "./ProviderVerificationPanel";
describe("admin provider diagnostics", () => {
 it("shows useful allowlisted diagnostics without raw provider PII or credentials", () => {
  const html = renderToStaticMarkup(createElement(ProviderVerificationPanel, { value: { provider: "slip2go", outcome: "ERROR", code: "200200",
   reason: "UNEXPECTED_PROVIDER_HTTP_STATUS", httpStatus: 201, recipientCheckApplied: false,
   providerReference: "synthetic-reference", checkedAt: "2026-09-07T00:00:00Z", secret: "hidden-secret", sender: { name: "private sender" } } }));
  for (const text of ["200200", "201", "UNEXPECTED_PROVIDER_HTTP_STATUS", "synthetic-reference"]) expect(html).toContain(text);
  expect(html).not.toContain("hidden-secret"); expect(html).not.toContain("private sender");
 });
 it("handles absent or malformed snapshots without crashing", () => {
  for (const value of [null, "bad", []]) expect(renderToStaticMarkup(createElement(ProviderVerificationPanel, { value: value }))).toBe("");
  expect(renderToStaticMarkup(createElement(ProviderVerificationPanel, { value: { reason: { unexpected: true } } }))).toContain("ไม่มีข้อมูล");
 });
});
