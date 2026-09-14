import { describe, it, expect } from "vitest";
import { channelKind, channelDocumentName } from "./channels.js";

describe("channelKind — which posts become table knowledge", () => {
  const settings = {
    factsChannelId: "c-facts",
    recapsChannelId: "c-recaps",
    loreChannelId: "c-lore",
  };

  it("recognises each designated channel", () => {
    expect(channelKind(settings, "c-facts")).toBe("facts");
    expect(channelKind(settings, "c-recaps")).toBe("recaps");
    expect(channelKind(settings, "c-lore")).toBe("lore");
  });

  it("ignores every other channel, so ordinary chat never enters the memory", () => {
    expect(channelKind(settings, "c-general")).toBeNull();
  });

  it("ignores everything when no channels are designated", () => {
    const none = {
      factsChannelId: null,
      recapsChannelId: null,
      loreChannelId: null,
    };
    expect(channelKind(none, "c-facts")).toBeNull();
  });
});

describe("channelDocumentName — how a post shows up in the library", () => {
  it("names the kind, the author, and the day", () => {
    expect(
      channelDocumentName("recaps", "Morwyn", new Date("2026-09-16T23:10:00Z")),
    ).toBe("Recap — Morwyn, 2026-09-16");
  });
});
