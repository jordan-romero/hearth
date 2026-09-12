import { describe, it, expect } from "vitest";
import { keepVisible } from "./corrections.js";

// A correction may only ever touch facts its proposer could already see. Retrieval enforces
// that when building candidates; this guard enforces it again on the way back out, because
// what comes back is model output and model output is not trusted.
describe("keepVisible", () => {
  const visible = ["u1", "u2", "u3"];

  it("keeps the facts that were actually offered", () => {
    const out = keepVisible([{ id: "u1", rewrite: "fixed" }], visible);
    expect(out).toEqual([{ id: "u1", rewrite: "fixed" }]);
  });

  it("drops an id that was never a candidate — the leak this exists to prevent", () => {
    const out = keepVisible(
      [
        { id: "u2", rewrite: "fixed" },
        { id: "dm-only-secret", rewrite: "tampered" },
      ],
      visible,
    );
    expect(out).toEqual([{ id: "u2", rewrite: "fixed" }]);
  });

  it("drops everything when nothing was visible", () => {
    expect(keepVisible([{ id: "u1", rewrite: "x" }], [])).toEqual([]);
  });

  it("handles the model naming nothing", () => {
    expect(keepVisible([], visible)).toEqual([]);
  });
});
