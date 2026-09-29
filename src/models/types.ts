export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelCallMeta = {
  model: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  durationMs: number;
};

export class ModelError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function boundedText(value: unknown, max = 2_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ModelError(`Model returned invalid JSON (HTTP ${response.status})`, response.status);
  }
}

export function usage(input: unknown, output: unknown): TokenUsage {
  if (!Number.isInteger(input) || (input as number) < 0 || !Number.isInteger(output) || (output as number) < 0) {
    throw new ModelError("Model response contained invalid token usage");
  }
  return { inputTokens: input as number, outputTokens: output as number, totalTokens: (input as number) + (output as number) };
}
