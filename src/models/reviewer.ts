import { STRATEGY_BOUNDS, validateStrategyPatch } from '../core/controller.ts';
import { DEFAULT_STRATEGY } from '../core/defaults.ts';
import type { ReviewProposal, RiskCaps, StrategyConfig } from "../shared/types.ts";
import { boundedText, isRecord, ModelError, readJson, usage } from "./types.ts";

const ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-6-luna";
const INPUT_USD_PER_MILLION = 0.1;
const OUTPUT_USD_PER_MILLION = 0.5;
function priceFromEnv(name:string,fallback:number):number { const value=process.env[name];if(!value)return fallback;const price=Number(value);if(!Number.isFinite(price)||price<0)throw new ModelError(`Invalid ${name}`);return price; }
type ReviewInput = { strategy: StrategyConfig; caps: RiskCaps; metrics: unknown; candidates: string[] };
type ReviewBody = { action: "no_change" | "patch"; reason: string; summary: string; patch: Record<string, unknown> };
const schema = {
 type:'object',additionalProperties:false,properties:{
  action:{type:'string',enum:['no_change','patch']},reason:{type:'string'},summary:{type:'string'},
  patch:{type:'object',additionalProperties:false,properties:Object.fromEntries(Object.keys(STRATEGY_BOUNDS).map(key=>[key,{type:[key==='targetHoldSeconds'?'integer':'number','null']}])),required:Object.keys(STRATEGY_BOUNDS)},
 },required:['action','reason','summary','patch'],
};
function validateAndBound(result:ReviewBody,input:ReviewInput):ReviewProposal {
 if(!isRecord(result)||(result.action!=='no_change'&&result.action!=='patch')||!boundedText(result.reason,400)||!boundedText(result.summary,240)||!isRecord(result.patch))throw new ModelError('Reviewer returned an invalid proposal');
 const base={action:result.action,reason:result.reason,summary:oneSentence(result.summary),inputTokens:0,outputTokens:0,costUsd:0,model:''};
 if(result.action==='no_change')return base;
 if(Object.keys(result.patch).some(key=>!Object.hasOwn(STRATEGY_BOUNDS,key)))throw new ModelError('Reviewer proposed an unsupported config field');
 const patch=Object.fromEntries(Object.entries(result.patch).filter(([,value])=>value!==null)) as Partial<StrategyConfig>;
 if(!validateStrategyPatch({...DEFAULT_STRATEGY,...input.strategy},patch))throw new ModelError('Reviewer proposed an invalid or excessive strategy change');
 return {...base,patch};
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

  async review(input: ReviewInput, externalSignal?:AbortSignal): Promise<ReviewProposal> {
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
          model, store: false, reasoning: { effort: "none" }, max_output_tokens: 600,
          instructions: "Choose the next small shadow strategy trial using only the compact precomputed scorecard and recent trial history. Avoid repeating failed trials. You control at most two fields within supplied bounds and maximum step sizes. All arithmetic, risk controls, evidence gates and promotions are handled by code. Negative results may justify testing stronger volume/flow filters or narrower spreads. Adjust volatilityMultiple only when paired stop comparisons have at least 20 covered observations across five time blocks and a positive lower bound on improvement. Do not lower continuation or cost buffers simply to force trades. Sparse filter cells and forecast scores do not establish profitability. Prefer no_change when a useful experiment is unsupported. Do not change order size, balances, fees, API budget, loss limits or live mode. Trials are shadow only; code promotes only after 30 eligible fee-net outcomes in five blocks with lower net return above three bps. Use null for unchanged fields, a brief reason and a one-sentence summary.",
          input: JSON.stringify(input),
          text: { format: { type: "json_schema", name: "strategy_review", strict: true, schema } },
        }), signal: externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal,
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
