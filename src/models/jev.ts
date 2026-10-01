import type { JevAssessment, MarketFeatures, JevContext } from "../shared/types.ts";
import { RETURN_BANDS } from '../core/adaptive.ts';
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

  async assess(features: MarketFeatures, horizonSeconds=60, context?:JevContext, externalSignal?:AbortSignal): Promise<JevAssessment> {
    const apiKey = this.options.apiKey ?? process.env.JEV_API_KEY;
    if (!apiKey) throw new ModelError("JEV_API_KEY is required");
    validateFeatures(features);
    if(!Number.isInteger(horizonSeconds)||horizonSeconds<1||horizonSeconds>900) throw new ModelError("Invalid assessment horizon");
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new ModelError("Invalid Jev timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const questions:Record<string,unknown> = {
      continuation: { type: "noul", instructions: `Is persistent buying pressure likely to drive an upward price move over the next ${horizonSeconds} seconds?` },
      reversal: { type: "noul", instructions: `Is a short-term reversal more likely than continuation over the next ${horizonSeconds} seconds?` },
      wait: { type: "noul", instructions: "Is waiting preferable because the short-term signal is weak or conflicting?" },
      setup: { type: "score", instructions: "Rate the quality of this short-term trading setup.", criteria: ["poor or conflicting", "weak", "moderate", "strong", "very strong"] },
    };
    if(context) {
      questions.clearsCosts={type:'noul',instructions:`Will the mid-price rise by more than ${context.roundTripCostBps.toFixed(2)} basis points over the next ${horizonSeconds} seconds?`};
      questions.exhaustion={type:'noul',instructions:'Does the recent sequence show buying pressure becoming exhausted?'};
      for(const horizon of [30,60,120]) {questions[`clears${horizon}`]={type:'noul',instructions:`Will the mid-price rise by more than ${context.roundTripCostBps.toFixed(2)} basis points over the next ${horizon} seconds?`};questions[`return${horizon}`]={type:'choice',instructions:`Which mid-price return band is most likely over the next ${horizon} seconds? Judge the supplied recent sequence and market context.`,criteria:Object.fromEntries(Object.entries(RETURN_BANDS).map(([key,value])=>[key,value.description]))};}
    }
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint ?? ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: context?{...marketState(features),historySeconds:features.historySeconds,volatility5sBps:features.volatility5sBps,buyFlow5s:features.buyFlow5s,sellFlow5s:features.sellFlow5s,btcReturn15s:features.btcReturn15s,ethReturn15s:features.ethReturn15s,recentPath:features.recentPath,trade:context}:marketState(features), questions }),
        signal: externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal,
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
      let forecasts:JevAssessment['forecasts'];
      let clearsCostsProbability:number|undefined,exhaustionProbability:number|undefined;
      if(context) {
        const clear=body.answers.clearsCosts,exhaustion=body.answers.exhaustion;
        if(!isRecord(clear)||!isRecord(exhaustion)||!probability(clear.noul)||!probability(exhaustion.noul)) throw new ModelError('Jev omitted valid cost and exhaustion answers');
        clearsCostsProbability=clear.noul;exhaustionProbability=exhaustion.noul;
        const forecastAnswers=body.answers;
        forecasts=[30,60,120].map(horizon=>{
          const answer=forecastAnswers[`return${horizon}`],clear=forecastAnswers[`clears${horizon}`];
          if(!isRecord(clear)||!probability(clear.noul))throw new ModelError('Jev omitted horizon cost probability');
          if(!isRecord(answer)||!isRecord(answer.probabilities)) throw new ModelError('Jev omitted return probabilities');
          const probabilities=answer.probabilities;
          if(Object.keys(probabilities).length!==Object.keys(RETURN_BANDS).length||Object.entries(probabilities).some(([key,value])=>!RETURN_BANDS[key]||!probability(value))) throw new ModelError('Jev returned invalid forecast bands');
          const total=Object.values(probabilities).reduce<number>((sum,value)=>sum+Number(value),0);
          if(Math.abs(total-1)>0.03) throw new ModelError('Jev forecast probabilities do not sum to one');
          const normalised=Object.fromEntries(Object.entries(probabilities).map(([key,value])=>[key,Number(value)/total]));
          return {horizonSeconds:horizon,clearsCostsProbability:clear.noul,probabilities:normalised,expectedGrossBps:Object.entries(normalised).reduce((sum,[key,value])=>sum+RETURN_BANDS[key]!.bps*value,0)};
        });
      }
      const tokenUsage = usage(body.usage.input_tokens, body.usage.output_tokens);
      const durationMs = Date.now() - started;
      return {
        symbol: features.symbol, ts: features.ts, horizonSeconds, model: typeof body.model === "string" ? body.model : MODEL,
        continuationProbability, reversalProbability,
        waitProbability, setupScore, setupConfidence, latencyMs: durationMs,
        inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens,
        costUsd: tokenUsage.inputTokens * jevPrice() / 1_000_000, raw: body, forecasts,clearsCostsProbability,exhaustionProbability,
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
