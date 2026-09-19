import type {
  CapabilityManifest,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevRawResponse,
  JevRouteQuestion,
  JevScoreAnswer,
  JevProvider,
  JevRouteRequest,
} from "./types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp, sha256 } from "./utils.js";

export const DEFAULT_TOOL_QUESTION = "tool";
export const DEFAULT_QUESTION_INSTRUCTIONS = "Which single capability should handle this request? Choose only from the supplied options.";

/** Build the questions payload: the caller-supplied batch, or the single default tool question.
 * Supports all three Jev primitives (Choice, Score, Noul) per the TypeSafe docs. */
function buildQuestions(request: JevRouteRequest): Record<string, Record<string, unknown>> {
  const requested: Record<string, JevRouteQuestion> = request.questions ?? { [DEFAULT_TOOL_QUESTION]: {} };
  return Object.fromEntries(
    Object.entries(requested).map(([key, question]) => {
      const type = question.type ?? "choice";
      if (type === "score") {
        if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
          throw new Error(`questions.${key}: score questions require a non-empty criteria array of ordered levels`);
        }
        return [key, { type: "score", instructions: question.instructions ?? DEFAULT_QUESTION_INSTRUCTIONS, criteria: question.criteria }];
      }
      if (type === "noul") {
        const payload: Record<string, unknown> = { type: "noul", instructions: question.instructions ?? DEFAULT_QUESTION_INSTRUCTIONS };
        if (question.criteria !== undefined) payload.criteria = question.criteria;
        return [key, payload];
      }
      const criteria = question.criteria ?? Object.fromEntries(
        request.candidates.map((candidate) => [candidate.id, describeCapability(candidate)]),
      );
      if (Object.keys(criteria).length === 0) {
        throw new Error(`questions.${key}: choice questions need at least one criterion (supply candidates or an explicit criteria map)`);
      }
      return [key, { type: "choice", instructions: question.instructions ?? DEFAULT_QUESTION_INSTRUCTIONS, criteria }];
    }),
  );
}

export class JevProviderError extends Error {
  constructor(
    public readonly code: "jev_auth_error" | "jev_timeout" | "jev_malformed_response" | "jev_http_error",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "JevProviderError";
  }
}

export interface HttpJevProviderOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export class HttpJevProvider implements JevProvider {
  readonly name = "typesafe";
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpJevProviderOptions) {
    this.endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    this.model = options.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: request.state,
        model: request.model ?? this.model,
        questions: buildQuestions(request),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new JevProviderError("jev_timeout", `Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw new JevProviderError("jev_http_error", error instanceof Error ? error.message : String(error));
    });

    if (response.status === 401 || response.status === 403) {
      throw new JevProviderError("jev_auth_error", "Jev provider rejected the API key", response.status);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new JevProviderError("jev_http_error", `Jev provider returned HTTP ${response.status}: ${body.slice(0, 240)}`, response.status);
    }
    const raw = (await response.json()) as unknown;
    if (!isJevRawResponse(raw)) throw new JevProviderError("jev_malformed_response", "Jev response is not an object");
    return raw;
  }
}

/** OpenRouter's native Decisions adapter. It uses the same typed request/response
 * shape as TypeSafe's endpoint, but through OpenRouter's alpha decisions route. */
export class OpenRouterJevProvider implements JevProvider {
  readonly name = "openrouter:~typesafe/jev-latest";
  constructor(
    private readonly apiKey: string,
    private readonly model = "~typesafe/jev-latest",
    private readonly timeoutMs = 20_000,
  ) {}

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/jevrouter/jevrouter",
        "X-OpenRouter-Title": "JevRouter",
      },
      body: JSON.stringify({
        state: request.state,
        model: this.model,
        questions: buildQuestions(request),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new JevProviderError("jev_timeout", `OpenRouter request timed out after ${this.timeoutMs}ms`);
      throw new JevProviderError("jev_http_error", error instanceof Error ? error.message : String(error));
    });
    if (response.status === 401 || response.status === 403) throw new JevProviderError("jev_auth_error", "OpenRouter rejected the API key", response.status);
    if (!response.ok) throw new JevProviderError("jev_http_error", `OpenRouter returned HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`, response.status);
    const envelope = (await response.json()) as Record<string, unknown>;
    const answers = envelope.answers;
    if (!answers || typeof answers !== "object") throw new JevProviderError("jev_malformed_response", "OpenRouter Decisions response has no answers");
    return {
      ...envelope,
      model: typeof envelope.model === "string" ? envelope.model : this.model,
      answers: answers as Record<string, unknown>,
      usage: envelope.usage as Record<string, unknown> | undefined,
      _openrouter: { id: envelope.id, provider: "openrouter", model: envelope.model },
    };
  }
}


/** Vercel AI Gateway evaluation adapter for Jev (`typesafe-ai/jev`).
 * Wire format uses AI SDK evaluation types: boolean (noul), choice, score.
 * POST {baseURL}/evaluation-model with model id header. */
export class VercelJevProvider implements JevProvider {
  readonly name: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: { baseURL?: string; model?: string; timeoutMs?: number } = {},
  ) {
    this.baseURL = (options.baseURL ?? process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v4/ai").replace(/\/$/, "");
    this.model = options.model ?? process.env.JEV_MODEL ?? "typesafe-ai/jev";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.name = `vercel-ai-gateway:${this.model}`;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const questions = toVercelQuestions(buildQuestions(request));
    const response = await fetch(`${this.baseURL}/evaluation-model`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // Required by Vercel AI Gateway (AI SDK createGateway default headers).
        "ai-gateway-protocol-version": "0.0.1",
        "ai-gateway-auth-method": "api-key",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": this.model,
      },
      body: JSON.stringify({ state: request.state, questions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new JevProviderError("jev_timeout", `Vercel AI Gateway timed out after ${this.timeoutMs}ms`);
      }
      throw new JevProviderError("jev_http_error", error instanceof Error ? error.message : String(error));
    });
    if (response.status === 401 || response.status === 403) {
      const body = (await response.text()).slice(0, 300);
      const billing =
        /credit card|billing|payment method|add a card/i.test(body)
          ? " (AI Gateway billing locked — add a card at vercel.com AI Gateway settings)"
          : "";
      throw new JevProviderError(
        "jev_auth_error",
        `Vercel AI Gateway rejected the request (${response.status})${billing}${body ? `: ${body}` : ""}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new JevProviderError(
        "jev_http_error",
        `Vercel AI Gateway returned HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`,
        response.status,
      );
    }
    const envelope = (await response.json()) as Record<string, unknown>;
    const answers = envelope.answers;
    if (!answers || typeof answers !== "object") {
      throw new JevProviderError("jev_malformed_response", "Vercel evaluation response has no answers");
    }
    return {
      model: this.model,
      answers: fromVercelAnswers(answers as Record<string, unknown>),
      usage: normalizeUsage(envelope.usage),
      _vercel: { provider: "vercel-ai-gateway", model: this.model, providerMetadata: envelope.providerMetadata },
    };
  }
}

/** Try primary, then fallback on auth/http/timeout errors. */
export class DualJevProvider implements JevProvider {
  readonly name: string;
  constructor(
    private readonly primary: JevProvider,
    private readonly fallback: JevProvider,
  ) {
    this.name = `dual:${primary.name}|${fallback.name}`;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    try {
      const raw = await this.primary.decide(request);
      return { ...raw, _dual: { used: "primary", primary: this.primary.name, fallback: this.fallback.name } };
    } catch (error) {
      if (!(error instanceof JevProviderError)) throw error;
      if (!["jev_auth_error", "jev_http_error", "jev_timeout"].includes(error.code)) throw error;
      const raw = await this.fallback.decide(request);
      return {
        ...raw,
        _dual: {
          used: "fallback",
          primary: this.primary.name,
          fallback: this.fallback.name,
          primary_error: { code: error.code, message: error.message, status: error.status },
        },
      };
    }
  }
}

function toVercelQuestions(questions: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => {
      if (question.type === "noul") {
        const mapped: Record<string, unknown> = {
          type: "boolean",
          instructions: question.instructions,
        };
        if (question.criteria !== undefined) mapped.criteria = question.criteria;
        return [key, mapped];
      }
      return [key, question];
    }),
  );
}

function fromVercelAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => {
      if (!value || typeof value !== "object") return [key, value];
      const answer = value as Record<string, unknown>;
      if (answer.type === "boolean") {
        const probability = typeof answer.probability === "number" ? answer.probability : Number(answer.probability);
        return [key, { type: "noul", noul: probability }];
      }
      if (answer.type === "choice") {
        const probabilities = (answer.probabilities as Record<string, number> | undefined) ?? {};
        const values = Object.values(probabilities).filter((n) => typeof n === "number");
        const confidence =
          typeof answer.confidence === "number"
            ? answer.confidence
            : values.length
              ? Math.max(...values)
              : 0;
        return [key, { type: "choice", choice: answer.choice, probabilities, confidence }];
      }
      if (answer.type === "score") {
        return [
          key,
          {
            type: "score",
            score: answer.score,
            probabilities: answer.probabilities,
            confidence: typeof answer.confidence === "number" ? answer.confidence : 1,
            legend: answer.legend,
          },
        ];
      }
      return [key, value];
    }),
  );
}

function normalizeUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  return {
    input_tokens: u.inputTokens ?? u.input_tokens,
    output_tokens: u.outputTokens ?? u.output_tokens,
    ...u,
  };
}

/** Persistent local cache keyed by the exact provider input and candidate snapshot. */
export class CachedJevProvider implements JevProvider {
  readonly name: string;
  constructor(
    private readonly inner: JevProvider,
    private readonly directory = ".jevrouter/.cache",
  ) {
    this.name = inner.name;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const key = sha256({ provider: this.inner.name, state: request.state, candidates: request.candidates, questions: request.questions ?? null });
    const path = join(this.directory, `${key.slice("sha256:".length)}.json`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as JevRawResponse;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const response = await this.inner.decide(request);
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(path, `${JSON.stringify(response)}\n`, { flag: "wx" });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return response;
  }
}

/** Offline provider for local demos. It is intentionally labelled and must not be treated as Jev. */
export class DemoProvider implements JevProvider {
  readonly name = "jevrouter-demo";

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const requestTokens = tokenize(stateToText(request.state));
    const requested: Record<string, JevRouteQuestion> = request.questions ?? { [DEFAULT_TOOL_QUESTION]: {} };
    const answers = Object.fromEntries(Object.entries(requested).map(([key, question]) => {
      if ((question.type ?? "choice") === "choice") {
        const criteria = question.criteria ?? Object.fromEntries(
          request.candidates.map((candidate) => [candidate.id, describeCapability(candidate)]),
        );
        if (Object.keys(criteria).length === 0) {
          throw new Error(`questions.${key}: choice questions need at least one criterion (supply candidates or an explicit criteria map)`);
        }
        const rawScores = Object.entries(criteria).map(([id, criterion]) => ({
          id,
          score: [...requestTokens].filter((token) => tokenize(stateToText(criterion)).has(token)).length + 0.01,
        }));
        const total = rawScores.reduce((sum, item) => sum + item.score, 0);
        const probabilities = Object.fromEntries(rawScores.map(({ id, score }) => [id, score / total]));
        const choice = [...rawScores].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]?.id ?? "";
        const top = choice ? probabilities[choice] : 0;
        const confidence = rawScores.length <= 1
          ? 1
          : clamp((top - 1 / rawScores.length) / Math.max(1 - 1 / rawScores.length, 0.0001));
        const choiceAnswer: JevChoiceAnswer = { type: "choice", choice, probabilities, confidence };
        return [key, choiceAnswer];
      }
      if (question.type === "score") {
        const levels = Array.isArray(question.criteria) ? question.criteria : [];
        if (levels.length === 0) {
          throw new Error(`questions.${key}: score questions require a non-empty criteria array of ordered levels`);
        }
        const levelScores = levels.map((level) => [...requestTokens].filter((token) => tokenize(stateToText(level)).has(token)).length + 0.01);
        const levelTotal = levelScores.reduce((sum, score) => sum + score, 0);
        const levelProbabilities = Object.fromEntries(levelScores.map((score, index) => [String(index), levelTotal ? score / levelTotal : 0]));
        const expected = levelScores.reduce((sum, score, index) => sum + index * (levelTotal ? score / levelTotal : 0), 0);
        return [key, { type: "score", score: expected, probabilities: levelProbabilities, confidence: 1, legend: Object.fromEntries(levels.map((level, index) => [String(index), level])) }];
      }
      if (question.type === "noul") {
        const criteria = question.criteria ?? { true: "true", false: "false" };
        const trueScore = [...requestTokens].filter((token) => tokenize(stateToText(criteria.true)).has(token)).length + 0.01;
        const falseScore = [...requestTokens].filter((token) => tokenize(stateToText(criteria.false)).has(token)).length + 0.01;
        return [key, { type: "noul", noul: clamp(trueScore / (trueScore + falseScore)) }];
      }
      throw new Error(`questions.${key}: unsupported question type`);
    }));
    return {
      model: "jevrouter-demo",
      answers,
      usage: { input_tokens: stateToText(request.state).length, output_tokens: 0 },
    };
  }
}

function stateToText(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state) ?? String(state);
}

export function getChoiceAnswer(raw: JevRawResponse, key: string = DEFAULT_TOOL_QUESTION): JevChoiceAnswer {
  const answer = raw.answers?.[key];
  if (!answer || typeof answer !== "object") throw new JevProviderError("jev_malformed_response", `Jev response is missing answers.${key}`);
  const value = answer as Record<string, unknown>;
  if (value.type !== "choice" || typeof value.choice !== "string" || !value.probabilities || typeof value.probabilities !== "object") {
    throw new JevProviderError("jev_malformed_response", `answers.${key} is not a Choice answer`);
  }
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value.probabilities as Record<string, unknown>)) {
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new JevProviderError("jev_malformed_response", `Invalid probability for ${key}`);
    }
    probabilities[key] = probability;
  }
  const confidence = typeof value.confidence === "number" ? value.confidence : Math.max(...Object.values(probabilities), 0);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new JevProviderError("jev_malformed_response", "Invalid confidence");
  }
  return { ...(value as JevChoiceAnswer), type: "choice", choice: value.choice, probabilities, confidence };
}

export function getScoreAnswer(raw: JevRawResponse, key: string): JevScoreAnswer {
  const answer = raw.answers?.[key];
  if (!answer || typeof answer !== "object") throw new JevProviderError("jev_malformed_response", `Jev response is missing answers.${key}`);
  const value = answer as Record<string, unknown>;
  if (value.type !== "score" || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0) {
    throw new JevProviderError("jev_malformed_response", `answers.${key} is not a Score answer`);
  }
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1)) {
    throw new JevProviderError("jev_malformed_response", `Invalid confidence for answers.${key}`);
  }
  return { ...(value as JevScoreAnswer), type: "score", score: value.score };
}

export function getNoulAnswer(raw: JevRawResponse, key: string): JevNoulAnswer {
  const answer = raw.answers?.[key];
  if (!answer || typeof answer !== "object") throw new JevProviderError("jev_malformed_response", `Jev response is missing answers.${key}`);
  const value = answer as Record<string, unknown>;
  if (value.type !== "noul" || typeof value.noul !== "number" || !Number.isFinite(value.noul) || value.noul < 0 || value.noul > 1) {
    throw new JevProviderError("jev_malformed_response", `answers.${key} is not a Noul answer`);
  }
  return { ...(value as JevNoulAnswer), type: "noul", noul: value.noul };
}

function isJevRawResponse(value: unknown): value is JevRawResponse {
  return Boolean(value && typeof value === "object");
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function describeCapability(candidate: CapabilityManifest): string {
  const metadata = candidate.metadata ?? {};
  const keys = ["provider", "model", "latency_class", "cost_class", "context_tokens", "max_steps", "budget_tokens", "tags"];
  const hints = keys
    .filter((key) => metadata[key] !== undefined)
    .map((key) => `${key}=${String(metadata[key])}`)
    .join(", ");
  return `${candidate.name}: ${candidate.description} [type=${candidate.type}${hints ? `; ${hints}` : ""}]`;
}
