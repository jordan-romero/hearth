import { describe, it, expect } from "vitest";
import { RevealDrafts } from "./reveal-drafts.js";

const t0 = 1_000_000;
const min = 60_000;

describe("RevealDrafts", () => {
  it("gives back the question the button was made for", () => {
    const drafts = new RevealDrafts();
    drafts.put("a1", "How did Morwyn's mother die?", "camp1", t0);
    expect(drafts.get("a1", "camp1", t0 + min)?.question).toBe(
      "How did Morwyn's mother die?",
    );
  });

  it("never hands a draft to another campaign", () => {
    // One Discord account can run two tables; a button clicked at one must not look something up
    // in the other's library.
    const drafts = new RevealDrafts();
    drafts.put("a1", "Who runs the docks?", "camp1", t0);
    expect(drafts.get("a1", "camp2", t0)).toBeNull();
    expect(drafts.get("a1", "camp1", t0)).not.toBeNull();
  });

  it("forgets a draft nobody came back for", () => {
    const drafts = new RevealDrafts(10 * min);
    drafts.put("a1", "anything", "camp1", t0);
    expect(drafts.get("a1", "camp1", t0 + 11 * min)).toBeNull();
  });

  it("keeps a draft alive while the DM is still working through it", () => {
    // Reading it refreshes it: a DM who reveals one thing, reads on, and reveals another
    // shouldn't lose the button halfway down a long briefing.
    const drafts = new RevealDrafts(10 * min);
    drafts.put("a1", "anything", "camp1", t0);
    drafts.get("a1", "camp1", t0 + 9 * min);
    expect(drafts.get("a1", "camp1", t0 + 17 * min)).not.toBeNull();
  });

  it("sweeps what has expired and leaves the rest", () => {
    const drafts = new RevealDrafts(10 * min);
    drafts.put("old", "q", "camp1", t0);
    drafts.put("new", "q", "camp1", t0 + 20 * min);
    expect(drafts.sweep(t0 + 21 * min)).toBe(1);
    expect(drafts.size).toBe(1);
  });

  it("an unknown id is simply gone, not an error", () => {
    // Restarts drop every draft; the button still exists on the message.
    expect(new RevealDrafts().get("nope", "camp1", t0)).toBeNull();
  });
});
