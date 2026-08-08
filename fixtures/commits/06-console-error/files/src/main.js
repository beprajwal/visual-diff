import { renderApp } from './views.js';
import { trackConversion } from './analytics.js';

/**
 * Event handling is delegated off `#app` and keyed by `data-action`, so a commit that renames a
 * selector (`#pay` -> `[data-test=pay]`) touches the markup and the flow spec only. That is exactly
 * the drift the diff engine is supposed to report as `spec-changed` rather than as a broken step.
 */

const state = { view: 'cart', card: '', cardholder: '' };

const root = document.getElementById('app');

function paint() {
  root.innerHTML = renderApp(state);
}

const actions = {
  pay() {
    state.view = 'payment';
    paint();
  },
  'place-order'() {
    state.view = 'receipt';
    paint();
    trackConversion({ id: 'A-1042', total: 7400 });
  },
};

root.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = actions[trigger.dataset.action];
  if (!action) return;
  event.preventDefault();
  action();
});

root.addEventListener('input', (event) => {
  const field = event.target;
  if (field.name && Object.hasOwn(state, field.name)) state[field.name] = field.value;
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
});

paint();
