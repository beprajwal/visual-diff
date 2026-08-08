/**
 * Report UI entry point (spec §9, D7): mount, data loading, the live channel, hash routing and the
 * keyboard map. Everything that carries real logic lives in `state.ts`, `derive.ts`, `keys.ts`,
 * `route.ts` and `paths.ts`; this file is the wiring between them and the DOM.
 */

import { render } from 'preact';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'preact/hooks';

import type { Finding, Region, ViewportId } from '../../types.js';
import { Filmstrip } from './components/Filmstrip.js';
import { FeedbackBox } from './components/FeedbackBox.js';
import { FocusPane } from './components/FocusPane.js';
import { Header } from './components/Header.js';
import { RightRail } from './components/RightRail.js';
import { ViewportTabs } from './components/ViewportTabs.js';
import { Warnings } from './components/Warnings.js';
import { createClient, type ApiClient } from './client.js';
import { buildFilmstrip, findingsForStep, viewportDiffOf, viewportsOf, visibleCells } from './derive.js';
import { KEY_BINDINGS, resolveKey } from './keys.js';
import { formatHash, parseHash } from './route.js';
import { pairId, screenshotPath } from './paths.js';
import { initialState, reduce, routeOf } from './state.js';
import { STYLES } from './styles.js';

export interface AppProps {
  client: ApiClient;
}

export function App({ client }: AppProps) {
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    initialState(parseHash(window.location.hash)),
  );
  const requestId = useRef(0);

  /* ------------------------------------------------------------ data loading */

  useEffect(() => {
    let cancelled = false;
    client
      .flows()
      .then((response) => {
        if (!cancelled) dispatch({ type: 'flows-loaded', flows: response.flows });
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'error', message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const flow = state.flow;
  useEffect(() => {
    if (!flow) return undefined;
    let cancelled = false;
    client
      .runs(flow)
      .then((response) => {
        if (!cancelled) dispatch({ type: 'runs-loaded', flow, runs: response.runs });
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'error', message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, flow]);

  const { base, head, diffStale } = state;
  useEffect(() => {
    if (!flow || !base || !head || !diffStale) return;
    const id = (requestId.current += 1);
    dispatch({ type: 'diff-loading' });
    client
      .diff(flow, base, head)
      .then((response) => {
        if (id !== requestId.current) return;
        if ('error' in response) {
          dispatch({ type: 'diff-backfill', backfill: response });
        } else {
          dispatch({ type: 'diff-loaded', diff: response });
        }
      })
      .catch((error: unknown) => {
        if (id === requestId.current) dispatch({ type: 'diff-failed', message: errorMessage(error) });
      });
  }, [client, flow, base, head, diffStale]);

  /* ------------------------------------------------------------ live channel */

  useEffect(
    () =>
      client.subscribe({
        onEvent: (event) => dispatch({ type: 'server-event', event }),
        onOpen: () => dispatch({ type: 'connection', connected: true }),
        onClose: () => dispatch({ type: 'connection', connected: false }),
      }),
    [client],
  );

  /* ------------------------------------------------------------ hash routing */

  const hash = formatHash(routeOf(state));
  useEffect(() => {
    if (window.location.hash === hash) return;
    const { pathname, search } = window.location;
    window.history.replaceState(null, '', `${pathname}${search}${hash}`);
  }, [hash]);

  /* ------------------------------------------------------------ derived view model */

  const cells = useMemo(
    () => (state.diff ? buildFilmstrip(state.diff, state.viewport) : []),
    [state.diff, state.viewport],
  );
  const strip = useMemo(
    () => visibleCells(cells, state.findingsOnly),
    [cells, state.findingsOnly],
  );
  const cell = useMemo(() => cells.find((c) => c.id === state.step), [cells, state.step]);
  const stepDiff = useMemo(
    () => state.diff?.steps.find((s) => s.id === state.step),
    [state.diff, state.step],
  );
  const viewportDiff = viewportDiffOf(stepDiff, state.viewport);
  const findings = useMemo(
    () => findingsForStep(stepDiff, state.viewport),
    [stepDiff, state.viewport],
  );
  const viewports = useMemo(() => (state.diff ? viewportsOf(state.diff) : []), [state.diff]);
  const viewportCounts = useMemo(() => {
    const counts: Record<ViewportId, number> = {};
    for (const viewport of viewports) {
      counts[viewport] = findingsForStep(stepDiff, viewport).length;
    }
    return counts;
  }, [viewports, stepDiff]);

  const shotUrl = useCallback(
    (side: 'base' | 'head', step: string | null): string | null => {
      const run = side === 'base' ? state.base : state.head;
      if (!flow || !run || !step || !state.viewport) return null;
      return client.blob(screenshotPath(flow, run, step, state.viewport));
    },
    [client, flow, state.base, state.head, state.viewport],
  );

  const missing = viewportDiff?.missing;
  const baseUrl = missing === 'base' || missing === 'both' ? null : shotUrl('base', state.step);
  const headUrl = missing === 'head' || missing === 'both' ? null : shotUrl('head', state.step);
  const pixelUrl = viewportDiff?.pixelPath ? client.blob(viewportDiff.pixelPath) : null;

  const cropUrl = useCallback(
    (finding: Finding): string | null => (finding.crop ? client.blob(finding.crop) : null),
    [client],
  );

  // Findings and regions have separate id spaces ("f1" vs "r1"), so selecting a finding in the rail
  // has to be translated back to the box drawn over the head image by matching rectangles.
  const selectedRegionId = useMemo(() => {
    const selected = state.selectedFinding;
    if (!selected || !viewportDiff) return null;
    if (viewportDiff.regions.some((r) => r.id === selected)) return selected;
    const finding = findings.find((f) => f.id === selected);
    const rect = finding?.region;
    if (!rect) return null;
    const match = viewportDiff.regions.find(
      (r) =>
        r.rect.x === rect.x && r.rect.y === rect.y && r.rect.w === rect.w && r.rect.h === rect.h,
    );
    return match ? match.id : null;
  }, [state.selectedFinding, viewportDiff, findings]);

  /* ------------------------------------------------------------ interactions */

  const openFindingFeedback = useCallback(
    (finding: Finding) => {
      dispatch({ type: 'select-finding', findingId: finding.id });
      dispatch({
        type: 'open-feedback',
        target: {
          label: `${finding.kind} · ${finding.label}`,
          step: finding.step,
          viewport: finding.viewport,
          findingId: finding.id,
          element: finding.element?.selector,
          region: finding.region,
          crop: finding.crop,
        },
      });
    },
    [dispatch],
  );

  const onSelectRegion = useCallback(
    (region: Region) => {
      // A region is the geometric half of a finding; prefer the finding that owns it so the
      // comment carries the element and the crop the agent needs.
      const owner = findings.find(
        (f) =>
          f.region &&
          f.region.x === region.rect.x &&
          f.region.y === region.rect.y &&
          f.region.w === region.rect.w &&
          f.region.h === region.rect.h,
      );
      if (owner) {
        openFindingFeedback(owner);
        return;
      }
      dispatch({ type: 'select-finding', findingId: region.id });
      dispatch({
        type: 'open-feedback',
        target: {
          label: `region ${region.id}`,
          step: state.step ?? undefined,
          viewport: state.viewport ?? undefined,
          region: region.rect,
        },
      });
    },
    [findings, openFindingFeedback, state.step, state.viewport],
  );

  const submitFeedback = useCallback(
    (text: string) => {
      const target = state.feedback;
      if (!target || !flow || !state.base || !state.head) return;
      dispatch({ type: 'feedback-saving' });
      client
        .postFeedback({
          flow,
          pair: pairId(state.base, state.head),
          step: target.step,
          viewport: target.viewport,
          findingId: target.findingId,
          element: target.element,
          region: target.region,
          text,
        })
        .then((entry) => dispatch({ type: 'feedback-saved', entry }))
        .catch((error: unknown) =>
          dispatch({ type: 'feedback-failed', message: errorMessage(error) }),
        );
    },
    [client, flow, state.base, state.head, state.feedback],
  );

  /* ------------------------------------------------------------ keyboard (§9) */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = resolveKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        target: event.target as { tagName?: string; isContentEditable?: boolean } | null,
      });
      if (!action) return;
      event.preventDefault();
      switch (action) {
        case 'step-next':
          dispatch({ type: 'step-next' });
          break;
        case 'step-prev':
          dispatch({ type: 'step-prev' });
          break;
        case 'run-older':
          dispatch({ type: 'run-older' });
          break;
        case 'run-newer':
          dispatch({ type: 'run-newer' });
          break;
        case 'toggle-overlay':
          dispatch({ type: 'toggle-overlay' });
          break;
        case 'toggle-findings-only':
          dispatch({ type: 'toggle-findings-only' });
          break;
        case 'dismiss':
          dispatch({ type: 'dismiss' });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* ------------------------------------------------------------ render */

  return (
    <div class="app">
      <Header state={state} dispatch={dispatch} />

      {state.diff ? (
        <Filmstrip
          cells={strip}
          selected={state.step}
          thumbUrl={(c) => shotUrl(c.thumbSide, c.id)}
          onSelect={(step) => dispatch({ type: 'select-step', step })}
        />
      ) : (
        <div class="filmstrip" />
      )}

      <div class="main">
        <div class="focus">
          <div class="toolbar">
            <ViewportTabs
              viewports={viewports}
              selected={state.viewport}
              counts={viewportCounts}
              onSelect={(viewport) => dispatch({ type: 'select-viewport', viewport })}
            />
            <button
              type="button"
              aria-pressed={state.findingsOnly}
              title="show only steps with findings (f)"
              onClick={() => dispatch({ type: 'toggle-findings-only' })}
            >
              findings only
            </button>
            <span class="spacer" />
            {state.loadingDiff ? <span class="note">computing…</span> : null}
            <span class="legend">
              {KEY_BINDINGS.map((binding) => (
                <span key={binding.key}>
                  <kbd>{binding.label}</kbd> {binding.description}
                </span>
              ))}
            </span>
          </div>

          {state.error ? (
            <p class="notice error">
              {state.error}
              <button type="button" onClick={() => dispatch({ type: 'error', message: null })}>
                dismiss
              </button>
            </p>
          ) : null}

          {state.backfill ? (
            <div class="notice">
              <div>{state.backfill.message}</div>
              {state.backfill.backfill.length > 0 ? (
                <pre>{state.backfill.backfill.join('\n')}</pre>
              ) : null}
            </div>
          ) : null}

          {state.diff ? (
            <FocusPane
              cell={cell}
              viewportDiff={viewportDiff}
              view={state.view}
              overlayOpacity={state.overlayOpacity}
              swipeAt={state.swipeAt}
              baseUrl={baseUrl}
              headUrl={headUrl}
              pixelUrl={pixelUrl}
              selectedRegionId={selectedRegionId}
              onSetView={(view) => dispatch({ type: 'set-view', view })}
              onSetOverlayOpacity={(value) => dispatch({ type: 'set-overlay-opacity', value })}
              onSetSwipe={(value) => dispatch({ type: 'set-swipe', value })}
              onSelectRegion={onSelectRegion}
            />
          ) : state.backfill ? null : (
            <div class="stage">
              <p class="notice">
                {state.runs.length === 0
                  ? 'No runs yet for this flow. Record one with `vdiff run`.'
                  : 'Loading the pair…'}
              </p>
            </div>
          )}
        </div>

        <aside class="rail">
          <Warnings
            baseMeta={state.diff?.baseMeta ?? null}
            headMeta={state.diff?.headMeta ?? null}
            diffWarnings={state.diff?.warnings ?? []}
          />
          <RightRail
            findings={findings}
            selectedFinding={state.selectedFinding}
            cropUrl={cropUrl}
            onSelect={(finding) => dispatch({ type: 'select-finding', findingId: finding.id })}
            onComment={openFindingFeedback}
          />
          {state.recentFeedback.length > 0 ? (
            <section>
              <h2>comments this session</h2>
              <div class="warnings">
                {state.recentFeedback.map((entry) => (
                  <div class="warn" key={entry.id}>
                    <span class="badge">{entry.step ?? entry.pair}</span>
                    <span>{entry.text}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      {state.feedback && flow && state.base && state.head ? (
        <FeedbackBox
          target={state.feedback}
          flow={flow}
          pair={pairId(state.base, state.head)}
          saving={state.feedbackSaving}
          cropUrl={state.feedback.crop ? client.blob(state.feedback.crop) : null}
          onSubmit={submitFeedback}
          onCancel={() => dispatch({ type: 'close-feedback' })}
        />
      ) : null}
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Injects the stylesheet, so the bundle needs no companion CSS file (spec §9). */
export function injectStyles(doc: Document): void {
  if (doc.getElementById('vdiff-styles')) return;
  const style = doc.createElement('style');
  style.id = 'vdiff-styles';
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

/** Mounts the report into a container element. */
export function mount(container: Element, client: ApiClient = createClient()): void {
  injectStyles(container.ownerDocument);
  render(<App client={client} />, container);
}

// Auto-mount when the bundle is loaded by the served page.
if (typeof document !== 'undefined') {
  const container = document.getElementById('vdiff-root');
  if (container) mount(container);
}
