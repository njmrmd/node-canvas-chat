import { ApiError } from "@/lib/http";

/**
 * The provider allowlist.
 *
 * `input trust boundaries`: a request naming a provider or a model is a
 * *lookup key into this table*, never a value we forward. There is no code
 * path where a client-supplied string reaches a provider URL, a model field,
 * or a header. Anything not listed here is a 400 before we spend a database
 * read, let alone a network call.
 *
 * Adding a provider means adding an entry here and a client in `./clients`.
 */

export type ProviderId = "anthropic";

export type ModelSpec = {
  /** The exact id sent to the provider. Never assembled from client input. */
  id: string;
  label: string;
  description: string;
  /**
   * Whether this model accepts `thinking: { type: "adaptive" }`. Haiku 4.5
   * does not — it still takes the older `budget_tokens` form or no `thinking`
   * param at all — and sending `adaptive` to it is a 400, not a fallback.
   */
  supportsAdaptiveThinking: boolean;
};

export type ProviderSpec = {
  id: ProviderId;
  label: string;
  /** Where a user gets a key, shown on the connect screen. */
  consoleUrl: string;
  /** Shape hint for the paste field; also a cheap client-side sanity check. */
  keyPrefix: string;
  models: ModelSpec[];
  defaultModelId: string;
};

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    defaultModelId: "claude-opus-5",
    models: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        description: "Most capable. The default.",
        supportsAdaptiveThinking: true,
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        description: "Faster and cheaper, still strong.",
        supportsAdaptiveThinking: true,
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        description: "Fastest. Good for short branches.",
        supportsAdaptiveThinking: false,
      },
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDERS;
}

/** Throws `unsupported_provider` rather than returning null — fail closed. */
export function requireProvider(value: unknown): ProviderSpec {
  if (!isProviderId(value)) {
    throw new ApiError(
      "unsupported_provider",
      "That model provider is not supported.",
    );
  }
  return PROVIDERS[value];
}

export function requireModel(provider: ProviderSpec, value: unknown): ModelSpec {
  const model = provider.models.find((candidate) => candidate.id === value);
  if (!model) {
    throw new ApiError(
      "unsupported_model",
      `That model is not available for ${provider.label}.`,
    );
  }
  return model;
}

/** The public catalog. Safe to serve to anyone — it contains no secrets. */
export function publicCatalog() {
  return {
    providers: PROVIDER_IDS.map((id) => {
      const provider = PROVIDERS[id];
      return {
        id: provider.id,
        label: provider.label,
        consoleUrl: provider.consoleUrl,
        keyPrefix: provider.keyPrefix,
        defaultModelId: provider.defaultModelId,
        models: provider.models,
      };
    }),
  };
}
