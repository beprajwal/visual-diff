/**
 * `${VAR}` references in flow values (auth spec §3; CI spec D44 for `goto` and defaults).
 *
 * A flow is committed, so a credential can never be written into it. What a flow may write is a
 * reference — `fill: { "[name=password]": "${VDIFF_PASSWORD}" }` — resolved from the environment
 * of the machine that replays it. The syntax is deliberately one shape: `${` + an uppercase
 * identifier + `}`, optionally with a shell-style default, `${VDIFF_PROJECT:-9b9f9847-…}`. A `$`
 * followed by anything else is literal text, so a value that happens to contain a dollar sign needs
 * no escaping.
 *
 * Two kinds of value take references, and they differ in one respect:
 *
 *  - `fill` values are typed into the page. They may be secrets, so every value the environment
 *    supplies is handed to the HAR scrubber and never lands in the recording. A default is committed
 *    text and is not scrubbed — a default is, by construction, not a secret.
 *  - `goto` paths are addresses. A project id, a thread id, a tenant slug: the same flow drives a
 *    developer's local data and CI's seeded data when the id is a reference with the local value as
 *    its default. Nothing is scrubbed, because the resolved URL is exactly what the recording has to
 *    match on replay.
 *
 * The structural diff compares the template, never the resolved value.
 */
import type { FlowSpec } from '../types.js';

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

type Env = Readonly<Record<string, string | undefined>>;

export interface EnvReference {
  name: string;
  /** The `:-` fallback, when the reference wrote one. */
  default?: string;
}

/** Every reference a value makes, in order, repeats included. */
export function envReferenceDetails(value: string): EnvReference[] {
  const refs: EnvReference[] = [];
  for (const match of value.matchAll(ENV_REF)) {
    const ref: EnvReference = { name: match[1] as string };
    if (match[2] !== undefined) ref.default = match[2];
    refs.push(ref);
  }
  return refs;
}

/** Environment variable names a value references, in order of first appearance, no repeats. */
export function envReferences(value: string): string[] {
  const names: string[] = [];
  for (const ref of envReferenceDetails(value)) if (!names.includes(ref.name)) names.push(ref.name);
  return names;
}

/** The values of a flow that take references: every `fill` value and every `goto` path. */
function referencingValues(flow: Pick<FlowSpec, 'steps'>): { fills: string[]; gotos: string[] } {
  const fills: string[] = [];
  const gotos: string[] = [];
  for (const step of flow.steps) {
    fills.push(...Object.values(step.fill ?? {}));
    if (step.goto !== undefined) gotos.push(step.goto);
  }
  return { fills, gotos };
}

/** Every environment variable the flow references, `fill` values first, then `goto` paths. */
export function flowEnvReferences(flow: Pick<FlowSpec, 'steps'>): string[] {
  const names: string[] = [];
  const { fills, gotos } = referencingValues(flow);
  for (const value of [...fills, ...gotos]) {
    for (const name of envReferences(value)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface EnvResolution {
  /** Values the environment supplied for `fill` references, for the HAR scrubber. Defaults excluded. */
  values: string[];
  /** Referenced variables the environment does not define and no reference gave a default for. */
  missing: string[];
}

/** Resolve every reference the flow makes against `env`, without touching the flow. */
export function resolveFlowEnv(flow: Pick<FlowSpec, 'steps'>, env: Env): EnvResolution {
  const values: string[] = [];
  const missing: string[] = [];
  const { fills, gotos } = referencingValues(flow);

  for (const value of fills) {
    for (const name of envReferences(value)) {
      const resolved = env[name];
      if (resolved !== undefined && !values.includes(resolved)) values.push(resolved);
    }
  }
  // Each reference resolves on its own: a bare `${X}` with X unset is missing even when another
  // step wrote `${X:-fallback}`, because that fallback applies to that reference alone.
  for (const value of [...fills, ...gotos]) {
    for (const ref of envReferenceDetails(value)) {
      if (env[ref.name] === undefined && ref.default === undefined && !missing.includes(ref.name)) {
        missing.push(ref.name);
      }
    }
  }
  return { values, missing };
}

/**
 * Substitute every reference in `value`: the environment's value, else the reference's default,
 * else an error naming the variable. As in the shell, `:-` treats an *empty* variable like an unset
 * one — which is what a workflow's `${{ vars.X }}` expands to when nobody set X.
 */
export function interpolateEnv(value: string, env: Env): string {
  return value.replace(ENV_REF, (_match: string, name: string, fallback: string | undefined) => {
    const resolved = env[name];
    if (resolved !== undefined && (resolved !== '' || fallback === undefined)) return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error(`environment variable ${name} is not set`);
  });
}
