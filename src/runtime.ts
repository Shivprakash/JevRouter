import {
  CachedJevProvider,
  DemoProvider,
  DualJevProvider,
  HttpJevProvider,
  OpenRouterJevProvider,
  VercelJevProvider,
} from "./provider.js";
import type { JevProvider } from "./types.js";

export type ProviderKind = "typesafe" | "openrouter" | "vercel" | "dual" | "demo";
export type KeyName =
  | "JEV_API_KEY"
  | "TYPESAFE_API_KEY"
  | "OPENROUTER_API_KEY"
  | "AI_GATEWAY_API_KEY";

export interface ProviderOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  cache?: boolean;
  /** Override dual primary/fallback kinds (default env / vercel+openrouter). */
  dualPrimary?: Exclude<ProviderKind, "dual" | "demo">;
  dualFallback?: Exclude<ProviderKind, "dual" | "demo">;
}

const LIVE_KINDS = ["typesafe", "openrouter", "vercel", "dual", "demo"] as const;

/** Resolve provider and key together, never borrowing another provider's credentials. */
export function providerConfiguration(
  kind?: string,
  env: NodeJS.ProcessEnv = process.env,
): { provider: ProviderKind; key: KeyName } {
  kind = kind?.trim() || undefined;
  if (kind !== undefined && !LIVE_KINDS.includes(kind as ProviderKind)) {
    throw new Error("provider must be typesafe, openrouter, vercel, dual, or demo");
  }

  const provider = (kind ??
    (env.JEV_ROUTER_PROVIDER?.trim() ||
      (env.AI_GATEWAY_API_KEY?.trim()
        ? env.JEV_ROUTER_FALLBACK?.trim()
          ? "dual"
          : "vercel"
        : env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim()
          ? "typesafe"
          : env.OPENROUTER_API_KEY?.trim()
            ? "openrouter"
            : "typesafe"))) as ProviderKind;

  const key: KeyName =
    provider === "openrouter"
      ? "OPENROUTER_API_KEY"
      : provider === "vercel" || provider === "dual"
        ? "AI_GATEWAY_API_KEY"
        : env.TYPESAFE_API_KEY?.trim()
          ? "TYPESAFE_API_KEY"
          : "JEV_API_KEY";

  return { provider, key };
}

function createSingleProvider(
  kind: Exclude<ProviderKind, "dual" | "demo">,
  options: ProviderOptions,
  env: NodeJS.ProcessEnv = process.env,
): JevProvider {
  if (kind === "openrouter") {
    const apiKey = options.apiKey?.trim() || env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing OPENROUTER_API_KEY. Export it in the Agent's environment; offline tests must explicitly use --provider demo.",
      );
    }
    return new OpenRouterJevProvider(
      apiKey,
      options.model ?? env.JEV_MODEL_OPENROUTER ?? env.JEV_MODEL ?? "~typesafe/jev-latest",
    );
  }
  if (kind === "vercel") {
    const apiKey = options.apiKey?.trim() || env.AI_GATEWAY_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing AI_GATEWAY_API_KEY. Export it or set via `lm fleet gateway set-key vercel …`.",
      );
    }
    return new VercelJevProvider(apiKey, {
      baseURL: env.AI_GATEWAY_BASE_URL,
      model: options.model ?? env.JEV_MODEL_VERCEL ?? env.JEV_MODEL ?? "typesafe-ai/jev",
    });
  }
  // typesafe
  const apiKey =
    options.apiKey?.trim() || env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Missing TYPESAFE_API_KEY or JEV_API_KEY. Export it in the Agent's environment; offline tests must explicitly use --provider demo.",
    );
  }
  return new HttpJevProvider({
    apiKey,
    endpoint: options.endpoint ?? env.JEV_API_URL,
    model: options.model ?? env.JEV_MODEL_TYPESAFE ?? env.JEV_MODEL ?? "jev-latest",
  });
}

export function createProvider(kind?: string, options: ProviderOptions = {}): JevProvider {
  const config = providerConfiguration(kind);
  if (config.provider === "demo") return new DemoProvider();

  let provider: JevProvider;
  if (config.provider === "dual") {
    const primaryKind = (options.dualPrimary ||
      process.env.JEV_ROUTER_PRIMARY?.trim() ||
      "vercel") as Exclude<ProviderKind, "dual" | "demo">;
    const fallbackKind = (options.dualFallback ||
      process.env.JEV_ROUTER_FALLBACK?.trim() ||
      "openrouter") as Exclude<ProviderKind, "dual" | "demo">;
    if (primaryKind === fallbackKind) {
      throw new Error("dual provider requires distinct primary and fallback gateways");
    }
    if (!["typesafe", "openrouter", "vercel"].includes(primaryKind)) {
      throw new Error(`invalid dual primary: ${primaryKind}`);
    }
    if (!["typesafe", "openrouter", "vercel"].includes(fallbackKind)) {
      throw new Error(`invalid dual fallback: ${fallbackKind}`);
    }
    provider = new DualJevProvider(
      createSingleProvider(primaryKind, { ...options, apiKey: undefined }),
      createSingleProvider(fallbackKind, { ...options, apiKey: undefined }),
    );
  } else {
    provider = createSingleProvider(config.provider, options);
  }

  // Live by default. Enabling a cache must be intentional for routing observations.
  return options.cache === true && process.env.JEV_ROUTER_CACHE !== "0"
    ? new CachedJevProvider(provider)
    : provider;
}
