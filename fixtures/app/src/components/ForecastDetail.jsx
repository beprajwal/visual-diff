/**
 * The forecast detail screen: current conditions, the hourly chart, the week, and air quality.
 *
 * Two independent requests drive it — forecast and air quality — and they are deliberately not
 * awaited together. The page shell and every panel that depends only on the forecast render as soon
 * as the forecast lands, so the air-quality card can still be loading, empty or failed while the
 * rest of the screen is finished. Every combination of those is a screen a scenario can produce and
 * a run can capture.
 */

import { airQualityUrl, forecastUrl } from '../api.js';
import { buildHash } from '../router.js';
import { toAirQualityView, toForecastView } from '../transform.js';
import { formatMillimetres, formatPercent, formatTemperature, formatWind } from '../units.js';
import { useResource } from '../useResource.js';
import { AirQualityPanel } from './AirQualityPanel.jsx';
import { DailyStrip } from './DailyStrip.jsx';
import { ChevronLeft, WeatherIcon } from './Icons.jsx';
import { ChartSkeleton, ErrorState, Skeleton } from './States.jsx';
import { TemperatureChart } from './TemperatureChart.jsx';

export function ForecastDetail({ place, units }) {
  const forecast = useResource(forecastUrl(place));
  const airQuality = useResource(airQualityUrl(place));

  const view = forecast.status === 'ok' ? toForecastView(forecast.data) : null;
  const airView = airQuality.status === 'ok' ? toAirQualityView(airQuality.data) : null;

  return (
    <div class="detail" data-test="forecast-detail" data-place={place.slug ?? `${place.latitude},${place.longitude}`}>
      <a class="back-link" href={buildHash({ name: 'list', units })} data-test="back">
        <ChevronLeft />
        All locations
      </a>

      <header class="detail-head">
        <div>
          <h1 class="detail-title" data-test="place-name">
            {place.name}
          </h1>
          <p class="detail-region" data-test="place-region">
            {place.region ?? `${place.latitude}, ${place.longitude}`}
          </p>
        </div>
        {view === null ? null : <WeatherIcon weather={view.weather} size={44} className="detail-glyph" />}
      </header>

      {forecast.status === 'error' ? (
        <section class="card" data-test="forecast-error">
          <ErrorState detail={forecast.error.message} status={forecast.error.status} />
        </section>
      ) : null}

      {forecast.status === 'loading' || forecast.status === 'idle' ? (
        <>
          <section class="card">
            <Skeleton lines={4} label="Loading current conditions" height={128} />
          </section>
          <section class="card chart-card">
            <ChartSkeleton />
          </section>
        </>
      ) : null}

      {view === null ? null : (
        <>
          <CurrentConditions view={view} units={units} />
          <TemperatureChart hours={view.hours} units={units} />
          <DailyStrip days={view.days} units={units} />
        </>
      )}

      <AirQualityPanel resource={airQuality} view={airView} />
    </div>
  );
}

function CurrentConditions({ view, units }) {
  return (
    <section class="card current-card" data-test="current-conditions">
      <div class="current-main">
        <p class="current-temp" data-test="current-temp">
          {formatTemperature(view.temperature, units)}
        </p>
        <div class="current-meta">
          <p class="current-condition" data-test="current-condition">
            {view.weather.label}
          </p>
          <p class="current-observed" data-test="observed-at">
            {view.observedLabel === '—' ? 'No observation time' : `Observed ${view.observedLabel} UTC`}
          </p>
        </div>
      </div>
      <dl class="current-readings">
        <Reading label="Feels like" value={formatTemperature(view.apparentTemperature, units)} test="apparent" />
        <Reading label="Humidity" value={formatPercent(view.humidity)} test="humidity" />
        <Reading label="Wind" value={formatWind(view.windSpeed, units)} test="wind" />
        <Reading label="Precipitation" value={formatMillimetres(view.precipitation, units)} test="precipitation" />
        <Reading label="Daylight" value={view.isDay ? 'Daytime' : 'Night'} test="daylight" />
        <Reading
          label="Elevation"
          value={view.elevation === null ? '—' : `${Math.round(view.elevation)} m`}
          test="elevation"
        />
      </dl>
    </section>
  );
}

function Reading({ label, value, test }) {
  return (
    <div class="reading" data-test={`reading-${test}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
