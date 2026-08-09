/**
 * Inline SVG weather glyphs.
 *
 * Inline rather than an icon font or sprite sheet for two reasons that both matter to the harness:
 * an external font is a network request that would land in the HAR next to the API calls it is
 * supposed to be isolating, and a font that has not finished loading shifts layout after the
 * settle gate has already decided the page is still.
 */

const STROKE = {
  fill: 'none',
  'stroke-width': 1.6,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

function Sun() {
  return (
    <g {...STROKE} stroke="currentColor">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <line key={angle} x1="12" y1="3.4" x2="12" y2="5.6" transform={`rotate(${angle} 12 12)`} />
      ))}
    </g>
  );
}

function CloudBody({ y = 0 }) {
  return (
    <path
      d={`M6.6 ${17.4 + y}h9.6a3.4 3.4 0 0 0 .3-6.8 5 5 0 0 0-9.5-1.2A3.5 3.5 0 0 0 6.6 ${17.4 + y}Z`}
      fill="currentColor"
      stroke="none"
    />
  );
}

const SHAPES = {
  sun: () => <Sun />,
  'sun-cloud': () => (
    <g>
      <g {...STROKE} stroke="currentColor" opacity="0.85">
        <circle cx="9" cy="8.6" r="3" fill="currentColor" stroke="none" />
        {[0, 90, 180, 270].map((angle) => (
          <line key={angle} x1="9" y1="2.9" x2="9" y2="4.3" transform={`rotate(${angle} 9 8.6)`} />
        ))}
      </g>
      <CloudBody y={1.2} />
    </g>
  ),
  cloud: () => <CloudBody />,
  fog: () => (
    <g>
      <CloudBody y={-1.6} />
      <g {...STROKE} stroke="currentColor">
        <line x1="5.4" y1="19.2" x2="15" y2="19.2" />
        <line x1="8.4" y1="21.6" x2="18" y2="21.6" />
      </g>
    </g>
  ),
  rain: () => (
    <g>
      <CloudBody y={-2.2} />
      <g {...STROKE} stroke="currentColor">
        <line x1="8.6" y1="17.6" x2="7.4" y2="20.8" />
        <line x1="12.2" y1="17.6" x2="11" y2="21.6" />
        <line x1="15.8" y1="17.6" x2="14.6" y2="20.8" />
      </g>
    </g>
  ),
  snow: () => (
    <g>
      <CloudBody y={-2.2} />
      <g {...STROKE} stroke="currentColor">
        {[8.4, 12, 15.6].map((x) => (
          <g key={x} transform={`translate(${x} 19.8)`}>
            <line x1="-1.5" y1="0" x2="1.5" y2="0" />
            <line x1="0" y1="-1.5" x2="0" y2="1.5" />
          </g>
        ))}
      </g>
    </g>
  ),
  storm: () => (
    <g>
      <CloudBody y={-2.4} />
      <path d="M12.8 16.6 9.6 21h2.6l-1.2 3.2 4-5.2h-2.6Z" fill="currentColor" stroke="none" />
    </g>
  ),
  unknown: () => (
    <g {...STROKE} stroke="currentColor">
      <circle cx="12" cy="12" r="8" />
      <path d="M9.6 9.8a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.6" />
      <line x1="12" y1="16.8" x2="12" y2="16.9" />
    </g>
  ),
};

/**
 * `weather` is the object `describeWeatherCode` returns, so the label is always the one the code
 * table chose and the icon can never disagree with the text beside it.
 */
export function WeatherIcon({ weather, size = 24, className = '' }) {
  const Shape = SHAPES[weather.icon] ?? SHAPES.unknown;
  return (
    <svg
      class={`icon icon-${weather.icon} ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={weather.label}
      data-test={`weather-icon-${weather.icon}`}
    >
      <Shape />
    </svg>
  );
}

export function ChevronLeft() {
  return (
    <svg class="icon-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 5 8 12l6.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function SearchGlyph() {
  return (
    <svg class="icon-search" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2" />
      <line x1="15" y1="15" x2="20" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}
