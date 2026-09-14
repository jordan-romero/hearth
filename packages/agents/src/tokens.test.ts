import { describe, it, expect } from "vitest";
import { tokenImageType } from "./tokens.js";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif = Buffer.from("GIF89a....", "latin1");
const webp = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "latin1"),
]);
const html = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

describe("tokenImageType — what a player may upload as a token", () => {
  it("accepts each supported image when the bytes match the declared type", () => {
    expect(tokenImageType("image/png", png)).toBe("png");
    expect(tokenImageType("image/jpeg", jpg)).toBe("jpg");
    expect(tokenImageType("image/gif", gif)).toBe("gif");
    expect(tokenImageType("image/webp", webp)).toBe("webp");
  });

  it("ignores case and parameters on the declared type", () => {
    expect(tokenImageType("IMAGE/PNG; charset=binary", png)).toBe("png");
  });

  it("refuses a file whose bytes don't match what it claims to be", () => {
    expect(tokenImageType("image/png", html)).toBeNull();
    expect(tokenImageType("image/png", jpg)).toBeNull();
    expect(
      tokenImageType("image/webp", Buffer.from("RIFF1234WAVE")),
    ).toBeNull();
  });

  it("refuses SVG, which can carry script", () => {
    expect(tokenImageType("image/svg+xml", svg)).toBeNull();
  });

  it("refuses an upload with no declared type or no bytes", () => {
    expect(tokenImageType(null, png)).toBeNull();
    expect(tokenImageType(undefined, png)).toBeNull();
    expect(tokenImageType("image/png", Buffer.alloc(0))).toBeNull();
  });
});
