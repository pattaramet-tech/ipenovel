import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const repoRoot = path.resolve(__dirname, "..");

function userContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `ui-safety-test-${userId}`,
      email: `ui-safety-test-${userId}@example.com`,
      name: "UI Safety Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("Daily check-in moved to Profile, not Home (static source checks, no DB required)", () => {
  const homeSource = fs.readFileSync(path.join(repoRoot, "client/src/pages/Home.tsx"), "utf8");
  const profileSource = fs.readFileSync(path.join(repoRoot, "client/src/pages/ProfilePage.tsx"), "utf8");

  it("Home.tsx no longer imports or renders DailyCheckinCard", () => {
    expect(homeSource).not.toMatch(/DailyCheckinCard/);
  });

  it("ProfilePage.tsx imports and renders DailyCheckinCard", () => {
    expect(profileSource).toMatch(/import DailyCheckinCard from "@\/components\/DailyCheckinCard"/);
    expect(profileSource).toMatch(/<DailyCheckinCard\s*\/>/);
  });

  it("DailyCheckinCard is mounted in exactly one page (not duplicated)", () => {
    const clientDir = path.join(repoRoot, "client/src");
    const pagesDir = path.join(clientDir, "pages");
    const mountingFiles: string[] = [];
    for (const file of fs.readdirSync(pagesDir)) {
      if (!file.endsWith(".tsx")) continue;
      const content = fs.readFileSync(path.join(pagesDir, file), "utf8");
      if (/<DailyCheckinCard\s*\/>/.test(content)) mountingFiles.push(file);
    }
    expect(mountingFiles).toEqual(["ProfilePage.tsx"]);
  });

  it("ProfilePage mounts DailyCheckinCard after the '!user' early-return guard (query only fires when logged in)", () => {
    const guardIndex = profileSource.indexOf("if (!user)");
    const mountIndex = profileSource.indexOf("<DailyCheckinCard");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(mountIndex).toBeGreaterThan(guardIndex);
  });

  it("DailyCheckinCard uses Profile-appropriate spacing (mb-8), not Home's large section spacing", () => {
    const cardSource = fs.readFileSync(path.join(repoRoot, "client/src/components/DailyCheckinCard.tsx"), "utf8");
    expect(cardSource).not.toMatch(/mb-12 sm:mb-16 md:mb-20/);
    expect(cardSource).toMatch(/mb-8/);
  });
});

describe("Daily check-in error states never reference the raw error object (static source check)", () => {
  const cardSource = fs.readFileSync(path.join(repoRoot, "client/src/components/DailyCheckinCard.tsx"), "utf8");
  // Strip comments before checking - the file's own docblock explains this
  // rule in prose (mentioning "error.message" as the thing NOT to do),
  // which would otherwise false-positive against the code-only check below.
  const cardCodeOnly = cardSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  it("does not interpolate error.message or err.message anywhere in actual code", () => {
    expect(cardCodeOnly).not.toMatch(/error\?\.message/);
    expect(cardCodeOnly).not.toMatch(/err\?\.message/);
    expect(cardCodeOnly).not.toMatch(/error\.message/);
    expect(cardCodeOnly).not.toMatch(/err\.message/);
  });

  it("uses the fixed, translated checkin.error string for both the query error state and the mutation error toast", () => {
    const errorStateMatches = cardSource.match(/t\("checkin\.error"\)/g) || [];
    expect(errorStateMatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("dailyCheckin.getStatus never leaks a raw DB error to the client (real router call, no mocking)", () => {
  // No DATABASE_URL is set in this sandbox, so db.getDailyCheckinStatus
  // genuinely throws "Database not available" here - this exercises the
  // real try/catch path added to the router, not a simulated one.
  it("wraps any thrown error in a safe, generic TRPCError message", async () => {
    const caller = appRouter.createCaller(userContext(1));
    await expect(caller.dailyCheckin.getStatus()).rejects.toMatchObject({
      message: "Unable to load check-in information. Please try again.",
    });
  });

  it("the thrown error message never contains SQL/schema/query details", async () => {
    const caller = appRouter.createCaller(userContext(1));
    try {
      await caller.dailyCheckin.getStatus();
      throw new Error("expected getStatus to throw in this DB-less environment");
    } catch (error: any) {
      const message = String(error?.message || "");
      for (const forbidden of ["SELECT", "select", "dailyCheckins", "coupons", "DATABASE_URL", "mysql://"]) {
        expect(message).not.toContain(forbidden);
      }
    }
  });
});

describe("nav.profile translation (LanguageContext)", () => {
  const langSource = fs.readFileSync(path.join(repoRoot, "client/src/contexts/LanguageContext.tsx"), "utf8");

  function extractBlock(source: string, marker: "th:" | "en:"): string {
    const start = source.indexOf(marker);
    const nextMarker = marker === "th:" ? "en:" : "};";
    const end = source.indexOf(nextMarker, start);
    return source.slice(start, end);
  }

  it("th block defines nav.profile as โปรไฟล์", () => {
    const thBlock = extractBlock(langSource, "th:");
    expect(thBlock).toMatch(/"nav\.profile":\s*"โปรไฟล์"/);
  });

  it("en block defines nav.profile as Profile", () => {
    const enBlock = extractBlock(langSource, "en:");
    expect(enBlock).toMatch(/"nav\.profile":\s*"Profile"/);
  });

  it("every nav.* key referenced in Navbar.tsx has a translation in both th and en blocks (catches the same bug class in the future)", () => {
    const navbarSource = fs.readFileSync(path.join(repoRoot, "client/src/components/Navbar.tsx"), "utf8");
    const referencedKeys = new Set<string>();
    for (const match of navbarSource.matchAll(/t\("(nav\.[a-zA-Z0-9.]+)"\)/g)) {
      referencedKeys.add(match[1]);
    }
    expect(referencedKeys.size).toBeGreaterThan(0);

    const thBlock = extractBlock(langSource, "th:");
    const enBlock = extractBlock(langSource, "en:");
    const missingInTh: string[] = [];
    const missingInEn: string[] = [];
    for (const key of referencedKeys) {
      const pattern = new RegExp(`"${key.replace(/\./g, "\\.")}":`);
      if (!pattern.test(thBlock)) missingInTh.push(key);
      if (!pattern.test(enBlock)) missingInEn.push(key);
    }
    expect(missingInTh).toEqual([]);
    expect(missingInEn).toEqual([]);
  });
});

describe("checkin.* translation keys exist in both languages", () => {
  const langSource = fs.readFileSync(path.join(repoRoot, "client/src/contexts/LanguageContext.tsx"), "utf8");
  const requiredKeys = [
    "checkin.title",
    "checkin.description",
    "checkin.loginPrompt",
    "checkin.claimButton",
    "checkin.claiming",
    "checkin.alreadyCheckedIn",
    "checkin.retry",
    "checkin.error",
    "checkin.couponCode",
    "checkin.expires",
  ];

  it.each(requiredKeys)("%s is defined at least twice (th + en)", (key) => {
    const escaped = key.replace(/\./g, "\\.");
    const matches = langSource.match(new RegExp(`"${escaped}":`, "g")) || [];
    expect(matches.length).toBe(2);
  });

  it("the daily check-in title never contains the word ฟรี (per the task's copy guidance)", () => {
    const titleMatch = langSource.match(/"checkin\.title":\s*"([^"]+)"/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1]).not.toContain("ฟรี");
  });
});
