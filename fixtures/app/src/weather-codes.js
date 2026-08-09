/**
 * WMO 4677 weather codes, mapped to a label and one of six icon shapes.
 *
 * Open-Meteo returns the raw integer, so this table is the only place the fixture invents anything.
 * It stays a lookup rather than a range of `if`s because an unmapped code has to be visible: a
 * dashboard that renders "sunny" for everything it does not recognise is a dashboard whose icons
 * cannot regress.
 */

const TABLE = new Map([
  [0, ['Clear sky', 'sun']],
  [1, ['Mainly clear', 'sun-cloud']],
  [2, ['Partly cloudy', 'sun-cloud']],
  [3, ['Overcast', 'cloud']],
  [45, ['Fog', 'fog']],
  [48, ['Depositing rime fog', 'fog']],
  [51, ['Light drizzle', 'rain']],
  [53, ['Moderate drizzle', 'rain']],
  [55, ['Dense drizzle', 'rain']],
  [56, ['Light freezing drizzle', 'rain']],
  [57, ['Dense freezing drizzle', 'rain']],
  [61, ['Slight rain', 'rain']],
  [63, ['Moderate rain', 'rain']],
  [65, ['Heavy rain', 'rain']],
  [66, ['Light freezing rain', 'rain']],
  [67, ['Heavy freezing rain', 'rain']],
  [71, ['Slight snowfall', 'snow']],
  [73, ['Moderate snowfall', 'snow']],
  [75, ['Heavy snowfall', 'snow']],
  [77, ['Snow grains', 'snow']],
  [80, ['Slight rain showers', 'rain']],
  [81, ['Moderate rain showers', 'rain']],
  [82, ['Violent rain showers', 'rain']],
  [85, ['Slight snow showers', 'snow']],
  [86, ['Heavy snow showers', 'snow']],
  [95, ['Thunderstorm', 'storm']],
  [96, ['Thunderstorm with slight hail', 'storm']],
  [99, ['Thunderstorm with heavy hail', 'storm']],
]);

export const ICON_SHAPES = ['sun', 'sun-cloud', 'cloud', 'fog', 'rain', 'snow', 'storm', 'unknown'];

export function describeWeatherCode(code) {
  const entry = TABLE.get(code);
  if (entry === undefined) return { code, label: `Unknown conditions (code ${code})`, icon: 'unknown' };
  return { code, label: entry[0], icon: entry[1] };
}
