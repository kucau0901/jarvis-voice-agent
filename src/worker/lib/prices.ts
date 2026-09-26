/**
 * What OpenAI charges, for the usage panel's estimates (lib/usage.ts).
 *
 * From developers.openai.com/api/docs/pricing on 26 Sep 2026, in US dollars
 * per million tokens. These are estimates: OpenAI's own usage page is the
 * bill. A model not listed shows its tokens and no cost, rather than a guess.
 */

export const PRICES_AS_OF = "2026-09-26";

export interface TokenPrice {
  input: number;
  cached: number;
  /** Writing the prompt cache; models without a separate price are charged as input. */
  write?: number;
  output: number;
}

export const TOKEN_PRICES: Readonly<Record<string, TokenPrice>> = {
  "gpt-6-astra": { input: 10, cached: 1, write: 12.5, output: 50 },
  "gpt-6-sol": { input: 2, cached: 0.2, write: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, write: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, write: 5, output: 20 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, write: 0.25, output: 1.2 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, write: 2.5, output: 12 },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
};

/** GPT-Live, by the minute the session is open. */
export const LIVE_PER_MINUTE = 0.05;

/** The web search tool: $10 a thousand calls, beside the tokens it adds. */
export const WEB_SEARCH_PER_CALL = 0.01;

/**
 * The price of a model id: exact, then without a date suffix
 * ("gpt-6-luna-2026-09-01"), else null.
 */
export function priceOf(model: string): TokenPrice | null {
  const m = model.trim().toLowerCase();
  return TOKEN_PRICES[m] ?? TOKEN_PRICES[m.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? null;
}
