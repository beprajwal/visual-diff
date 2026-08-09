/**
 * Place search over the geocoding endpoint.
 *
 * The search is submitted, not debounced. A debounce is what a real product would do and exactly
 * what a fixture must not: it makes the number of requests a function of typing speed, so two runs
 * of the same flow record different traffic and the determinism guarantee dies on the first race.
 * An explicit submit fires exactly one request per step, every time.
 *
 * Note which state distinguishes "no results" from "not searched yet": the request status, not the
 * payload. Open-Meteo omits `results` entirely when nothing matches, so the payload alone cannot
 * tell those apart — and an empty state that renders before the user has searched is the classic
 * version of this mistake.
 */

import { useState } from 'preact/hooks';

import { geocodeUrl } from '../api.js';
import { buildHash } from '../router.js';
import { describePlace, toSearchResults } from '../transform.js';
import { useResource } from '../useResource.js';
import { SearchGlyph } from './Icons.jsx';
import { EmptyState, ErrorState, Skeleton } from './States.jsx';

export function SearchPanel({ units }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState(null);
  const resource = useResource(query === null ? null : geocodeUrl(query), { enabled: query !== null });

  const submit = (event) => {
    event.preventDefault();
    const trimmed = draft.trim();
    setQuery(trimmed === '' ? null : trimmed);
  };

  return (
    <section class="card search-card" data-test="search">
      <div class="card-head">
        <h2 class="card-title">Find a place</h2>
        <p class="card-note">Geocoding by Open-Meteo</p>
      </div>

      <form class="search-form" onSubmit={submit} data-test="search-form">
        <label class="visually-hidden" for="search-input">
          Search for a place
        </label>
        <span class="search-input-wrap">
          <SearchGlyph />
          <input
            id="search-input"
            class="search-input"
            name="q"
            type="search"
            autocomplete="off"
            placeholder="Berlin, Reykjavík, Nairobi…"
            value={draft}
            onInput={(event) => setDraft(event.currentTarget.value)}
            data-test="search-input"
          />
        </span>
        <button class="button button-primary" type="submit" data-test="search-submit">
          Search
        </button>
      </form>

      <SearchResults resource={resource} query={query} units={units} />
    </section>
  );
}

function SearchResults({ resource, query, units }) {
  if (resource.status === 'idle') {
    return (
      <p class="search-hint" data-test="search-hint">
        Search for a city to see its forecast.
      </p>
    );
  }

  if (resource.status === 'loading') return <Skeleton lines={4} label="Searching" height={148} />;

  if (resource.status === 'error') {
    return <ErrorState title="Search failed" detail={resource.error.message} status={resource.error.status} />;
  }

  const results = toSearchResults(resource.data);
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No places match “${query}”`}
        detail="Try a shorter name, or a nearby larger town."
      />
    );
  }

  return (
    <ol class="search-results" data-test="search-results">
      {results.map((result) => (
        <li key={result.id} class="search-result" data-test={`search-result-${result.id}`}>
          <a
            class="search-result-link"
            href={buildHash({
              name: 'point',
              latitude: String(result.latitude),
              longitude: String(result.longitude),
              label: result.name,
              units,
            })}
          >
            <span class="search-result-name">{result.name}</span>
            <span class="search-result-place">{describePlace(result)}</span>
            <span class="search-result-meta">
              {result.population === null ? '—' : `${result.population.toLocaleString('en-US')} people`}
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
