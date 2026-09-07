/**
 * report/ui/snapshot — the exported bundle's stand-in for the report API (CI spec D38).
 *
 * The interactive page in an evidence bundle is the same Preact app `vdiff serve` mounts; what
 * changes is where the data comes from. The server injects `createClient()` (fetch + SSE); the
 * bundle injects this: an `ApiClient` whose answers were embedded into the page at export time.
 * One flow, one pair, no socket, no token — and `postFeedback` refuses honestly, because a comment
 * written into a static file would be a comment nobody ever reads back.
 */

import type {
  DiffResult,
  FeedbackEntry,
  FeedbackInput,
  Review,
  RunId,
  RunSummary,
} from '../../types.js';
import type { RunAttribution } from '../attribution.js';
import type { RunVariantAttribution } from '../variant.js';
import type { ApiClient, SubscribeHandlers } from './client.js';

/** What the exporter embeds into `report.html` (CI spec D38). */
export interface ReportSnapshot {
  flow: string;
  base: RunId;
  head: RunId;
  /** The stored diff, verbatim — the same object `findings.json` carries. */
  diff: DiffResult;
  /** Both ends of the pair, oldest first, so the header's run pickers have something to show. */
  runs: RunSummary[];
  /** Scenario attribution per run, when the exporter had it. Absent renders no annotations. */
  attribution?: Record<RunId, RunAttribution>;
  variantAttribution?: Record<RunId, RunVariantAttribution>;
  /**
   * Store-relative image path → what the page should put in `src`: a bundle-relative path under
   * `images/` (`--html linked`) or a `data:` URI (`--html inline`). A path absent from the map was
   * not exported; the app renders its ordinary missing-capture state for it.
   */
  images: Record<string, string>;
  /** Pairing sentences and the gate verdict, rendered as a banner above the app. */
  notices?: string[];
  gate?: { level: string; tripped: boolean; reason: string };
  /** A model's reading of the pair (CI spec D39), rendered in the banner when the bundle has one. */
  review?: Review;
  version: string;
  generatedAt: string;
}

const STATIC_FEEDBACK_REFUSAL =
  'This is an exported snapshot — comments need the live report. Run `vdiff serve` in the ' +
  'repository to leave one.';

/** An `ApiClient` that answers from the embedded snapshot and never touches the network. */
export function createSnapshotClient(snapshot: ReportSnapshot): ApiClient {
  return {
    token: null,
    async flows() {
      return {
        flows: [{ name: snapshot.flow, runs: snapshot.runs.length, latest: snapshot.head }],
      };
    },
    async runs(flow: string) {
      if (flow !== snapshot.flow) throw new Error(`flow '${flow}' is not in this bundle`);
      return { flow, runs: snapshot.runs };
    },
    async diff(flow: string, base: RunId, head: RunId) {
      if (flow === snapshot.flow && base === snapshot.base && head === snapshot.head) {
        return snapshot.diff;
      }
      throw new Error(
        `only ${snapshot.base}..${snapshot.head} is in this bundle — compute other pairs with ` +
          '`vdiff diff` in the repository',
      );
    },
    async attribution(flow: string, runId: RunId) {
      const found = snapshot.attribution?.[runId];
      if (flow !== snapshot.flow || found === undefined) {
        throw new Error(`no attribution for ${flow}/${runId} in this bundle`);
      }
      return found;
    },
    async variantAttribution(flow: string, runId: RunId) {
      const found = snapshot.variantAttribution?.[runId];
      if (flow !== snapshot.flow || found === undefined) {
        throw new Error(`no variant attribution for ${flow}/${runId} in this bundle`);
      }
      return found;
    },
    async postFeedback(_input: FeedbackInput): Promise<FeedbackEntry> {
      throw new Error(STATIC_FEEDBACK_REFUSAL);
    },
    blob(storePath: string): string {
      // A path outside the map gets a relative path that will 404 into the browser's broken-image
      // state — which the app already treats as a missing capture. Inventing a placeholder image
      // would claim a capture that does not exist.
      return snapshot.images[storePath] ?? storePath;
    },
    subscribe(_handlers: SubscribeHandlers): () => void {
      // No live channel in a file. The app's connection state stays wherever the reducer puts it;
      // the static entry hides the liveness badge outright.
      return () => undefined;
    },
  };
}
