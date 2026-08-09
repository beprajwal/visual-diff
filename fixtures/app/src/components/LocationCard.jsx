/**
 * One saved location on the list screen.
 *
 * Each card owns its own request, so the four cards resolve independently and the list has a real
 * mixed state — three loaded, one still loading — rather than an all-or-nothing page spinner. A
 * scenario that fails or delays a single location is therefore visible as one card differing from
 * its neighbours, which is a far sharper diff than a whole page changing.
 */

import { forecastUrl } from '../api.js';
import { buildSparkline } from '../chart.js';
import { buildHash } from '../router.js';
import { toForecastView } from '../transform.js';
import { convertTemperature, formatTemperature } from '../units.js';
import { useResource } from '../useResource.js';
import { WeatherIcon } from './Icons.jsx';
import { ErrorState, Skeleton } from './States.jsx';

export function LocationCard({ location, units }) {
  const resource = useResource(forecastUrl(location));
  const href = buildHash({ name: 'saved', slug: location.slug, units });

  return (
    <li class="location-card" data-test={`location-${location.slug}`}>
      <a class="location-link" href={href} data-test={`open-${location.slug}`}>
        <div class="location-head">
          <div>
            <h2 class="location-name">{location.name}</h2>
            <p class="location-region">{location.region}</p>
          </div>
          <CardBadge resource={resource} />
        </div>
        <CardBody resource={resource} units={units} />
      </a>
    </li>
  );
}

function CardBadge({ resource }) {
  if (resource.status !== 'ok') return null;
  const view = toForecastView(resource.data, { hours: 24 });
  return <WeatherIcon weather={view.weather} size={30} className="location-glyph" />;
}

function CardBody({ resource, units }) {
  if (resource.status === 'loading' || resource.status === 'idle') {
    return <Skeleton lines={3} label="Loading forecast" className="location-skeleton" height={132} />;
  }

  if (resource.status === 'error') {
    return <ErrorState title="Forecast unavailable" detail={resource.error.message} status={resource.error.status} />;
  }

  const view = toForecastView(resource.data, { hours: 24 });
  const today = view.days[0] ?? null;
  const spark = buildSparkline(view.hours.map((hour) => convertTemperature(hour.temperature, units)));

  return (
    <div class="location-body">
      <p class="location-temp" data-test="current-temp">
        {formatTemperature(view.temperature, units)}
      </p>
      <p class="location-condition" data-test="condition">
        {view.weather.label}
      </p>
      <p class="location-range" data-test="today-range">
        {today === null
          ? 'No daily range'
          : `H ${formatTemperature(today.max, units, { withUnit: false })}  ·  L ${formatTemperature(today.min, units, { withUnit: false })}`}
      </p>
      {spark.hasData ? (
        <svg
          class="sparkline"
          viewBox={`0 0 ${spark.width} ${spark.height}`}
          width="100%"
          height={spark.height}
          preserveAspectRatio="none"
          aria-hidden="true"
          data-test="sparkline"
        >
          <path class="sparkline-area" d={spark.areaPath} />
          <path class="sparkline-line" d={spark.path} />
        </svg>
      ) : (
        <p class="location-range" data-test="sparkline-empty">
          No hourly series
        </p>
      )}
    </div>
  );
}
