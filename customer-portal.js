'use strict';

// The menu endpoint keeps customer prices in sync with the employee API.

let menu = {

  pizzas: {Small: {base: 5, topping: 1}, Medium: {base: 7, topping: 2}, Large: {base: 9, topping: 3}},

  drinks: ['Iced tea', 'Dr. Pepper', 'Cola', 'Un-cola'],

  drinkPrices: {Small: 1, Medium: 2, Large: 3},

  toppings: ['Pepperoni', 'Italian sausage', 'Beef', 'Green peppers', 'Jalapenos', 'Pineapple', 'Onion', 'Black olives', 'Diced tomatoes'],

  taxRate: 0.0975

};

let cart = [];

let menuReady = false;

let savedOrders = [];

let selectedOrder = null;

let pollTimer = null;

let trackingBusy = false;

let sendingOrder = false;

let lastAnnouncedStatus = '';

let updatesPaused = false;

let lastRenderedOrder = '';

let trackingOffline = false;

function element(id) { return document.getElementById(id); }

function money(value) { return '$' + Number(value).toFixed(2); }

function escapeHTML(value) {

  return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {

    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character];

  });

}

function announce(message) { element('announcement').textContent = message; }

function showMessage(message) {

  element('page-message').textContent = message;

  element('page-message').hidden = !message;

}

async function apiRequest(path, options) {

  if (window.location.protocol === 'file:') {

    throw new Error('This is a layout preview. Start Flask and open /customer to place orders and connect to the kitchen.');

  }

  const response = await fetch(path, Object.assign({cache: 'no-store'}, options || {}));

  let data;

  try { data = await response.json(); } catch (_error) { throw new Error('The order service returned an unexpected response. Please try again.'); }

  if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ').');

  return data;

}

function showView(view) {
  element('storefront-welcome').hidden = view !== 'menu';

  ['menu', 'checkout', 'tracker'].forEach(function (name) {

    const active = name === view;

    element(name + '-panel').hidden = !active;

    element(name + '-tab').classList.toggle('active', active);

    element(name + '-tab').setAttribute('aria-selected', String(active));

    element(name + '-tab').tabIndex = active ? 0 : -1;

  });

  if (view === 'checkout') renderCart();

  if (view === 'tracker') refreshTracker();

}

function renderToppings() {

  element('topping-options').innerHTML = menu.toppings.map(function (name, index) {

    return '<div class="col"><label class="form-label small mb-1" for="topping-' + index + '">' + escapeHTML(name) + '</label><input id="topping-' + index + '" class="form-control form-control-sm topping" type="number" min="0" max="3" step="1" value="0" data-name="' + escapeHTML(name) + '" aria-label="' + escapeHTML(name) + ' servings per pizza, 0 to 3"></div>';

  }).join('');

}

function currentPizzaPrice() {

  const size = element('pizza-size').value;

  let servings = 0;

  document.querySelectorAll('.topping').forEach(function (input) { servings += Number(input.value) || 0; });

  return menu.pizzas[size].base + servings * menu.pizzas[size].topping;

}

function updatePizzaEstimate() {

  const size = element('pizza-size').value;

  element('pizza-estimate').textContent = money(currentPizzaPrice());

  element('topping-price').textContent = money(menu.pizzas[size].topping) + ' per serving for ' + size.toLowerCase() + '.';

}

function totals(items) {

  const subtotalCents = items.reduce(function (sum, item) { return sum + Math.round(item.unitPrice * 100) * item.quantity; }, 0);

  const taxCents = Math.round(subtotalCents * menu.taxRate);

  return {subtotal: subtotalCents / 100, tax: taxCents / 100, total: (subtotalCents + taxCents) / 100};

}

function totalsHTML(items) {

  const prices = totals(items);

  return '<div class="border-top pt-3 mt-3"><div class="d-flex justify-content-between mb-2"><span>Subtotal</span><span>' + money(prices.subtotal) + '</span></div><div class="d-flex justify-content-between small text-secondary mb-3"><span>Tax (' + (menu.taxRate * 100).toFixed(2) + '%)</span><span>' + money(prices.tax) + '</span></div><div class="d-flex justify-content-between fw-semibold"><span>Total</span><span>' + money(prices.total) + '</span></div></div>';

}

function itemsHTML(items, removable) {

  return items.map(function (item, index) {

    let description = item.description || '';

    if (item.type === 'Pizza' && item.toppings) {

      description = item.toppings.map(function (topping) { return topping.quantity + '× ' + topping.name; }).join(', ') || 'Cheese and marinara';

    }

    return '<div class="border-bottom py-3"><div class="d-flex justify-content-between gap-2"><strong class="small">' + item.quantity + ' × ' + escapeHTML(item.name) + '</strong><span class="small text-nowrap">' + money(item.quantity * item.unitPrice) + '</span></div><p class="small text-secondary mb-0 mt-1">' + escapeHTML(description) + '</p>' + (removable ? '<button class="btn btn-link btn-sm text-danger p-0 mt-1" type="button" data-remove="' + index + '" aria-label="Remove ' + escapeHTML(item.name) + '">Remove</button>' : '') + '</div>';

  }).join('');

}

function renderCart() {

  element('cart-count').textContent = cart.reduce(function (sum, item) { return sum + item.quantity; }, 0) + ' items';

  element('cart-items').innerHTML = cart.length ? itemsHTML(cart, true) : '<p class="text-secondary py-3">Your cart is waiting for something delicious. Add a pizza or drink to get started.</p>';

  element('cart-totals').innerHTML = totalsHTML(cart);

  element('checkout-items').innerHTML = cart.length ? itemsHTML(cart, false) : '<p class="text-secondary">Your cart is empty. Return to the menu to add something.</p>';

  element('checkout-totals').innerHTML = totalsHTML(cart);

  element('go-checkout').disabled = !cart.length || !menuReady;

  element('place-order').disabled = !cart.length || !menuReady || sendingOrder;

}

function addPizza(event) {

  event.preventDefault();

  if (!element('pizza-form').reportValidity()) return;

  const size = element('pizza-size').value;

  const toppings = [];

  document.querySelectorAll('.topping').forEach(function (input) {

    if (Number(input.value) > 0) toppings.push({name: input.dataset.name, quantity: Number(input.value)});

  });

  cart.push({type: 'Pizza', name: size + ' pizza', pizzaSize: size, quantity: Number(element('pizza-quantity').value), toppings: toppings, unitPrice: currentPizzaPrice()});

  element('pizza-form').reset();

  updatePizzaEstimate();

  renderCart();

  announce('Pizza added to your order. Pizza choices reset.');

}

function addDrink(event) {

  event.preventDefault();

  if (!element('drink-form').reportValidity()) return;

  const size = element('drink-size').value;

  const name = element('drink-name').value;

  cart.push({type: 'Drink', name: size + ' ' + name, drinkName: name, drinkSize: size, quantity: Number(element('drink-quantity').value), toppings: [], unitPrice: menu.drinkPrices[size]});

  element('drink-form').reset();

  renderCart();

  announce('Drink added to your order.');

}

function cardError(message, fieldId) {

  const error = new Error(message);

  error.fieldId = fieldId;

  return error;

}

function clearCheckoutErrors() {

  element('checkout-error').hidden = true;

  ['card-name', 'card-number', 'card-expiry', 'card-cvv'].forEach(function (id) {

    element(id).removeAttribute('aria-invalid');

    element(id).setAttribute('aria-describedby', 'card-help');

  });

}

function showCheckoutError(error) {

  const summary = element('checkout-error');

  summary.textContent = 'Order not placed. ' + error.message;

  summary.hidden = false;

  if (error.fieldId) {

    const input = element(error.fieldId);

    input.setAttribute('aria-invalid', 'true');

    input.setAttribute('aria-describedby', 'card-help checkout-error');

    input.focus();

  } else {

    summary.focus();

  }

}

function updateTrackerConnection() {

  element('tracker-connection').textContent = 'Last checked ' + new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'}) + (updatesPaused ? ' · Automatic updates paused. Use Refresh status to check manually.' : element('tracked-status').textContent === 'Picked up' ? ' · Order complete.' : ' · Updates every 5 seconds.');

}

function toggleAutomaticUpdates() {

  updatesPaused = !updatesPaused;

  clearTimeout(pollTimer);

  element('toggle-updates').setAttribute('aria-pressed', String(updatesPaused));

  element('toggle-updates').textContent = updatesPaused ? 'Resume automatic updates' : 'Pause automatic updates';

  announce(updatesPaused ? 'Automatic order updates paused. You can still refresh manually.' : 'Automatic order updates resumed.');

  updateTrackerConnection();

  if (!updatesPaused) refreshTracker();

}

function demoCardLastFour() {

  if (!element('card-name').value.trim()) throw cardError('Enter the name on the demo card.', 'card-name');

  const number = element('card-number').value.replace(/\s/g, '');

  if (number !== '4242424242424242') throw cardError('Use the demo number 4242 4242 4242 4242. Do not enter a real card.', 'card-number');

  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(element('card-expiry').value);

  if (!match) throw cardError('Enter the demo expiry as MM/YY.', 'card-expiry');

  const now = new Date();

  const year = 2000 + Number(match[2]);

  const month = Number(match[1]);

  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) throw cardError('Choose a demo expiry that has not passed.', 'card-expiry');

  if (!/^\d{3}$/.test(element('card-cvv').value)) throw cardError('Enter a 3-digit demo security code.', 'card-cvv');

  return number.slice(-4);

}

function readReceipts() {

  try {

    const stored = JSON.parse(localStorage.getItem('luigi-order-receipts') || '[]');

    savedOrders = Array.isArray(stored) ? stored.filter(function (item) { return Number.isSafeInteger(item.id) && item.id > 0 && typeof item.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item.token); }).slice(0, 10) : [];

  } catch (_error) { savedOrders = []; }

  selectedOrder = savedOrders[0] || null;

  renderReceipts();

}

function rememberOrder(order) {

  selectedOrder = {id: order.id, token: order.trackingToken};

  savedOrders = [selectedOrder].concat(savedOrders.filter(function (saved) { return saved.id !== order.id; })).slice(0, 10);

  try { localStorage.setItem('luigi-order-receipts', JSON.stringify(savedOrders)); }

  catch (_error) { showMessage('Your browser could not save this receipt. Keep this tab open to track the order.'); }

  renderReceipts();

}

function renderReceipts() {

  element('saved-order-wrap').hidden = !savedOrders.length;

  element('saved-order').innerHTML = savedOrders.map(function (saved) { return '<option value="' + saved.id + '"' + (selectedOrder && selectedOrder.id === saved.id ? ' selected' : '') + '>Order #' + saved.id + '</option>'; }).join('');

}

function renderTrackedOrder(order) {

  const signature = JSON.stringify(order);

  if (lastRenderedOrder === signature) { updateTrackerConnection(); return; }

  lastRenderedOrder = signature;

  element('tracker-empty').hidden = true;

  element('tracker-order').hidden = false;

  element('tracked-title').textContent = 'Order #' + order.id + ' · Thanks, ' + order.customerName + '!';

  element('tracked-pickup').textContent = 'Pickup at Luigi\'s Pizzeria · ' + (order.pickupTime ? 'Requested time: ' + order.pickupTime : 'Next available pickup');

  element('tracked-status').textContent = order.status === 'In-Progress' ? 'In the kitchen' : order.status === 'Completed' ? 'Picked up' : order.status;

  const steps = ['Confirmed', 'In-Progress', 'Ready', 'Completed'];

  const labels = ['Order received', 'In the kitchen', 'Ready for pickup', 'Picked up'];

  const current = order.status === 'Overdue' ? 1 : steps.indexOf(order.status);

  element('tracker-steps').innerHTML = steps.map(function (status, index) {

    return '<li class="' + (index < current ? 'done' : index === current ? 'current' : '') + '"' + (index === current ? ' aria-current="step"' : '') + '><span class="dot" aria-hidden="true">' + (index < current ? '✓' : index + 1) + '</span>' + '<span class="visually-hidden">' + (index < current ? 'Completed: ' : index === current ? 'Current step: ' : 'Upcoming: ') + '</span>' + labels[index] + '</li>';

  }).join('');

  const messages = {

    'Confirmed': 'Your order is in! Our team has received it and will start preparing it soon.',

    'In-Progress': 'Our kitchen is working on your order. We will show you when it is ready.',

    'Ready': 'Your order is ready. Come to the pickup counter and give the team your name and order number.',

    'Overdue': 'Your order is taking longer than expected. The team is working on it. Please contact the restaurant if you need help.',

    'Completed': 'Your order has been collected. Thanks for ordering from Luigi\'s!'

  };

  element('tracker-status-message').textContent = messages[order.status] || 'Checking your order status.';

  element('tracked-items').innerHTML = itemsHTML(order.items || [], false);

  const payment = order.paymentMethod === 'Demo card' ? 'Demo card ending ' + (order.paymentLastFour || '4242') + ' — demonstration complete; no real payment processed.' : 'Pay at pickup — payment due when collected.';

  element('tracked-details').innerHTML = '<p class="mb-2">' + escapeHTML(order.customerName) + '<br>' + escapeHTML(order.customerPhone) + '<br>' + escapeHTML(order.customerEmail) + '</p><p class="mb-2">' + escapeHTML(payment) + '</p><strong>Total: ' + money(order.totalPrice) + '</strong>' + (order.notes ? '<p class="mt-2 mb-0">Notes: ' + escapeHTML(order.notes) + '</p>' : '');

  element('tracking-badge').hidden = order.status === 'Completed';

  updateTrackerConnection();

  if (lastAnnouncedStatus !== String(order.id) + order.status) {

    announce('Order ' + order.id + ': ' + element('tracked-status').textContent);

    lastAnnouncedStatus = String(order.id) + order.status;

  }

}

async function refreshTracker() {

  clearTimeout(pollTimer);

  if (!selectedOrder || trackingBusy) return;

  const receipt = selectedOrder;

  trackingBusy = true;

  let complete = false;

  try {

    const order = await apiRequest('/api/customer/orders/' + receipt.id, {headers: {'X-Order-Token': receipt.token}});

    if (!selectedOrder || selectedOrder.id !== receipt.id) return;

    if (trackingOffline) { announce('Connection restored. Your order status is up to date.'); trackingOffline = false; }

    renderTrackedOrder(order);

    complete = order.status === 'Completed';

  } catch (error) {

    if (selectedOrder && selectedOrder.id === receipt.id) {

      if (!trackingOffline) announce('Order updates are temporarily unavailable. Your last confirmed status is still shown.');

      trackingOffline = true;

      element('tracker-connection').textContent = 'Connection interrupted: ' + error.message + (updatesPaused ? ' Automatic updates are paused.' : ' Retrying in 5 seconds.');

      if (element('tracker-order').hidden) showMessage(error.message);

    }

  } finally {

    trackingBusy = false;

    if (selectedOrder && !updatesPaused && !document.hidden && (!complete || selectedOrder.id !== receipt.id)) pollTimer = setTimeout(refreshTracker, 5000);

  }

}

async function placeOrder(event) {

  event.preventDefault();

  if (sendingOrder || !menuReady || !element('checkout-form').reportValidity()) return;

  const errorBox = element('checkout-error');

  clearCheckoutErrors();

  if (!cart.length) { showCheckoutError(new Error('Add a pizza or drink before placing your order.')); return; }

  try {

    const payload = {

      customerName: element('customer-name').value.trim(),

      customerPhone: element('customer-phone').value.trim(),

      customerEmail: element('customer-email').value.trim(),

      pickupTime: element('pickup-time').value,

      notes: element('order-notes').value.trim(),

      paymentMethod: 'Demo card',

      paymentLastFour: demoCardLastFour(),

      // Server recalculates every price; card number and CVV are never sent.

      items: cart.map(function (item) { return {type: item.type, pizzaSize: item.pizzaSize, drinkName: item.drinkName, drinkSize: item.drinkSize, quantity: item.quantity, toppings: item.toppings}; })

    };

    sendingOrder = true;

    element('place-order').disabled = true;

    element('place-order').textContent = 'Sending your order…';

    const order = await apiRequest('/api/customer/orders', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});

    rememberOrder(order);

    cart = [];

    element('checkout-form').reset();

    renderCart();

    renderTrackedOrder(order);

    showView('tracker');

    element('tracked-title').focus();

    announce('Order ' + order.id + ' placed. You can follow its progress here.');

  } catch (error) {

    showCheckoutError(error);

  } finally {

    sendingOrder = false;

    element('checkout-form').removeAttribute('aria-busy');

    element('place-order').textContent = 'Place pickup order';

    renderCart();

  }

}

async function initializeCustomerDashboard() {

  renderToppings();

  updatePizzaEstimate();

  renderCart();

  readReceipts();

  try {

    menu = await apiRequest('/api/customer/menu');

    menuReady = true;

    element('pizza-size').innerHTML = Object.keys(menu.pizzas).map(function (size) {

      const pizza = menu.pizzas[size];

      return '<option value="' + escapeHTML(size) + '"' + (size === 'Medium' ? ' selected' : '') + '>' + escapeHTML(size) + (pizza.inches ? ', ' + pizza.inches + ' inch' : '') + ' — ' + money(pizza.base) + '</option>';

    }).join('');

    element('drink-name').innerHTML = menu.drinks.map(function (name) { return '<option' + (name === 'Iced tea' ? ' selected' : '') + '>' + escapeHTML(name) + '</option>'; }).join('');

    element('drink-size').innerHTML = Object.keys(menu.drinkPrices).map(function (size) { return '<option value="' + escapeHTML(size) + '"' + (size === 'Medium' ? ' selected' : '') + '>' + escapeHTML(size) + ' — ' + money(menu.drinkPrices[size]) + '</option>'; }).join('');

    renderToppings();

    updatePizzaEstimate();

    renderCart();

  } catch (error) { showMessage(error.message); }

  if (selectedOrder) refreshTracker();

}

document.querySelectorAll('[data-view]').forEach(function (button) {

  button.addEventListener('click', function () { showView(button.dataset.view); });

  button.addEventListener('keydown', function (event) {

    const tabs = Array.from(document.querySelectorAll('[data-view]'));

    let index = tabs.indexOf(button);

    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;

    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;

    else if (event.key === 'Home') index = 0;

    else if (event.key === 'End') index = tabs.length - 1;

    else return;

    event.preventDefault(); tabs[index].focus(); showView(tabs[index].dataset.view);

  });

});

// Familiar ordering shortcuts, with our own layout and no automatic cart additions.
document.querySelectorAll('[data-open-view]').forEach(function (button) {
  button.addEventListener('click', function () {
    showView(button.dataset.openView);
    element(button.dataset.openView + '-tab').focus();
  });
});
document.querySelectorAll('[data-preset]').forEach(function (button) {
  button.addEventListener('click', function () {
    element('pizza-size').value = 'Medium';
    element('pizza-quantity').value = '1';
    document.querySelectorAll('.topping').forEach(function (input) {
      input.value = button.dataset.preset === 'pepperoni' && input.dataset.name === 'Pepperoni' ? '1' : '0';
    });
    updatePizzaEstimate();
    element('pizza-size').focus();
    announce('Medium ' + button.dataset.preset + ' pizza selected. Customize it, then add it to your order.');
  });
});
element('pizza-form').addEventListener('submit', addPizza);

element('drink-form').addEventListener('submit', addDrink);

element('pizza-form').addEventListener('input', updatePizzaEstimate);

element('checkout-form').addEventListener('submit', placeOrder);

element('go-checkout').addEventListener('click', function () { showView('checkout'); element('customer-name').focus(); });

element('back-menu').addEventListener('click', function () { showView('menu'); element('menu-tab').focus(); });

element('tracker-start').addEventListener('click', function () { showView('menu'); element('menu-tab').focus(); });

element('order-again').addEventListener('click', function () { showView('menu'); element('menu-tab').focus(); });

element('refresh-tracker').addEventListener('click', refreshTracker);

element('toggle-updates').addEventListener('click', toggleAutomaticUpdates);

element('saved-order').addEventListener('change', function () {

  selectedOrder = savedOrders.find(function (saved) { return saved.id === Number(element('saved-order').value); });

  lastRenderedOrder = '';

  element('tracker-order').hidden = true;

  element('tracker-empty').hidden = false;

  refreshTracker();

});

element('cart-items').addEventListener('click', function (event) {

  const button = event.target.closest('[data-remove]');

  if (!button) return;

  cart.splice(Number(button.dataset.remove), 1);

  renderCart();

  const remaining = element('cart-items').querySelectorAll('[data-remove]');

  if (remaining.length) remaining[Math.min(Number(button.dataset.remove), remaining.length - 1)].focus();

  else element('menu-tab').focus();

  announce('Item removed from your order.');

});

document.addEventListener('visibilitychange', function () {

  clearTimeout(pollTimer);

  if (!document.hidden && !updatesPaused) refreshTracker();

});

initializeCustomerDashboard();

