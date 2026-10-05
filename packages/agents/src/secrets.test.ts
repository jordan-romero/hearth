import { describe, it, expect, beforeAll } from "vitest";
import { openSecret, sealSecret } from "./secrets.js";

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-secret-for-sealing";
});

describe("sealSecret / openSecret", () => {
  it("round-trips", () => {
    const sealed = sealSecret("refresh-token-123", "onenote");
    expect(sealed).not.toContain("refresh-token-123");
    expect(openSecret(sealed, "onenote")).toBe("refresh-token-123");
  });

  it("never seals the same value the same way twice", () => {
    expect(sealSecret("x", "p")).not.toBe(sealSecret("x", "p"));
  });

  it("refuses a value sealed for another purpose", () => {
    expect(() => openSecret(sealSecret("x", "a"), "b")).toThrow();
  });

  it("refuses a tampered value", () => {
    const parts = sealSecret("secret", "p").split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString("base64url");
    expect(() => openSecret(parts.join("."), "p")).toThrow();
  });
});
