import { render } from 'preact';

import { App } from './app.jsx';
import './styles.css';

/**
 * An empty hash is normalised to `#/` before the first render so every screen has an addressable
 * URL from the moment the page loads. Without it, `#/` and `` are two spellings of the list screen
 * and the units toggle on the bare URL would navigate somewhere subtly different.
 */
if (globalThis.location.hash === '') globalThis.location.replace('#/');

render(<App />, document.getElementById('app'));
