// What a model call cost, logged where it happens.
//
// Nothing records spend, so "what did last session cost?" meant reconstructing it from token
// counts in the database. These lines make it a grep. Deliberately not a table: per-call rows are
// worth having when someone is billed per campaign, and this is the cheap 90%.

import type Anthropic from "@anthropic-ai/sdk";

/** Dollars per million tokens, Sonnet. Cache writes cost more than plain input; reads far less. */
export const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const noUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
});

/** One reply's usage. The cache fields are optional in the SDK's type and absent when unused.
 * Counting must never break the call it's counting, so a reply without usage reports zeros. */
export function usageOf(msg: Anthropic.Message): Usage {
  const u = msg.usage as
    | (Anthropic.Usage & {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      })
    | undefined;
  if (!u) return noUsage();
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

export function dollars(u: Usage): number {
  return (
    (u.input * PRICE.input +
      u.output * PRICE.output +
      u.cacheWrite * PRICE.cacheWrite +
      u.cacheRead * PRICE.cacheRead) /
    1_000_000
  );
}

/** `[label] what it was | in=… cacheWrite=… cacheRead=… out=… $0.12` — one greppable line. */
export function logUsage(label: string, u: Usage, about?: string): void {
  console.log(
    `[${label}]${about ? ` ${about} |` : ""} in=${u.input} ` +
      `cacheWrite=${u.cacheWrite} cacheRead=${u.cacheRead} out=${u.output} ` +
      `$${dollars(u).toFixed(4)}`,
  );
}
