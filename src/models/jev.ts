import type { JevAssessment, MarketFeatures } from "../shared/types.ts";
import { finiteNumber, isRecord, ModelError, parseRetryAfter, readJson, usage } from "./types.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const INPUT_USD_PER_MILLION = 0.042;
const jevPrice=()=>priceFromEnv('JEV_INPUT_USD_PER_MILLION',INPUT_USD_PER_MILLION);
function priceFromEnv(name:string,fallback:number):number { const value=process.env[name];if(!value)return fallback;const price=Number(value);if(!Number.isFinite(price)||price<0)throw new ModelError(`Invalid ${name}`);return price; }

type Fetcher = typeof fetch;

function validateFeatures(features: MarketFeatures): void {
  if (!/^[A-Z0-9._:-]{1,24}$/i.test(features.symbol)) throw new ModelError("Invalid symbol");
  for (const key of NUMERIC_FEATURE_KEYS) {
    if (!finiteNumber(features[key])) throw new ModelError(`Market feature ${key} must be a finite number`);
  }
}

const NUMERIC_FEATURE_KEYS = [
  "ts", "last", "bid", "ask", "bidQty", "askQty", "quoteVolume24h", "priceChangePercent24h",
  "return15s", "return1m", "return5m", "volatility1m", "relativeVolume1m", "buyFlow1m", "sellFlow1m",
  "spreadBps", "bookImbalance", "depthUsdt", "estimatedSlippageBps",
] as const satisfies readonly (keyof MarketFeatures)[];

function marketState(features: MarketFeatures): Record<string, string | number> {
  return Object.fromEntries(["symbol", ...NUMERIC_FEATURE_KEYS].map(key => [key, features[key as keyof MarketFeatures]])) as Record<string, string | number>;
}

function probability(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

export class JevClient {
  private readonly options: { apiKey?: string; endpoint?: string; timeoutMs?: number; fetchImpl?: Fetcher };
  constructor(options: { apiKey?: string; endpoint?: string; timeoutMs?: number; fetchImpl?: Fetcher } = {}) { this.options = options; }

  async assess(features: MarketFeatures): Promise<JevAssessment> {
    const apiKey = this.options.apiKey ?? process.env.JEV_API_KEY;
    if (!apiKey) throw new ModelError("JEV_API_KEY is required");
    validateFeatures(features);
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new ModelError("Invalid Jev timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const questions = {
      continuation: { type: "noul", instructions: "Will the current short-term price pattern continue over the next 60 seconds?" },
      reversal: { type: "noul", instructions: "Is a short-term reversal more likely than continuation over the next 60 seconds?" },
      wait: { type: "noul", instructions: "Is waiting preferable because the short-term signal is weak or conflicting?" },
      setup: { type: "score", instructions: "Rate the quality of this short-term trading setup.", criteria: ["poor or conflicting", "weak", "moderate", "strong", "very strong"] },
    };
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint ?? ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: marketState(features), questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelError(`Jev request failed (HTTP ${response.status})`, response.status,
          response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined);
      }
      const body = await readJson(response);
      if (!isRecord(body) || !isRecord(body.answers) || !isRecord(body.usage) || !isRecord(body.answers.continuation) || !isRecord(body.answers.reversal) || !isRecord(body.answers.wait) || !isRecord(body.answers.setup)) {
        throw new ModelError("Jev response has an invalid shape");
      }
      const continuation = body.answers.continuation;
      const reversal = body.answers.reversal;
      const wait = body.answers.wait;
      const setup = body.answers.setup;
      const continuationProbability = continuation.noul;
      const reversalProbability = reversal.noul;
      const waitProbability = wait.noul;
      const setupConfidence = setup.confidence;
      const setupScore = setup.score;
      if (!probability(continuationProbability) || !probability(reversalProbability) || !probability(waitProbability) || !probability(setupConfidence) || !finiteNumber(setupScore) || setupScore < 0 || setupScore > 4) {
        throw new ModelError("Jev response contained invalid assessment values");
      }
      const tokenUsage = usage(body.usage.input_tokens, body.usage.output_tokens);
      const durationMs = Date.now() - started;
      return {
        symbol: features.symbol, ts: features.ts, model: typeof body.model === "string" ? body.model : MODEL,
        continuationProbability, reversalProbability,
        waitProbability, setupScore, setupConfidence, latencyMs: durationMs,
        inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens,
        costUsd: tokenUsage.inputTokens * jevPrice() / 1_000_000, raw: body,
      };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (controller.signal.aborted) throw new ModelError("Jev request timed out");
      throw new ModelError("Jev request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
