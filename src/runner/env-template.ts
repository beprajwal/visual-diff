/**
 * `${VAR}` references in flow values (auth spec §3).
 *
 * A flow is committed, so a credential can never be written into it. What a flow may write is a
 * reference — `fill: { "[name=password]": "${VDIFF_PASSWORD}" }` — resolved from the environment
 * of the machine that replays it. The syntax is deliberately one shape: `${` + an uppercase
 * identifier + `}`. A `$` followed by anything else is literal text, so a value that happens to
 * contain a dollar sign needs no escaping.
 *
 * The structural diff compares the template, never the resolved value, and `run.ts` hands every
 * resolved value to the HAR scrubber so the recording cannot carry it either.
 */
import type { FlowSpec } from '../types.js';

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

type Env = Readonly<Record<string, string | undefined>>;

/** Environment variable names a value references, in order of first appearance, no repeats. */
export function envReferences(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(ENV_REF)) {
    const name = match[1] as string;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Every environment variable the flow's `fill` values reference. */
export function flowEnvReferences(flow: Pick<FlowSpec, 'steps'>): string[] {
  const names: string[] = [];
  for (const step of flow.steps) {
    for (const value of Object.values(step.fill ?? {})) {
      for (const name of envReferences(value)) if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export interface EnvResolution {
  /** Resolved values, for the HAR scrubber. Only the variables that are set. */
  values: string[];
  /** Referenced variables the environment does not define. */
  missing: string[];
}

/** Resolve every reference the flow makes against `env`, without touching the flow. */
export function resolveFlowEnv(flow: Pick<FlowSpec, 'steps'>, env: Env): EnvResolution {
  const values: string[] = [];
  const missing: string[] = [];
  for (const name of flowEnvReferences(flow)) {
    const value = env[name];
    if (value === undefined) missing.push(name);
    else values.push(value);
  }
  return { values, missing };
}

/** Substitute every reference in `value`. Throws on an unset variable, naming it. */
export function interpolateEnv(value: string, env: Env): string {
  return value.replace(ENV_REF, (_match: string, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`environment variable ${name} is not set`);
    return resolved;
  });
}
