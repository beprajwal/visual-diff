/**
 * The three states that are not "here is your data".
 *
 * They are components rather than inline JSX in each screen so a scenario can be judged by the
 * screenshot: an empty state that is one shape everywhere is recognisable at a glance in a
 * filmstrip, where four different hand-written "nothing here" paragraphs are not.
 *
 * Every one of them carries a `data-test` hook and renders at a fixed height. A skeleton that is
 * shorter than the content it stands in for makes the whole page reflow when the data lands, which
 * shows up in a diff as a layout finding on every element below it.
 */

export function Skeleton({ lines = 3, label = 'Loading', className = '', height = null }) {
  return (
    <div
      class={`skeleton ${className}`.trim()}
      data-test="skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={height === null ? undefined : `min-height:${height}px`}
    >
      <span class="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} class="skeleton-line" style={`width:${[100, 76, 88, 62, 94][index % 5]}%`} />
      ))}
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div class="skeleton skeleton-chart" data-test="skeleton" role="status" aria-live="polite" aria-busy="true">
      <span class="visually-hidden">Loading forecast</span>
      <div class="skeleton-chart-body">
        {[38, 52, 44, 61, 73, 66, 80, 71, 58, 47, 55, 63].map((height, index) => (
          <div key={index} class="skeleton-bar" style={`height:${height}%`} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, detail, action = null }) {
  return (
    <div class="state state-empty" data-test="empty-state">
      <div class="state-mark" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
          <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </div>
      <p class="state-title">{title}</p>
      <p class="state-detail">{detail}</p>
      {action}
    </div>
  );
}

/**
 * `detail` is the reason the API gave, verbatim.
 *
 * Open-Meteo's 400 says "Latitude must be in range of -90 to 90°. Given: 999.0.", and showing that
 * instead of "Something went wrong" is what makes the recorded error response worth committing —
 * the screen has real text on it that a diff can catch changing.
 */
export function ErrorState({ title = 'Could not load this forecast', detail, status = null, action = null }) {
  return (
    <div class="state state-error" data-test="error-state" role="alert">
      <div class="state-mark" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24">
          <path d="M12 4.5 21 19.5H3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <line x1="12" y1="10" x2="12" y2="14.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <line x1="12" y1="16.9" x2="12" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </div>
      <p class="state-title">{title}</p>
      <p class="state-detail" data-test="error-detail">
        {detail}
      </p>
      {status === null ? null : (
        <p class="state-status" data-test="error-status">
          HTTP {status}
        </p>
      )}
      {action}
    </div>
  );
}
