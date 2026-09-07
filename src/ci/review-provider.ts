/**
 * ci/review-provider — which model API `vdiff review` talks to, and as whom, decided from the
 * environment (CI spec D39, D43).
 *
 * A leaf on purpose: pure functions over a `Record<string, string | undefined>`, no `node:fs`, no
 * network, so the CLI parser and the command layer can import it without pulling in the HTTP
 * client behind the lazy `ci` edge (`cli/deps.ts`).
 *
 * The rule is the simplest one that never surprises: the provider is the one whose credential is
 * present. Both present, Anthropic wins unless `--provider openai` says otherwise. Neither present
 * is a config error naming the variables, not a silent no-op — a workflow that meant to review and
 * did not should say so in its log.
 *
 * Anthropic accepts three credentials, resolved in the SDK's own precedence order so a workload
 * that also runs the SDK sees one answer: an API key, a bearer token (`ANTHROPIC_AUTH_TOKEN`, which
 * is what a short-lived federated token is), or the Workload Identity Federation variables, from
 * which the client mints a bearer itself (D43). OpenAI takes an API key.
 */

import { REVIEW_PROVIDERS, type ReviewProvider } from '../types.js';

/** Environment variable each provider's API key is read from. */
export const REVIEW_KEY_ENV: Readonly<Record<ReviewProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** A ready-made bearer for Anthropic — a federated `sk-ant-oat01-…` token, typically. */
export const ANTHROPIC_AUTH_TOKEN_ENV = 'ANTHROPIC_AUTH_TOKEN';

/**
 * Workload Identity Federation (D43): the runner's own OIDC identity, exchanged for a short-lived
 * Anthropic token. All four gate activation, exactly as the SDK's do; the workspace is optional.
 */
export const ANTHROPIC_FEDERATION_ENV = {
  ruleId: 'ANTHROPIC_FEDERATION_RULE_ID',
  organizationId: 'ANTHROPIC_ORGANIZATION_ID',
  serviceAccountId: 'ANTHROPIC_SERVICE_ACCOUNT_ID',
  workspaceId: 'ANTHROPIC_WORKSPACE_ID',
  identityToken: 'ANTHROPIC_IDENTITY_TOKEN',
  identityTokenFile: 'ANTHROPIC_IDENTITY_TOKEN_FILE',
} as const;

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

/** How the request authenticates. Which kinds a provider accepts is the provider's business. */
export type ReviewAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'bearer'; token: string }
  | {
      kind: 'federation';
      federationRuleId: string;
      organizationId: string;
      serviceAccountId: string;
      workspaceId?: string;
      /** Exactly one of the two is set. The file is read at exchange time, never here. */
      identityToken?: string;
      identityTokenFile?: string;
    };

export interface ReviewCredentials {
  provider: ReviewProvider;
  model: string;
  auth: ReviewAuth;
  /** Present only when the provider's base-URL variable is set. */
  baseUrl?: string;
}

export type ResolveReviewOutcome =
  | { ok: true; value: ReviewCredentials }
  | { ok: false; message: string; hint: string };

function present(value: string | undefined): value is string {
  // An empty string is how a workflow passes an input nobody set; it is not a credential.
  return typeof value === 'string' && value.trim().length > 0;
}

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return present(value) ? value.trim() : undefined;
}

/** Anthropic's credential, in the SDK's precedence: key, then bearer, then federation. */
function anthropicAuth(env: Readonly<Record<string, string | undefined>>): ReviewAuth | undefined {
  const apiKey = read(env, REVIEW_KEY_ENV.anthropic);
  if (apiKey !== undefined) return { kind: 'api-key', apiKey };
  const token = read(env, ANTHROPIC_AUTH_TOKEN_ENV);
  if (token !== undefined) return { kind: 'bearer', token };

  const f = ANTHROPIC_FEDERATION_ENV;
  const federationRuleId = read(env, f.ruleId);
  const organizationId = read(env, f.organizationId);
  const serviceAccountId = read(env, f.serviceAccountId);
  const identityToken = read(env, f.identityToken);
  const identityTokenFile = read(env, f.identityTokenFile);
  if (
    federationRuleId !== undefined &&
    organizationId !== undefined &&
    serviceAccountId !== undefined &&
    (identityToken !== undefined || identityTokenFile !== undefined)
  ) {
    const auth: ReviewAuth = { kind: 'federation', federationRuleId, organizationId, serviceAccountId };
    const workspaceId = read(env, f.workspaceId);
    if (workspaceId !== undefined) auth.workspaceId = workspaceId;
    // The file wins when both are set, as it does in the SDK: a file rotates, a literal cannot.
    if (identityTokenFile !== undefined) auth.identityTokenFile = identityTokenFile;
    else if (identityToken !== undefined) auth.identityToken = identityToken;
    return auth;
  }
  return undefined;
}

function openaiAuth(env: Readonly<Record<string, string | undefined>>): ReviewAuth | undefined {
  const apiKey = read(env, REVIEW_KEY_ENV.openai);
  return apiKey === undefined ? undefined : { kind: 'api-key', apiKey };
}

function authFor(
  provider: ReviewProvider,
  env: Readonly<Record<string, string | undefined>>,
): ReviewAuth | undefined {
  return provider === 'anthropic' ? anthropicAuth(env) : openaiAuth(env);
}

/** What a user has to set for a provider, named in the order the resolver tries them. */
function credentialsHint(provider: ReviewProvider): string {
  if (provider === 'openai') return `export ${REVIEW_KEY_ENV.openai}`;
  const f = ANTHROPIC_FEDERATION_ENV;
  return (
    `export ${REVIEW_KEY_ENV.anthropic}, or ${ANTHROPIC_AUTH_TOKEN_ENV}, or the federation ` +
    `variables ${f.ruleId}, ${f.organizationId}, ${f.serviceAccountId} and ${f.identityTokenFile} ` +
    `(or ${f.identityToken})`
  );
}

/**
 * Pick the provider, model and credential from the environment plus whatever flags named.
 *
 * `env` is passed in rather than read from `process.env` so the resolution is a pure function a
 * test can drive, and so the only place the CLI touches the environment for this feature is one
 * line in the command.
 */
export function resolveReviewProvider(
  env: Readonly<Record<string, string | undefined>>,
  options: { provider?: ReviewProvider; model?: string } = {},
): ResolveReviewOutcome {
  let provider: ReviewProvider | undefined = options.provider;
  if (provider === undefined) {
    provider = REVIEW_PROVIDERS.find((candidate) => authFor(candidate, env) !== undefined);
  }
  if (provider === undefined) {
    return {
      ok: false,
      message: 'no model API credential in the environment — nothing can write the review',
      hint:
        `set ${REVIEW_KEY_ENV.anthropic} or ${REVIEW_KEY_ENV.openai} (in CI: the action's ` +
        '`anthropic-api-key` or `openai-api-key` input, from a repository secret), or the ' +
        `Anthropic federation variables for a keyless run (the action's \`anthropic-federation-rule-id\` and friends)`,
    };
  }

  const auth = authFor(provider, env);
  if (auth === undefined) {
    return {
      ok: false,
      message: `--provider ${provider} was asked for but no ${provider} credential is set`,
      hint: `${credentialsHint(provider)}, or drop --provider to use whichever credential is present`,
    };
  }

  const model = present(options.model) ? options.model.trim() : DEFAULT_REVIEW_MODEL[provider];
  const credentials: ReviewCredentials = { provider, model, auth };
  const baseUrl = read(env, REVIEW_BASE_URL_ENV[provider]);
  if (baseUrl !== undefined) credentials.baseUrl = baseUrl.replace(/\/+$/, '');
  return { ok: true, value: credentials };
}
