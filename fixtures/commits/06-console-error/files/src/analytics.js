/**
 * Fixture analytics shim.
 *
 * `window.__fixtureAnalytics` is never defined, so this throws on every confirmed order and logs.
 * That is the entire point of commit 06: the diff engine must surface a new console error as a
 * high-severity `console` finding on the `receipt` step rather than let it pass silently.
 */
export function trackConversion(order) {
  try {
    window.__fixtureAnalytics.record(order);
  } catch (error) {
    console.error(`[fixture-store] analytics failed for order ${order.id}: ${error.message}`);
  }
}
