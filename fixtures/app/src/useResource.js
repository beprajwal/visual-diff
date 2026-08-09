/**
 * One request, one hook, four states.
 *
 * `idle → loading → ok | error`, with no fifth state and no partial data: the screens branch on
 * `status` exactly once each, which is what makes "the loading state" and "the error state" real
 * screens a flow can capture rather than transient flickers between them.
 *
 * The stale-response guard is not incidental. Changing the units re-renders the detail screen while
 * a request may still be in flight; without the guard, the resolved older request would overwrite
 * the newer one and the screen would settle on data for a location the user has already left. That
 * is a race a visual-diff run reproduces roughly one time in ten, which is exactly the flakiness
 * this fixture must not have.
 */

import { useEffect, useState } from 'preact/hooks';

import { ApiError, fetchJson } from './api.js';

export const IDLE = { status: 'idle', data: null, error: null };

export function useResource(url, { enabled = true } = {}) {
  const [state, setState] = useState(enabled && url !== null ? { status: 'loading', data: null, error: null } : IDLE);

  useEffect(() => {
    if (!enabled || url === null) {
      setState(IDLE);
      return undefined;
    }

    let live = true;
    setState({ status: 'loading', data: null, error: null });

    fetchJson(url).then(
      (data) => {
        if (live) setState({ status: 'ok', data, error: null });
      },
      (error) => {
        if (!live) return;
        const message = error instanceof ApiError ? error.message : 'Something went wrong loading this forecast.';
        setState({ status: 'error', data: null, error: { message, status: error?.status ?? null } });
      },
    );

    return () => {
      live = false;
    };
  }, [url, enabled]);

  return state;
}
