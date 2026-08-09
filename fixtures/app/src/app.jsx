/**
 * The dashboard shell: header, units toggle, and the route switch.
 *
 * The whole app is four screens and one piece of global state (the units), and the units live in
 * the URL rather than in a store — see `router.js` for why. That leaves this component with no
 * state of its own except the current hash, which means there is nothing here that can be in a
 * different condition on the second run than it was on the first.
 */

import { useEffect, useState } from 'preact/hooks';

import { LOCATIONS, findLocation } from './locations.js';
import { buildHash, parseRoute, withUnits } from './router.js';
import { unitSymbol } from './units.js';
import { ForecastDetail } from './components/ForecastDetail.jsx';
import { LocationCard } from './components/LocationCard.jsx';
import { SearchPanel } from './components/SearchPanel.jsx';
import { EmptyState } from './components/States.jsx';

function useHashRoute() {
  const [hash, setHash] = useState(() => globalThis.location.hash);
  useEffect(() => {
    const onChange = () => setHash(globalThis.location.hash);
    globalThis.addEventListener('hashchange', onChange);
    return () => globalThis.removeEventListener('hashchange', onChange);
  }, []);
  return parseRoute(hash);
}

export function App() {
  const route = useHashRoute();
  return (
    <div class="shell" data-test="app" data-route={route.name} data-units={route.units}>
      <SiteHeader route={route} />
      <main class="main">
        <Screen route={route} />
      </main>
      <Footer />
    </div>
  );
}

function Screen({ route }) {
  if (route.name === 'saved') {
    const location = findLocation(route.slug);
    if (location === null) {
      return (
        <section class="card" data-test="unknown-location">
          <EmptyState
            title="No such saved location"
            detail={`Nothing is saved under “${route.slug}”.`}
            action={
              <a class="button button-quiet" href={buildHash({ name: 'list', units: route.units })}>
                Back to all locations
              </a>
            }
          />
        </section>
      );
    }
    return <ForecastDetail place={location} units={route.units} />;
  }

  if (route.name === 'point') {
    return (
      <ForecastDetail
        place={{
          slug: null,
          name: route.label,
          region: null,
          latitude: route.latitude,
          longitude: route.longitude,
        }}
        units={route.units}
      />
    );
  }

  if (route.name === 'not-found') {
    return (
      <section class="card" data-test="not-found">
        <EmptyState
          title="Page not found"
          detail={`There is nothing at “${route.path}”.`}
          action={
            <a class="button button-quiet" href={buildHash({ name: 'list', units: route.units })}>
              Back to all locations
            </a>
          }
        />
      </section>
    );
  }

  return <LocationList units={route.units} />;
}

function LocationList({ units }) {
  return (
    <div class="list" data-test="location-list">
      <header class="list-head">
        <h1 class="list-title">Saved locations</h1>
        <p class="list-note">{LOCATIONS.length} places, updated from Open-Meteo</p>
      </header>
      <ol class="location-grid" data-test="location-grid">
        {LOCATIONS.map((location) => (
          <LocationCard key={location.slug} location={location} units={units} />
        ))}
      </ol>
      <SearchPanel units={units} />
    </div>
  );
}

function SiteHeader({ route }) {
  return (
    <header class="site-head">
      <a class="brand" href={buildHash({ name: 'list', units: route.units })}>
        <span class="brand-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M2.6 9.6h18.8M2.6 14.4h18.8" stroke="currentColor" stroke-width="1.6" />
            <path d="M12 2.2c3 3.2 3 16.4 0 19.6-3-3.2-3-16.4 0-19.6Z" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </span>
        <span class="brand-name">Meridian</span>
        <span class="brand-tag">weather</span>
      </a>
      <UnitsToggle route={route} />
    </header>
  );
}

/**
 * Two anchors rather than a button with an `onClick`.
 *
 * The toggle is the route, so switching units is a navigation. That also gives a flow two equally
 * valid ways to reach Fahrenheit — click `[data-test=units-f]`, or `goto` the `?units=f` URL — and
 * the second one keeps working when the first one is restyled.
 */
function UnitsToggle({ route }) {
  return (
    <div class="units-toggle" role="group" aria-label="Temperature units" data-test="units-toggle">
      {['c', 'f'].map((unit) => (
        <a
          key={unit}
          class={`units-option ${route.units === unit ? 'is-active' : ''}`.trim()}
          href={withUnits(route, unit)}
          aria-current={route.units === unit ? 'true' : undefined}
          data-test={`units-${unit}`}
        >
          {unitSymbol(unit)}
        </a>
      ))}
    </div>
  );
}

function Footer() {
  return (
    <footer class="site-foot">
      <p>
        Weather data by <a href="https://open-meteo.com/">Open-Meteo.com</a>, licensed CC-BY-4.0.
      </p>
      <p class="site-foot-note">
        A fixture application for visual-diff. Responses are replayed from a committed recording.
      </p>
    </footer>
  );
}
