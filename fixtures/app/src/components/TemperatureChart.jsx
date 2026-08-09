/**
 * The 48-hour temperature chart.
 *
 * This is the component the api-mocking spec means by "where pixel diffing earns its keep". It is
 * one big SVG whose every coordinate is arithmetic over `hourly.temperature_2m` and
 * `hourly.precipitation_probability`, so a scenario that patches a single number in the recorded
 * payload moves a curve by a few pixels and changes nothing else on the page — a change no DOM diff
 * would describe usefully and no human would spot by eye.
 *
 * All geometry comes from `chart.js`; this file is layout and paint only.
 */

import { buildTemperatureChart } from '../chart.js';
import { convertTemperature, formatTemperature, unitSymbol } from '../units.js';
import { useMediaQuery } from '../useMediaQuery.js';
import { EmptyState } from './States.jsx';

const GRADIENT_ID = 'temperature-area-gradient';

/**
 * Two geometries, switched on the same breakpoint the stylesheet uses.
 *
 * The narrow one is not the wide one scaled down. A uniformly scaled 880-wide viewBox renders its
 * 11px labels at about 4px on a 390px screen, and a stretched one squashes them into smears —
 * either way the mobile baseline is a picture nobody can read. So the narrow chart is taller
 * relative to its width, has tighter padding, and labels every twelfth hour instead of every sixth.
 */
const WIDE = { width: 880, height: 300, padding: { top: 24, right: 24, bottom: 34, left: 46 }, xTickEvery: 6 };
const NARROW = { width: 360, height: 240, padding: { top: 22, right: 10, bottom: 30, left: 32 }, xTickEvery: 12 };

export function TemperatureChart({ hours, units }) {
  const narrow = useMediaQuery('(max-width: 720px)');
  const geometry = narrow ? NARROW : WIDE;

  if (hours.length === 0) {
    return (
      <div class="card chart-card" data-test="temperature-chart">
        <ChartHeading units={units} count={0} />
        <EmptyState
          title="No hourly readings"
          detail="The forecast came back without an hourly series, so there is nothing to plot."
        />
      </div>
    );
  }

  const chart = buildTemperatureChart({ hours, units, convert: convertTemperature, ...geometry });

  return (
    <div class="card chart-card" data-test="temperature-chart">
      <ChartHeading units={units} count={hours.length} />
      {/*
        No `preserveAspectRatio="none"`. Stretching the viewBox to the container width squashes the
        axis labels and the marker text along with the curve, which at 390px wide renders them as
        unreadable smears — and a chart whose labels are illegible at the mobile viewport is a
        chart whose mobile screenshot is worthless as a baseline. Uniform scaling costs some height
        on a narrow screen and keeps every glyph legible.
      */}
      <svg
        class="chart"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="img"
        aria-label={`Temperature over the next ${hours.length} hours, in ${units === 'f' ? 'Fahrenheit' : 'Celsius'}`}
      >
        <defs>
          <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--warm)" stop-opacity="0.34" />
            <stop offset="100%" stop-color="var(--warm)" stop-opacity="0.02" />
          </linearGradient>
        </defs>

        <g class="chart-grid" data-test="chart-grid">
          {chart.yTicks.map((tick) => (
            <g key={tick.value}>
              <line x1={chart.plot.x} y1={tick.y} x2={chart.plot.x + chart.plot.width} y2={tick.y} />
              <text class="chart-axis-label" x={chart.plot.x - 10} y={tick.y + 4} text-anchor="end">
                {Math.round(tick.value)}
              </text>
            </g>
          ))}
        </g>

        <g class="chart-bars" data-test="chart-precipitation">
          {chart.bars.map((bar) => (
            <rect
              key={bar.index}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx="1.5"
              data-probability={bar.probability}
            />
          ))}
        </g>

        <path class="chart-area" d={chart.areaPath} fill={`url(#${GRADIENT_ID})`} />
        <path class="chart-line" d={chart.linePath} data-test="chart-line" />

        <g class="chart-x-axis">
          {chart.xTicks.map((point) => (
            <g key={point.index}>
              <line x1={point.x} y1={chart.baselineY} x2={point.x} y2={chart.baselineY + 5} />
              <text class="chart-axis-label" x={point.x} y={chart.baselineY + 20} text-anchor="middle">
                {point.hour.label}
              </text>
            </g>
          ))}
        </g>

        {chart.warmest === null ? null : (
          <Marker point={chart.warmest} units={units} kind="warmest" />
        )}
        {chart.coldest === null || chart.coldest.index === chart.warmest?.index ? null : (
          <Marker point={chart.coldest} units={units} kind="coldest" />
        )}
      </svg>

      <ol class="chart-legend" data-test="chart-legend">
        <li>
          <span class="swatch swatch-line" aria-hidden="true" />
          Temperature ({unitSymbol(units)})
        </li>
        <li>
          <span class="swatch swatch-bar" aria-hidden="true" />
          Chance of precipitation (%)
        </li>
      </ol>
    </div>
  );
}

function ChartHeading({ units, count }) {
  return (
    <div class="card-head">
      <h2 class="card-title">Next {count} hours</h2>
      <p class="card-note">Temperature in {unitSymbol(units)}, hourly</p>
    </div>
  );
}

function Marker({ point, units, kind }) {
  return (
    <g class={`chart-marker chart-marker-${kind}`} data-test={`chart-marker-${kind}`}>
      <circle cx={point.x} cy={point.y} r="4.5" />
      <text x={point.x} y={point.y - 12} text-anchor="middle">
        {formatTemperature(point.hour.temperature, units, { withUnit: false })}
      </text>
    </g>
  );
}
