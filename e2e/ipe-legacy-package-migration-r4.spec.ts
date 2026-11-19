import { test, expect, type Page } from "@playwright/test";

/**
 * R4 Local-only browser smoke. Every tRPC request is mocked in the browser,
 * including auth.me; it never authenticates against or mutates a real DB.
 * This deliberately verifies UI wiring, not real-database acceptance.
 */
const localOnly = (() => {
  try {
    const host = new URL(process.env.E2E_BASE_URL ?? "").hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
})();

const packages = [
  {
    packageEpisodeId: 77,
    novelId: 5,
    episodeNumber: "1 - 2",
    title: "แพ็ก R4 พร้อมแยก",
    status: "splittable",
    chapterCount: 2,
    createCount: 2,
    keepCount: 0,
    conflictCount: 0,
    issueCodes: [] as string[],
  },
  {
    packageEpisodeId: 78,
    novelId: 5,
    episodeNumber: "3 - 4",
    title: "แพ็ก R4 จากไฟล์",
    status: "source_required",
    chapterCount: 0,
    createCount: 0,
    keepCount: 0,
    conflictCount: 0,
    issueCodes: ["SOURCE_REQUIRED"],
  },
  {
    packageEpisodeId: 79,
    novelId: 5,
    episodeNumber: "5 - 6",
    title: "แพ็ก R4 หน้าถัดไป",
    status: "splittable",
    chapterCount: 2,
    createCount: 2,
    keepCount: 0,
    conflictCount: 0,
    issueCodes: [] as string[],
  },
];

async function mockAllApi(page: Page, applyInputs: unknown[]) {
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedures = decodeURIComponent(url.pathname).split("/api/trpc/")[1]?.split(",") ?? [];
    const batch = url.searchParams.get("batch") === "1";
    const raw = request.method() === "POST" ? request.postData() : url.searchParams.get("input");
    let inputs: Record<string, { json?: any }> = {};
    try {
      inputs = raw ? JSON.parse(raw) : {};
    } catch {
      inputs = {};
    }

    const payloads = procedures.map((proc, index) => {
      const input = batch ? (inputs[String(index)]?.json ?? {}) : (inputs as any)?.json ?? {};
      let data: unknown = null;
      if (proc === "auth.me") {
        data = {
          id: 9001, role: "admin", openId: "r4-mocked-browser-admin",
          name: "Local R4 Admin", email: "r4@example.test",
          loginMethod: "test", createdAt: "2026-11-15T00:00:00.000Z",
          updatedAt: "2026-11-15T00:00:00.000Z",
          lastSignedIn: "2026-11-15T00:00:00.000Z",
        };
      } else if (proc === "auth.sessions.list") {
        data = { readerSessionControls: false, sessions: [] };
      } else if (proc === "admin.novels.list") {
        data = [{ id: 5, title: "เรื่องทดสอบ R4" }];
      } else if (proc === "admin.episodes.packageSplitScanPage") {
        const cursor = Number(input.cursor ?? 0);
        data = cursor < 78
          ? { rows: packages.slice(0, 2), inspected: 2, nextCursor: 78, hasMore: true }
          : { rows: packages.slice(2), inspected: 1, nextCursor: null, hasMore: false };
      } else if (proc === "admin.episodes.packageSplitBatchPreview") {
        data = {
          results: (input.packageEpisodeIds ?? []).map((id: number) => ({
            packageEpisodeId: id, status: "ready",
            planHash: "a".repeat(64), createCount: 2, keepCount: 0,
            conflictCount: 0, warnings: [], issues: [],
          })),
          ready: input.packageEpisodeIds?.length ?? 0, skipped: 0, blocked: 0,
        };
      } else if (proc === "admin.episodes.packageSplitBatchApply") {
        applyInputs.push(input);
        data = {
          results: (input.items ?? []).map((item: { packageEpisodeId: number }) => ({
            packageEpisodeId: item.packageEpisodeId,
            outcome: "migrated", createdCount: 2, keptCount: 0,
          })),
          migrated: input.items?.length ?? 0, skipped: 0, failed: 0,
        };
      }
      return { result: { data: { json: data } } };
    });

    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(batch ? payloads : payloads[0]),
    });
  });
}

test.describe("@local-fixture R4 Package Split Migration (mocked API/browser smoke)", () => {
  test.skip(!localOnly, "R4 UI smoke is allowed only on a locally served build");

  test("admin preview gates apply by explicit price and confirmation; SOURCE_REQUIRED cannot be selected", async ({ page }) => {
    const applyInputs: unknown[] = [];
    await mockAllApi(page, applyInputs);
    await page.goto("/admin/package-split-migration");
    await expect(page.getByRole("heading", { name: "Package Split Migration" }).last()).toBeVisible();
    await expect(page.getByText("แพ็ก R4 พร้อมแยก")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "เลือกแพ็ก 78" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Dry Run / Preview" })).toBeDisabled();

    await page.getByRole("checkbox", { name: "เลือกแพ็ก 77" }).check();
    await page.getByLabel("ราคาต่อบท (บาท)").fill("5.00");
    await page.getByRole("button", { name: "Dry Run / Preview" }).click();
    await expect(page.getByText("พร้อม 1 · ข้าม 0 · มีปัญหา 0")).toBeVisible();

    const applyButton = page.getByRole("button", { name: /ยืนยัน Migration 1 แพ็ก/ });
    await expect(applyButton).toBeDisabled();
    await page.getByLabel("พิมพ์ MIGRATE_PACKAGES เพื่อยืนยัน").fill("MIGRATE_PACKAGES");
    await expect(applyButton).toBeEnabled();
    await page.getByLabel("ราคาต่อบท (บาท)").fill("6.00");
    // Dirty pricing removes the entire action section, not merely disabling it.
    await expect(applyButton).toHaveCount(0);
    await expect(page.getByText("รายการหรือราคาเปลี่ยนแล้ว ต้อง Preview ใหม่ก่อน Apply")).toBeVisible();
    await page.getByLabel("ราคาต่อบท (บาท)").fill("5.00");
    await expect(applyButton).toBeEnabled();

    await applyButton.click();
    await expect(page.getByText(/สำเร็จ 1 · ข้าม 0 · ล้มเหลว 0/)).toBeVisible();
    expect(applyInputs).toHaveLength(1);
    expect(applyInputs[0]).toMatchObject({
      items: [{ packageEpisodeId: 77, planHash: "a".repeat(64) }],
      pricing: { chapterPrice: "5.00" },
      confirmation: "MIGRATE_PACKAGES",
    });
    expect(JSON.stringify(applyInputs[0])).not.toContain("publish");
  });

  test("novel title search, cursor navigation and status labels render on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAllApi(page, []);
    await page.goto("/admin/package-split-migration");
    await expect(page.getByRole("heading", { name: "Package Split Migration" }).last()).toBeVisible();
    await page.getByLabel("ค้นหาชื่อนิยาย").fill("เรื่อง");
    await page.getByRole("button", { name: /เรื่องทดสอบ R4/ }).click();
    await expect(page.getByLabel(/Novel ID/)).toHaveValue("5");
    await expect(page.getByText(/เรื่องที่เลือก: เรื่องทดสอบ R4/)).toBeVisible();
    await page.getByRole("button", { name: "ถัดไป" }).click();
    await expect(page.getByText("แพ็ก R4 หน้าถัดไป")).toBeVisible();
    await page.getByRole("button", { name: "ก่อนหน้า" }).click();
    await expect(page.getByText("แพ็ก R4 จากไฟล์")).toBeVisible();
  });
});
