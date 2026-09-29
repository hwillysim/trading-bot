import type { ReviewProposal, RiskCaps, StrategyConfig } from "../shared/types.ts";
import { boundedText, finiteNumber, isRecord, ModelError, readJson, usage } from "./types.ts";

const ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-6-luna";
const INPUT_USD_PER_MILLION = 0.1;
const OUTPUT_USD_PER_MILLION = 0.5;
function priceFromEnv(name:string,fallback:number):number { const value=process.env[name];if(!value)return fallback;const price=Number(value);if(!Number.isFinite(price)||price<0)throw new ModelError(`Invalid ${name}`);return price; }
const ALLOWED_PATCH_KEYS = new Set([
  "entryConfidence", "continuationProbability", "reversalExitProbability", "costBufferBps",
  "targetHoldSeconds", "positionFraction", "selectedSymbols",
]);

type ReviewInput = { strategy: StrategyConfig; caps: RiskCaps; metrics: unknown; candidates: string[] };
type ReviewBody = { action: "no_change" | "patch"; reason: string; summary: string; patch: Record<string, unknown> };

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["no_change", "patch"] },
    reason: { type: "string" },
    summary: { type: "string" },
    patch: {
      type: "object", additionalProperties: false,
      properties: {
        entryConfidence: { type: ["number", "null"] }, continuationProbability: { type: ["number", "null"] },
        reversalExitProbability: { type: ["number", "null"] }, costBufferBps: { type: ["number", "null"] },
        targetHoldSeconds: { type: ["integer", "null"] }, positionFraction: { type: ["number", "null"] },
        selectedSymbols: { type: ["array", "null"], items: { type: "string" } },
      },
      required: ["entryConfidence", "continuationProbability", "reversalExitProbability", "costBufferBps", "targetHoldSeconds", "positionFraction", "selectedSymbols"],
    },
  }, required: ["action", "reason", "summary", "patch"],
} as const;

function validateAndBound(result: ReviewBody, input: ReviewInput): ReviewProposal {
  if (!isRecord(result) || (result.action !== "no_change" && result.action !== "patch") || !boundedText(result.reason, 1_000) || !boundedText(result.summary, 240) || !isRecord(result.patch)) {
    throw new ModelError("Reviewer returned an invalid proposal");
  }
  if (result.action === "no_change") return { action: "no_change", reason: result.reason, summary: oneSentence(result.summary), inputTokens: 0, outputTokens: 0, costUsd: 0, model: "" };

  const patch: NonNullable<ReviewProposal["patch"]> = {};
  for (const key of Object.keys(result.patch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) throw new ModelError("Reviewer proposed an unsupported config field");
  }
  const numericRanges: Record<string, [number, number]> = {
    entryConfidence: [0.5, 0.99], continuationProbability: [0.5, 0.99],
    reversalExitProbability: [0.5, 0.99], costBufferBps: [0, 500],
    targetHoldSeconds: [1, Math.min(3_600, input.caps.maxHoldSeconds)],
    positionFraction: [0, Math.min(1, input.caps.maxOrderUsdt / Math.max(input.caps.floatUsdt, 1))],
  };
  for (const [key, value] of Object.entries(result.patch)) {
    if (value === null) continue;
    if (key === "selectedSymbols") {
      if (!Array.isArray(value) || value.length > 20 || value.some(symbol => typeof symbol !== "string" || !input.candidates.includes(symbol))) throw new ModelError("Reviewer selected symbols outside the candidate list");
      patch.selectedSymbols = [...new Set(value as string[])];
      continue;
    }
    const bounds = numericRanges[key];
    if (!bounds || !finiteNumber(value) || (key === "targetHoldSeconds" && !Number.isInteger(value))) throw new ModelError("Reviewer proposed an invalid config value");
    const bounded = Math.max(bounds[0], Math.min(bounds[1], value));
    if (key === "entryConfidence") patch.entryConfidence = bounded;
    else if (key === "continuationProbability") patch.continuationProbability = bounded;
    else if (key === "reversalExitProbability") patch.reversalExitProbability = bounded;
    else if (key === "costBufferBps") patch.costBufferBps = bounded;
    else if (key === "targetHoldSeconds") patch.targetHoldSeconds = bounded;
    else if (key === "positionFraction") patch.positionFraction = bounded;
  }
  if (!Object.keys(patch).length) throw new ModelError("Reviewer returned an empty patch");
  return { action: "patch", reason: result.reason, summary: oneSentence(result.summary), patch, inputTokens: 0, outputTokens: 0, costUsd: 0, model: "" };
}

function oneSentence(text: string): string {
  const sentence = text.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function responseText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      const block = item.content.find(value => isRecord(value) && value.type === "output_text" && typeof value.text === "string");
      if (isRecord(block) && typeof block.text === "string") return block.text;
    }
  }
  throw new ModelError("OpenAI response omitted structured output");
}

export class OpenAIReviewer {
  private readonly options: { apiKey?: string; model?: string; endpoint?: string; timeoutMs?: number; fetchImpl?: typeof fetch };
  constructor(options: { apiKey?: string; model?: string; endpoint?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) { this.options = options; }

  async review(input: ReviewInput): Promise<ReviewProposal> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ModelError("OPENAI_API_KEY is required");
    if (!Array.isArray(input.candidates) || input.candidates.length > 100 || input.candidates.some(item => typeof item !== "string" || item.length > 24)) throw new ModelError("Invalid reviewer candidates");
    const model = this.options.model ?? process.env.OPENAI_REVIEW_MODEL ?? DEFAULT_MODEL;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new ModelError("Invalid reviewer model");
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new ModelError("Invalid reviewer timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint ?? ENDPOINT, {
        method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model, store: false,
          instructions: "Review the strategy using the supplied recent performance metrics, hypothetical outcomes grouped by symbol and market regime, and symbol candidates. Treat exploratory paper results as experimental and never claim they establish profitability. Return no_change if evidence is weak, sparse, noisy, or inconclusive. Otherwise propose the smallest bounded strategy patch. Do not change the paper exploration gate or supplied risk caps. Select symbols only from candidates. Give a one-sentence summary.",
          input: JSON.stringify(input),
          text: { format: { type: "json_schema", name: "strategy_review", strict: true, schema } },
        }), signal: controller.signal,
      });
      if (!response.ok) throw new ModelError(`OpenAI reviewer failed (HTTP ${response.status})`, response.status);
      const body = await readJson(response);
      if (!isRecord(body) || !isRecord(body.usage)) throw new ModelError("OpenAI response has an invalid shape");
      const parsed: unknown = JSON.parse(responseText(body));
      const proposal = validateAndBound(parsed as ReviewBody, input);
      const tokenUsage = usage(body.usage.input_tokens, body.usage.output_tokens);
      const costUsd = tokenUsage.inputTokens * priceFromEnv('OPENAI_INPUT_USD_PER_MILLION',INPUT_USD_PER_MILLION) / 1_000_000 + tokenUsage.outputTokens * priceFromEnv('OPENAI_OUTPUT_USD_PER_MILLION',OUTPUT_USD_PER_MILLION) / 1_000_000;
      return { ...proposal, inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens, costUsd, model: typeof body.model === "string" ? body.model : model };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (controller.signal.aborted) throw new ModelError("OpenAI reviewer timed out");
      if (error instanceof SyntaxError) throw new ModelError("OpenAI reviewer returned invalid structured JSON");
      throw new ModelError("OpenAI reviewer request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
