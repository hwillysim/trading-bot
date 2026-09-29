import test from "node:test";
import assert from "node:assert/strict";
import { JevClient } from "../src/models/jev.ts";
import { OpenAIReviewer } from "../src/models/reviewer.ts";
import type { MarketFeatures, RiskCaps, StrategyConfig } from "../src/shared/types.ts";

const features: MarketFeatures = {
  symbol: "BTCUSDT", ts: 1_800_000_000_000, last: 60_000, bid: 59_999, ask: 60_001,
  bidQty: 1, askQty: 1.2, quoteVolume24h: 1_000_000, priceChangePercent24h: 0.5,
  return15s: 0.1, return1m: 0.2, return5m: 0.4, volatility1m: 0.1,
  relativeVolume1m: 1.1, buyFlow1m: 0.6, sellFlow1m: 0.4, spreadBps: 0.3,
  bookImbalance: -0.1, depthUsdt: 20_000, estimatedSlippageBps: 0.2,
  tradeQty: 0.02, tradeBuyerIsMaker: true,
};

const jevAnswers = {
  continuation: { type: "noul", noul: 0.7 }, reversal: { type: "noul", noul: 0.2 },
  wait: { type: "noul", noul: 0.1 }, setup: { type: "score", score: 3.1, confidence: 0.8, legend: {}, probabilities: {} },
};

test("Jev sends one symbol state with pinned model and several typed questions", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new JevClient({ apiKey: "test-secret", fetchImpl: async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ model: "jev-1.13.0", answers: jevAnswers, usage: { input_tokens: 100, output_tokens: 4 } });
  } });
  const result = await client.assess(features,120);
  assert.equal(sent?.model, "jev-1.13.0");
  assert.equal((sent?.state as Record<string, unknown>).tradeBuyerIsMaker, undefined);
  assert.equal((sent?.state as Record<string, unknown>).tradeQty, undefined);
  assert.equal((sent?.state as Record<string, unknown>).symbol, "BTCUSDT");
  assert.equal((sent?.state as Record<string, unknown>).last, features.last);
  assert.equal(Object.keys(sent?.questions as object).length, 4);
  assert.equal(result.continuationProbability, 0.7);
  assert.equal(result.horizonSeconds,120);
  assert.match(String((sent?.questions as Record<string,{instructions:string}>).continuation?.instructions),/120 seconds/);
  assert.equal(result.inputTokens, 100);
  assert.ok(Math.abs(result.costUsd - 0.0000042) < 1e-12);
});

test("Jev surfaces retry timing for rate limits without exposing credentials", async () => {
  const client = new JevClient({ apiKey: "do-not-log", fetchImpl: async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }) });
  await assert.rejects(client.assess(features), error => {
    assert.match((error as Error).message, /429/);
    assert.equal((error as { retryAfterMs?: number }).retryAfterMs, 2_000);
    assert.doesNotMatch((error as Error).message, /do-not-log/);
    return true;
  });
});

test("Jev rejects malformed probabilities", async () => {
  const client = new JevClient({ apiKey: "x", fetchImpl: async () => Response.json({ model: "jev-1.13.0", answers: { ...jevAnswers, wait: { type: "noul", noul: 1.5 } }, usage: { input_tokens: 2, output_tokens: 1 } }) });
  await assert.rejects(client.assess(features), /invalid assessment values/i);
});

const strategy: StrategyConfig = { version: 1, entryConfidence: 0.8, continuationProbability: 0.7, reversalExitProbability: 0.65, costBufferBps: 2, targetHoldSeconds: 30, positionFraction: 0.02, selectedSymbols: ["BTCUSDT"] };
const caps: RiskCaps = { floatUsdt: 1_000, maxOrderUsdt: 100, dailyLossStopUsdt: 50, dailyApiSpendUsd: 5, maxHoldSeconds: 90, maxPositions: 2 };

function reviewerFetch(value: unknown) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.model, "gpt-6-luna");
    assert.equal(sent.store, false);
    assert.equal(sent.text.format.type, "json_schema");
    return Response.json({ model: "gpt-6-luna", output_text: JSON.stringify(value), usage: { input_tokens: 200, output_tokens: 30 } });
  };
}

test("reviewer returns a bounded patch and accounts for usage", async () => {
  const reviewer = new OpenAIReviewer({ apiKey: "test-secret", fetchImpl: reviewerFetch({ action: "patch", reason: "Evidence supports a small adjustment.", summary: "Raise the confidence threshold", patch: { entryConfidence: 0.999, continuationProbability: null, reversalExitProbability: null, costBufferBps: null, targetHoldSeconds: null, positionFraction: 0.8, selectedSymbols: ["ETHUSDT"] } }) });
  const result = await reviewer.review({ strategy, caps, metrics: { closedTrades: 100 }, candidates: ["BTCUSDT", "ETHUSDT"] });
  assert.equal(result.action, "patch");
  assert.equal(result.patch?.entryConfidence, 0.99);
  assert.equal(result.patch?.positionFraction, 0.1);
  assert.deepEqual(result.patch?.selectedSymbols, ["ETHUSDT"]);
  assert.equal(result.inputTokens, 200);
  assert.ok(Math.abs(result.costUsd - 0.000035) < 1e-12);
  assert.match(result.summary, /\.$/);
});

test("reviewer accepts no_change when evidence is weak", async () => {
  const reviewer = new OpenAIReviewer({ apiKey: "x", fetchImpl: reviewerFetch({ action: "no_change", reason: "Only three trades are available.", summary: "Keep the current strategy.", patch: { entryConfidence: null, continuationProbability: null, reversalExitProbability: null, costBufferBps: null, targetHoldSeconds: null, positionFraction: null, selectedSymbols: null } }) });
  const result = await reviewer.review({ strategy, caps, metrics: { closedTrades: 3 }, candidates: ["BTCUSDT"] });
  assert.equal(result.action, "no_change");
  assert.equal(result.inputTokens, 200);
  assert.equal(result.patch, undefined);
});

test("reviewer rejects symbols outside the supplied candidate list", async () => {
  const reviewer = new OpenAIReviewer({ apiKey: "x", fetchImpl: reviewerFetch({ action: "patch", reason: "Test.", summary: "Change symbols.", patch: { entryConfidence: null, continuationProbability: null, reversalExitProbability: null, costBufferBps: null, targetHoldSeconds: null, positionFraction: null, selectedSymbols: ["UNKNOWN"] } }) });
  await assert.rejects(reviewer.review({ strategy, caps, metrics: {}, candidates: ["BTCUSDT"] }), /outside the candidate list/i);
});
