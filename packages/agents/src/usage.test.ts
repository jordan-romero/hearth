import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { dollars, usageOf, addUsage, noUsage } from "./usage.js";

const reply = (usage: unknown) => ({ usage }) as Anthropic.Message;

describe("usageOf", () => {
  it("reads input, output and both cache figures", () => {
    expect(
      usageOf(
        reply({
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        }),
      ),
    ).toEqual({ input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
  });

  it("treats absent cache figures as zero — an uncached call", () => {
    expect(usageOf(reply({ input_tokens: 5, output_tokens: 1 }))).toEqual({
      input: 5,
      output: 1,
      cacheWrite: 0,
      cacheRead: 0,
    });
  });

  it("reports zeros rather than throwing when a reply carries no usage", () => {
    // Counting a call must never break the call it counts.
    expect(usageOf(reply(undefined))).toEqual(noUsage());
  });
});

describe("dollars", () => {
  it("prices a cached read far below the same tokens uncached", () => {
    const uncached = dollars({
      input: 400_000,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    });
    const cached = dollars({
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 400_000,
    });
    expect(uncached).toBeCloseTo(0.8, 5);
    expect(cached).toBeCloseTo(0.08, 5);
  });

  it("adds up a run of calls", () => {
    const one = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
    expect([one, one, one].reduce(addUsage, noUsage())).toEqual({
      input: 3,
      output: 6,
      cacheWrite: 9,
      cacheRead: 12,
    });
  });
});
