/**
 * Fixture storefront views.
 *
 * Markup is built as strings and injected with innerHTML. The point of this app is to be a stable,
 * dependency-free surface for visual diffing — not to demonstrate a framework.
 */

const ITEMS = [
  { sku: 'fn-3pk', name: 'Field notes, 3-pack', price: 1200 },
  { sku: 'rb-01', name: 'Rollerball pen', price: 800 },
  { sku: 'dm-wal', name: 'Desk mat, walnut', price: 4900 },
];

const SHIPPING = 500;

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function subtotal() {
  return ITEMS.reduce((total, item) => total + item.price, 0);
}

/**
 * Deliberately not deterministic. The flow spec masks `[data-test=order-date]`, and this element is
 * what proves masking works: without it every run would report a finding here. Everything else on
 * the page is fixed.
 */
function orderDate() {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(),
  );
}

function cartView() {
  return `
    <main class="page" data-test="cart">
      <header class="page-head">
        <h1 class="page-title">Your cart</h1>
        <p class="meta" data-test="order-date">Updated ${orderDate()}</p>
      </header>

      <ul class="cart-list" data-test="cart-list">
        ${ITEMS.map(
          (item) => `
        <li class="cart-item" data-test="cart-item-${item.sku}">
          <span class="cart-item-name">${item.name}</span>
          <span class="cart-item-price">${money(item.price)}</span>
        </li>`,
        ).join('')}
      </ul>

      <section class="summary" data-test="summary">
        <div class="summary-row">
          <span>Subtotal</span><span data-test="subtotal">${money(subtotal())}</span>
        </div>
        <div class="summary-row">
          <span>Shipping</span><span data-test="shipping">${money(SHIPPING)}</span>
        </div>
        <div class="summary-row summary-total">
          <span>Total</span><span data-test="total">${money(subtotal() + SHIPPING)}</span>
        </div>
      </section>

      <button data-test="pay" class="btn btn-primary" data-action="pay">Pay now</button>
    </main>`;
}

function paymentView(state) {
  return `
    <main class="page" data-test="payment">
      <header class="page-head">
        <h1 class="page-title">Payment</h1>
        <p class="meta">Secure checkout</p>
      </header>

      <form class="card-form" data-test="payment-form" autocomplete="off">
        <label class="field">
          <span class="field-label">Card number</span>
          <input class="input" type="text" name="card" placeholder="4242 4242 4242 4242" value="${state.card}" />
        </label>
        <label class="field">
          <span class="field-label">Name on card</span>
          <input class="input" type="text" name="cardholder" placeholder="Ada Lovelace" value="${state.cardholder}" />
        </label>
      </form>

      <button class="btn btn-primary" data-test="place-order" data-action="place-order">Place order</button>
    </main>`;
}

function receiptView() {
  return `
    <main class="page" data-test="receipt">
      <header class="page-head">
        <h1 class="page-title">Order confirmed</h1>
        <p class="meta" data-test="order-number">Order A-1042</p>
      </header>

      <p class="receipt-line">Thanks. A receipt is on its way to ada@example.com.</p>

      <section class="summary" data-test="paid-summary">
        <div class="summary-row summary-total">
          <span>Paid</span><span data-test="paid">${money(subtotal() + SHIPPING)}</span>
        </div>
      </section>
    </main>`;
}

export function renderApp(state) {
  if (state.view === 'receipt') return receiptView();
  if (state.view === 'payment') return paymentView(state);
  return cartView();
}
