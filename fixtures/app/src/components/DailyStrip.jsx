/**
 * The seven-day strip.
 *
 * Each row's range bar is positioned against the bounds of the *whole week*, so the bars are
 * comparable to one another rather than each filling its own row. That coupling is deliberate: it
 * means a scenario that patches one day's maximum visibly reflows all seven bars, which is a much
 * better test of region clustering than a single isolated rectangle moving.
 */

import { dailyBounds } from '../transform.js';
import { formatMillimetres, formatTemperature } from '../units.js';
import { WeatherIcon } from './Icons.jsx';
import { EmptyState } from './States.jsx';

export function DailyStrip({ days, units }) {
  if (days.length === 0) {
    return (
      <section class="card" data-test="daily-strip">
        <div class="card-head">
          <h2 class="card-title">The week ahead</h2>
        </div>
        <EmptyState title="No daily forecast" detail="The response carried no daily series for this location." />
      </section>
    );
  }

  const bounds = dailyBounds(days);
  const span = bounds.max - bounds.min;

  return (
    <section class="card" data-test="daily-strip">
      <div class="card-head">
        <h2 class="card-title">The week ahead</h2>
        <p class="card-note">
          {formatTemperature(bounds.min, units)} to {formatTemperature(bounds.max, units)}
        </p>
      </div>
      <ol class="daily-list">
        {days.map((day) => {
          const min = day.min ?? bounds.min;
          const max = day.max ?? bounds.max;
          const left = ((min - bounds.min) / span) * 100;
          const width = Math.max(4, ((max - min) / span) * 100);
          return (
            <li class="daily-row" key={day.date} data-test={`daily-${day.date}`}>
              <span class="daily-day">{day.label}</span>
              <WeatherIcon weather={day.weather} size={22} className="daily-icon" />
              <span class="daily-low" data-test="daily-low">
                {formatTemperature(day.min, units, { withUnit: false })}
              </span>
              <span class="daily-track" aria-hidden="true">
                <span
                  class="daily-bar"
                  style={`left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`}
                  data-celsius-min={day.min}
                  data-celsius-max={day.max}
                />
              </span>
              <span class="daily-high" data-test="daily-high">
                {formatTemperature(day.max, units, { withUnit: false })}
              </span>
              <span class="daily-precip" data-test="daily-precip">
                {formatMillimetres(day.precipitation, units)}
              </span>
              <span class="daily-sun">
                {day.sunrise} – {day.sunset}
              </span>
              <span class="visually-hidden">
                {day.weather.label}, low {formatTemperature(day.min, units)}, high{' '}
                {formatTemperature(day.max, units)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
