import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { paymentQr: { get: query } } }));
vi.mock("@/constants/payment", () => ({ QR_PAYMENT_IMAGE: "https://example.com/original.png" }));
import { PaymentQr, PaymentQrView, paymentQrQueryOptions } from "./PaymentQr";
const generated = { mode: "generated" as const, revision: 1, amount: "1.00", imageUrl: "data:image/png;base64,TEST", error: null };
const legacy = { ...generated, mode: "static" as const, revision: 2, imageUrl: null };
const html = (data: any, extra = {}) => renderToStaticMarkup(createElement(PaymentQrView, {
  data, expectedAmount: "1.00", loading: false, failed: false, retry: () => {}, ...extra,
}));
describe("payment QR UI recovery", () => {
  it("renders amount QR then original QR after fresh settings are fetched", () => {
    query.useQuery.mockReturnValue({ data: generated, isLoading: false, isError: false });
    const props = { request: { kind: "wallet" as const, amount: "1.00" }, expectedAmount: "1.00" };
    expect(renderToStaticMarkup(createElement(PaymentQr, props))).toContain(generated.imageUrl);
    query.useQuery.mockReturnValue({ data: legacy, isLoading: false, isError: false });
    const switched = renderToStaticMarkup(createElement(PaymentQr, props));
    expect(switched).toContain("https://example.com/original.png");
    expect(switched).not.toContain(generated.imageUrl);
    expect(switched).toContain("กรุณากรอกยอด 1.00 บาท");
    expect(query.useQuery).toHaveBeenLastCalledWith(props.request, paymentQrQueryOptions);
    expect(paymentQrQueryOptions).toMatchObject({ staleTime: 0, refetchInterval: 15000, refetchOnWindowFocus: "always", retry: false });
  });
  it("suppresses cached generated QR on refetch error", () => {
    const output = html(generated, { failed: true });
    expect(output).not.toContain("<img");
    expect(output).toContain("ลองโหลด QR ใหม่");
  });
  it("never silently auto-selects the static QR on generator failure", () => {
    const output = html({ ...generated, imageUrl: null, error: "GENERATOR_UNAVAILABLE" });
    expect(output).not.toContain("<img");
    expect(output).toContain("ไม่พร้อมใช้งาน");
  });
  it("hides mismatching amounts and asks to refresh before transfer", () => {
    const output = html(generated, { expectedAmount: "2.00" });
    expect(output).not.toContain("<img");
    expect(output).toContain("ยอดชำระเปลี่ยนแล้ว");
  });
  it("uses the configured static override", () => {
    expect(html({ ...legacy, imageUrl: "https://example.com/override.png" })).toContain("https://example.com/override.png");
  });
  it("does not show previous QR while initial load or amount changes", () => {
    expect(html(undefined, { loading: true })).not.toContain("<img");
  });
});
