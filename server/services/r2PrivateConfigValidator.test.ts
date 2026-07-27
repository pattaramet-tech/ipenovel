import { describe, it, expect } from "vitest";
import { validatePrivateR2Config, type R2PrivateConfigInput } from "./r2PrivateConfigValidator";

const VALID: R2PrivateConfigInput = {
  accountId: "test-account",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "super-secret-value-should-never-be-logged",
  endpoint: "https://test-account.r2.cloudflarestorage.com",
  bucketName: "test-private-bucket",
  signedUrlExpiresSeconds: 900,
};

describe("validatePrivateR2Config - valid configuration", () => {
  it("returns null for a fully valid configuration", () => {
    expect(validatePrivateR2Config(VALID)).toBeNull();
  });

  it("returns null when the account ID case differs from the endpoint hostname's case", () => {
    expect(validatePrivateR2Config({ ...VALID, accountId: "TEST-ACCOUNT" })).toBeNull();
  });

  it("returns null when every value has incidental leading/trailing whitespace", () => {
    expect(
      validatePrivateR2Config({
        accountId: "  test-account  ",
        accessKeyId: "  test-access-key-id  ",
        secretAccessKey: "  super-secret-value-should-never-be-logged  ",
        endpoint: "  https://test-account.r2.cloudflarestorage.com  ",
        bucketName: "  test-private-bucket  ",
        signedUrlExpiresSeconds: 900,
      })
    ).toBeNull();
  });

  it("accepts the minimum sane signed-URL expiry (60s)", () => {
    expect(validatePrivateR2Config({ ...VALID, signedUrlExpiresSeconds: 60 })).toBeNull();
  });

  it("accepts the maximum sane signed-URL expiry (7 days)", () => {
    expect(validatePrivateR2Config({ ...VALID, signedUrlExpiresSeconds: 7 * 24 * 60 * 60 })).toBeNull();
  });
});

describe("validatePrivateR2Config - CONFIG_MISSING", () => {
  it.each([
    "accountId",
    "accessKeyId",
    "secretAccessKey",
    "endpoint",
    "bucketName",
  ] as const)("reports CONFIG_MISSING when %s is empty", (field) => {
    const problem = validatePrivateR2Config({ ...VALID, [field]: "" });
    expect(problem?.category).toBe("CONFIG_MISSING");
  });

  it("reports CONFIG_MISSING when a value is whitespace-only (trims to empty)", () => {
    const problem = validatePrivateR2Config({ ...VALID, bucketName: "   " });
    expect(problem?.category).toBe("CONFIG_MISSING");
  });

  it("lists every missing variable's safe NAME in `detail`, never a configured value", () => {
    const problem = validatePrivateR2Config({ ...VALID, accountId: "", bucketName: "" });
    expect(problem?.category).toBe("CONFIG_MISSING");
    expect(problem?.detail).toContain("R2_PRIVATE_ACCOUNT_ID");
    expect(problem?.detail).toContain("R2_PRIVATE_BUCKET_NAME");
    expect(problem?.detail).not.toContain(VALID.endpoint);
    expect(problem?.detail).not.toContain(VALID.secretAccessKey);
  });
});

describe("validatePrivateR2Config - ENDPOINT_INVALID", () => {
  it.each([
    ["not a URL at all", { endpoint: "not a url" }],
    ["http instead of https", { endpoint: "http://test-account.r2.cloudflarestorage.com" }],
    ["embedded credentials", { endpoint: "https://user:pass@test-account.r2.cloudflarestorage.com" }],
    ["a query string", { endpoint: "https://test-account.r2.cloudflarestorage.com/?x=1" }],
    ["a fragment", { endpoint: "https://test-account.r2.cloudflarestorage.com/#section" }],
    ["a bucket path in the endpoint", { endpoint: "https://test-account.r2.cloudflarestorage.com/test-private-bucket" }],
    ["a non-R2 host", { endpoint: "https://test-account.s3.amazonaws.com" }],
    ["a lookalike host missing the r2 subdomain segment", { endpoint: "https://test-account.cloudflarestorage.com" }],
    ["an endpoint for a different account than R2_PRIVATE_ACCOUNT_ID", { endpoint: "https://someone-elses-account.r2.cloudflarestorage.com" }],
  ] as const)("%s", (_label, override) => {
    const problem = validatePrivateR2Config({ ...VALID, ...override });
    expect(problem?.category).toBe("ENDPOINT_INVALID");
  });

  it("never includes the actual configured endpoint value in `detail`", () => {
    const problem = validatePrivateR2Config({ ...VALID, endpoint: "https://wrong-account.r2.cloudflarestorage.com" });
    expect(problem?.detail).not.toContain("wrong-account");
    expect(problem?.detail).not.toContain("r2.cloudflarestorage.com");
  });
});

describe("validatePrivateR2Config - CONFIG_INVALID", () => {
  it.each([
    ["a full URL", { bucketName: "https://evil.example.com/steal-this-bucket" }],
    ["a scheme-only prefix", { bucketName: "s3://test-private-bucket" }],
    ["a path separator", { bucketName: "test/private/bucket" }],
    ["internal whitespace", { bucketName: "test private bucket" }],
    ["uppercase characters (not a valid S3/R2 bucket name)", { bucketName: "Test-Private-Bucket" }],
    ["an underscore (not a valid S3/R2 bucket name)", { bucketName: "test_private_bucket" }],
    ["too short to be a valid bucket name", { bucketName: "ab" }],
  ] as const)("bucket name is %s", (_label, override) => {
    const problem = validatePrivateR2Config({ ...VALID, ...override });
    expect(problem?.category).toBe("CONFIG_INVALID");
  });

  it.each([
    ["zero", 0],
    ["negative", -900],
    ["below the 60s minimum", 30],
    ["above the 7-day maximum", 8 * 24 * 60 * 60],
    ["not finite (NaN)", Number.NaN],
    ["not finite (Infinity)", Number.POSITIVE_INFINITY],
  ] as const)("signed URL expiry is %s", (_label, value) => {
    const problem = validatePrivateR2Config({ ...VALID, signedUrlExpiresSeconds: value });
    expect(problem?.category).toBe("CONFIG_INVALID");
  });

  it("never includes the actual configured bucket name in `detail`", () => {
    const problem = validatePrivateR2Config({ ...VALID, bucketName: "https://evil.example.com/my-real-bucket-name" });
    expect(problem?.detail).not.toContain("my-real-bucket-name");
    expect(problem?.detail).not.toContain("evil.example.com");
  });
});

describe("validatePrivateR2Config - precedence and no credential leakage", () => {
  it("reports CONFIG_MISSING before ever inspecting endpoint/bucket shape when both are absent", () => {
    const problem = validatePrivateR2Config({ ...VALID, endpoint: "", bucketName: "not-checked://either" });
    expect(problem?.category).toBe("CONFIG_MISSING");
  });

  it("never includes the secret access key or access key ID in any problem's `detail`, for any failure path", () => {
    const scenarios: R2PrivateConfigInput[] = [
      { ...VALID, accountId: "" },
      { ...VALID, endpoint: "not a url" },
      { ...VALID, bucketName: "bad/bucket" },
      { ...VALID, signedUrlExpiresSeconds: -1 },
    ];
    for (const scenario of scenarios) {
      const problem = validatePrivateR2Config(scenario);
      expect(problem).not.toBeNull();
      expect(problem?.detail).not.toContain(VALID.secretAccessKey);
      expect(problem?.detail).not.toContain(VALID.accessKeyId);
      expect(JSON.stringify(problem)).not.toContain(VALID.secretAccessKey);
    }
  });
});
