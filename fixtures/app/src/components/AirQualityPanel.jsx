/**
 * Air quality, from the third Open-Meteo endpoint.
 *
 * This panel is a separate request with its own independent state, which is what makes it the right
 * place for the spec's `slow-air-quality` scenario to land: the rest of the detail screen is fully
 * rendered while this card alone is a skeleton, so a delayed response produces a screenshot that is
 * *mostly* the finished page. A whole-page spinner would have made "slow" and "broken" look
 * identical.
 */

import { aqiBand } from '../transform.js';
import { ChartSkeleton, EmptyState, ErrorState } from './States.jsx';

export function AirQualityPanel({ resource, view }) {
  return (
    <section class="card air-card" data-test="air-quality">
      <div class="card-head">
        <h2 class="card-title">Air quality</h2>
        {view === null || view.observedLabel === '—' ? null : (
          <p class="card-note">Measured {view.observedLabel} UTC</p>
        )}
      </div>
      <AirQualityBody resource={resource} view={view} />
    </section>
  );
}

function AirQualityBody({ resource, view }) {
  if (resource.status === 'loading' || resource.status === 'idle') return <ChartSkeleton />;

  if (resource.status === 'error') {
    return (
      <ErrorState
        title="Air quality is unavailable"
        detail={resource.error.message}
        status={resource.error.status}
      />
    );
  }

  const band = aqiBand(view.europeanAqi);
  if (view.europeanAqi === null && view.hours.length === 0) {
    return (
      <EmptyState
        title="No air-quality readings"
        detail="The response contained no European AQI values for this location."
      />
    );
  }

  const peak = view.hours.reduce((highest, row) => Math.max(highest, row.aqi), 1);

  return (
    <div class="air-body">
      <div class={`aqi-badge aqi-${band.key}`} data-test="aqi-badge">
        <span class="aqi-value">{view.europeanAqi === null ? '—' : Math.round(view.europeanAqi)}</span>
        <span class="aqi-label">{band.label}</span>
        <span class="aqi-scale">European AQI</span>
      </div>

      <dl class="air-readings">
        <Reading label="PM2.5" value={view.pm25} unit="µg/m³" test="pm25" />
        <Reading label="PM10" value={view.pm10} unit="µg/m³" test="pm10" />
        <Reading label="Ozone" value={view.ozone} unit="µg/m³" test="ozone" />
        <Reading label="NO₂" value={view.nitrogenDioxide} unit="µg/m³" test="no2" />
      </dl>

      {view.hours.length === 0 ? null : (
        <div class="aqi-track" data-test="aqi-track" aria-hidden="true">
          {view.hours.map((row) => {
            const rowBand = aqiBand(row.aqi);
            return (
              <span
                key={row.time}
                class={`aqi-tick aqi-${rowBand.key}`}
                style={`height:${Math.max(6, (row.aqi / peak) * 100).toFixed(1)}%`}
                data-aqi={row.aqi}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Reading({ label, value, unit, test }) {
  return (
    <div class="air-reading" data-test={`air-${test}`}>
      <dt>{label}</dt>
      <dd>
        {value === null ? '—' : value.toFixed(1)}
        <span class="air-unit"> {unit}</span>
      </dd>
    </div>
  );
}
