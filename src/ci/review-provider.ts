/**
 * ci/review-provider — which model API `vdiff review` talks to, decided from the environment
 * (CI spec D39).
 *
 * A leaf on purpose: pure functions over a `Record<string, string | undefined>`, no `node:fs`, no
 * network, so the CLI parser and the command layer can import it without pulling in the HTTP
 * client behind the lazy `ci` edge (`cli/deps.ts`).
 *
 * The rule is the simplest one that never surprises: the provider is the one whose key is present.
 * Both present, Anthropic wins unless `--provider openai` says otherwise. Neither present is a
 * config error naming both variables, not a silent no-op — a workflow that meant to review and
 * did not should say so in its log.
 */

import { REVIEW_PROVIDERS, type ReviewProvider } from '../types.js';

/** Environment variable each provider's key is read from. Nothing else is read. */
export const REVIEW_KEY_ENV: Readonly<Record<ReviewProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Optional per-provider base URL override, for proxies and gateways. */
export const REVIEW_BASE_URL_ENV: Readonly<Record<ReviewProvider, string>> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
};

/**
 * The model used when none is named. Each provider's current flagship: the review is one call per
 * pull request, and a cheaper model that misreads a screenshot costs more than the tokens saved.
 * Override with `--model`, or the action's `review-model` input.
 */
export const DEFAULT_REVIEW_MODEL: Readonly<Record<ReviewProvider, string>> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-6-astra',
};

export function isReviewProvider(value: string): value is ReviewProvider {
  return (REVIEW_PROVIDERS as readonly string[]).includes(value);
}

export interface ReviewCredentials {
  provider: ReviewProvider;
  model: string;
  apiKey: string;
  /** Present only when the provider's base-URL variable is set. */
  baseUrl?: string;
}

export type ResolveReviewOutcome =
  | { ok: true; value: ReviewCredentials }
  | { ok: false; message: string; hint: string };

function present(value: string | undefined): value is string {
  // An empty string is how a workflow passes an input nobody set; it is not a key.
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pick the provider, model and key from the environment plus whatever flags named.
 *
 * `env` is passed in rather than read from `process.env` so the resolution is a pure function a
 * test can drive, and so the only place the CLI touches the environment for this feature is one
 * line in the command.
 */
export function resolveReviewProvider(
  env: Readonly<Record<string, string | undefined>>,
  options: { provider?: ReviewProvider; model?: string } = {},
): ResolveReviewOutcome {
  const keyOf = (provider: ReviewProvider): string | undefined => {
    const value = env[REVIEW_KEY_ENV[provider]];
    return present(value) ? value.trim() : undefined;
  };

  let provider: ReviewProvider | undefined = options.provider;
  if (provider === undefined) {
    provider = REVIEW_PROVIDERS.find((candidate) => keyOf(candidate) !== undefined);
  }
  if (provider === undefined) {
    return {
      ok: false,
      message: 'no model API key in the environment — nothing can write the review',
      hint:
        `set ${REVIEW_KEY_ENV.anthropic} or ${REVIEW_KEY_ENV.openai} (in CI: the action's ` +
        '`anthropic-api-key` or `openai-api-key` input, from a repository secret)',
    };
  }

  const apiKey = keyOf(provider);
  if (apiKey === undefined) {
    return {
      ok: false,
      message: `--provider ${provider} was asked for but ${REVIEW_KEY_ENV[provider]} is not set`,
      hint: `export ${REVIEW_KEY_ENV[provider]}, or drop --provider to use whichever key is present`,
    };
  }

  const model = present(options.model) ? options.model.trim() : DEFAULT_REVIEW_MODEL[provider];
  const credentials: ReviewCredentials = { provider, model, apiKey };
  const baseUrl = env[REVIEW_BASE_URL_ENV[provider]];
  if (present(baseUrl)) credentials.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  return { ok: true, value: credentials };
}
