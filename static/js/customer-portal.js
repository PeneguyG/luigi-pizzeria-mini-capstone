'use strict';

// The menu endpoint keeps customer prices in sync with the employee API.

let menu = {

  pizzas: {Small: {base: 5, topping: 1}, Medium: {base: 7, topping: 2}, Large: {base: 9, topping: 3}},

  drinks: ['Iced tea', 'Dr. Pepper', 'Cola', 'Un-cola'],

  drinkPrices: {Small: 1, Medium: 2, Large: 3},

  toppings: ['Pepperoni', 'Italian sausage', 'Beef', 'Green peppers', 'Jalapenos', 'Pineapple', 'Onion', 'Black olives', 'Diced tomatoes'],

  taxRate: 0.0975

};

const MAX_ORDER_ITEMS = 20;

let cart = [];

let menuReady = false;

let sendingOrder = false;

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

  const requestOptions = Object.assign({cache: 'no-store'}, options || {});

  const method = String(requestOptions.method || 'GET').toUpperCase();

  if (path.indexOf('/api/customer/') === 0 && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {

    // The server requires this marker on same-origin JSON writes to reject cross-site submissions.
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {'X-Luigi-Request': '1'});

  }

  const response = await fetch(path, requestOptions);

  let data;

  try { data = await response.json(); } catch (_error) { throw new Error('The order service returned an unexpected response. Please try again.'); }

  if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ').');

  return data;

}

function showView(view) {
  const targetTab = element(view + '-tab');

  if (!targetTab || targetTab.disabled) return false;

  element('storefront-welcome').hidden = view !== 'menu';

  ['menu', 'checkout'].forEach(function (name) {

    const active = name === view;

    element(name + '-panel').hidden = !active;

    element(name + '-tab').classList.toggle('active', active);

    element(name + '-tab').setAttribute('aria-selected', String(active));

    element(name + '-tab').tabIndex = active ? 0 : -1;

  });

  if (view === 'checkout') renderCart();


  return true;

}

function unlockStep(view) {

  const tab = element(view + '-tab');

  tab.disabled = false;

  tab.setAttribute('aria-disabled', 'false');

  tab.classList.remove('disabled');

}

function renderToppings() {
  const categories = [
    {name: 'Meats', id: 'meats', toppings: ['Pepperoni', 'Italian sausage', 'Beef']},
    {name: 'Vegetables', id: 'vegetables', toppings: ['Green peppers', 'Jalapenos', 'Onion', 'Black olives', 'Diced tomatoes']},
    {name: 'Fruit', id: 'fruit', toppings: ['Pineapple']}
  ];
  let inputIndex = 0;
  element('topping-options').innerHTML = categories.map(function (category) {
    const available = category.toppings.filter(function (name) { return menu.toppings.includes(name); });
    if (!available.length) return '';
    const controls = available.map(function (name) {
      const index = inputIndex++;
      return '<div class="col-sm-6 col-xl-4"><button id="topping-' + index + '" class="btn btn-outline-danger w-100 d-flex justify-content-between align-items-center topping" type="button" data-name="' + escapeHTML(name) + '" data-count="0" aria-label="Add one serving of ' + escapeHTML(name) + '" aria-describedby="topping-count-' + index + '">' + escapeHTML(name) + '<span id="topping-count-' + index + '" class="badge rounded-pill soft-green" aria-live="polite" aria-atomic="true">0x</span></button></div>';
    }).join('');
    return '<section class="col-12" aria-labelledby="topping-category-' + category.id + '"><h4 class="h6 mb-2" id="topping-category-' + category.id + '">' + category.name + '</h4><div class="row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3">' + controls + '</div></section>';
  }).join('');
  element('pizza-form').reset();
  updatePizzaEstimate();
  renderCart();
}

function currentPizzaPrice() {
  const size = element('pizza-size').value;
  let servings = 0;
  document.querySelectorAll('.topping').forEach(function (button) { servings += Number(button.dataset.count) || 0; });
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

function getCartItemCount() {
  return cart.reduce(function (sum, item) { return sum + item.quantity; }, 0);
}

function clearCartLimitError() {
  const error = element('cart-limit-error');
  error.textContent = '';
  error.hidden = true;
  ['pizza-quantity', 'drink-quantity'].forEach(function (id) { element(id).setAttribute('aria-describedby', 'order-limit-help'); });
}

function canAddToCart(quantity, input) {
  const currentCount = getCartItemCount();
  if (currentCount + quantity <= MAX_ORDER_ITEMS) { clearCartLimitError(); return true; }
  const remaining = Math.max(0, MAX_ORDER_ITEMS - currentCount);
  const error = element('cart-limit-error');
  error.textContent = 'An order can contain up to ' + MAX_ORDER_ITEMS + ' total items. There are ' + currentCount + ' already in your order, so you can add at most ' + remaining + ' more.';
  error.hidden = false;
  input.setAttribute('aria-describedby', 'order-limit-help cart-limit-error');
  input.focus();
  return false;
}

function totalsHTML(items) {
  const prices = totals(items);
  return '<div class="border-top pt-3 mt-3"><div class="d-flex justify-content-between mb-2"><span>Subtotal</span><span>' + money(prices.subtotal) + '</span></div><div class="d-flex justify-content-between small text-secondary mb-3"><span>Tax (' + (menu.taxRate * 100).toFixed(2) + '%)</span><span>' + money(prices.tax) + '</span></div><div class="d-flex justify-content-between fw-semibold"><span>Total</span><span>' + money(prices.total) + '</span></div></div>';
}

function itemsHTML(items, removable) {
  return items.map(function (item, index) {
    let description = item.description || '';
    if (item.type === 'Pizza' && item.toppings) description = item.toppings.map(function (topping) { return topping.quantity + '× ' + topping.name; }).join(', ') || 'Cheese and marinara';
    return '<div class="border-bottom py-3"><div class="d-flex justify-content-between gap-2"><strong class="small">' + item.quantity + ' × ' + escapeHTML(item.name) + '</strong><span class="small text-nowrap">' + money(item.quantity * item.unitPrice) + '</span></div><p class="small text-secondary mb-0 mt-1">' + escapeHTML(description) + '</p>' + (removable ? '<button class="btn btn-link btn-sm text-danger p-0 mt-1" type="button" data-remove="' + index + '" aria-label="Remove ' + escapeHTML(item.name) + '">Remove</button>' : '') + '</div>';
  }).join('');
}

function renderCart() {
  element('cart-count').textContent = getCartItemCount() + ' of ' + MAX_ORDER_ITEMS + ' items';
  element('cart-items').innerHTML = cart.length ? itemsHTML(cart, true) : '<p class="text-secondary py-3">Your cart is waiting for something delicious. Add a pizza or drink to get started.</p>';
  element('cart-totals').innerHTML = totalsHTML(cart);
  element('checkout-items').innerHTML = cart.length ? itemsHTML(cart, false) : '<p class="text-secondary">Your cart is empty. Return to the menu to add something.</p>';
  element('checkout-totals').innerHTML = totalsHTML(cart);
  element('go-checkout').disabled = !cart.length || !menuReady;
  element('place-order').disabled = !cart.length || !menuReady || sendingOrder;
}

function setToppingCount(button, count) {
  const servings = Math.max(0, Math.min(3, Number(count) || 0));
  button.dataset.count = String(servings);
  button.querySelector('.badge').textContent = servings + 'x';
  button.setAttribute('aria-label', servings >= 3 ? button.dataset.name + ', maximum 3 servings selected' : 'Add one serving of ' + button.dataset.name + (servings ? ', ' + servings + ' selected' : ''));
}

function resetToppingButtons() {
  document.querySelectorAll('.topping').forEach(function (button) { setToppingCount(button, 0); });
}

function addPizza(event) {

  event.preventDefault();

  if (!element('pizza-form').reportValidity()) return;

  const size = element('pizza-size').value;

  const toppings = [];

  document.querySelectorAll('.topping').forEach(function (input) {

    if (Number(input.dataset.count) > 0) toppings.push({name: input.dataset.name, quantity: Number(input.dataset.count)});

  });

  const quantity = Number(element('pizza-quantity').value);

  if (!canAddToCart(quantity, element('pizza-quantity'))) return;

  cart.push({type: 'Pizza', name: size + ' pizza', pizzaSize: size, quantity: quantity, toppings: toppings, unitPrice: currentPizzaPrice()});

  element('pizza-form').reset();

  resetToppingButtons();

  updatePizzaEstimate();

  renderCart();

  announce('Pizza added to your order. Pizza choices reset. Your order has ' + getCartItemCount() + ' of ' + MAX_ORDER_ITEMS + ' items.');

}

function addDrink(event) {

  event.preventDefault();

  if (!element('drink-form').reportValidity()) return;

  const size = element('drink-size').value;

  const name = element('drink-name').value;

  const quantity = Number(element('drink-quantity').value);

  if (!canAddToCart(quantity, element('drink-quantity'))) return;

  cart.push({type: 'Drink', name: size + ' ' + name, drinkName: name, drinkSize: size, quantity: quantity, toppings: [], unitPrice: menu.drinkPrices[size]});

  element('drink-form').reset();

  renderCart();

  announce('Drink added to your order. Your order has ' + getCartItemCount() + ' of ' + MAX_ORDER_ITEMS + ' items.');

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

    element(id).classList.remove('is-invalid');

    element(id).setAttribute('aria-describedby', 'card-help');

  });

  element('card-expiry').setAttribute('aria-describedby', 'card-help card-expiry-error');
  element('card-expiry-error').textContent = 'Enter a valid future expiration date as MM / YYYY.';

}

function showCheckoutError(error) {

  const summary = element('checkout-error');

  summary.textContent = 'Order not placed. ' + error.message;

  summary.hidden = false;

  if (error.fieldId) {

    const input = element(error.fieldId);

    input.setAttribute('aria-invalid', 'true');

    input.classList.add('is-invalid');

    input.setAttribute('aria-describedby', error.fieldId === 'card-expiry' ? 'card-help card-expiry-error checkout-error' : 'card-help checkout-error');
    if (error.fieldId === 'card-expiry') element('card-expiry-error').textContent = error.message;

    input.focus();

  } else {

    summary.focus();

  }

}

function validateExpiry() {
  const digits = element('card-expiry').value.replace(/\D/g, '');
  const match = /^(0[1-9]|1[0-2])(\d{4})$/.exec(digits);
  if (!match) throw cardError('Enter all 6 expiry digits as MM / YYYY.', 'card-expiry');
  const now = new Date();
  const year = Number(match[2]);
  const month = Number(match[1]);
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
    throw cardError('The expiration date entered has passed.', 'card-expiry');
  }
  if (year > now.getFullYear() + 20) throw cardError('Choose an expiration date within the next 20 years.', 'card-expiry');
  return {month: match[1], year: match[2]};
}

function demoCardLastFour() {
  if (!element('card-name').value.trim()) throw cardError('Enter the name on the demo card.', 'card-name');
  const number = element('card-number').value.replace(/\s/g, '');
  if (number !== '4242424242424242') throw cardError('Use the demo number 4242 4242 4242 4242. Do not enter a real card.', 'card-number');
  validateExpiry();
  if (!/^\d{3}$/.test(element('card-cvv').value)) throw cardError('Enter a 3-digit demo security code.', 'card-cvv');
  return number.slice(-4);
}

function maskExpiryInput() {
  const input = element('card-expiry');
  const digits = input.value.replace(/\D/g, '').slice(0, 6);
  input.value = digits.length > 2 ? digits.slice(0, 2) + ' / ' + digits.slice(2) : digits;
  input.classList.remove('is-invalid');
  input.removeAttribute('aria-invalid');
  element('card-expiry-error').textContent = 'Enter a valid future expiration date as MM / YYYY.';
}

function prefillCustomer(customer) {
  if (!customer) return;
  if (customer.firstName && !element('customer-first-name').value) element('customer-first-name').value = customer.firstName;
  if (customer.lastName && !element('customer-last-name').value) element('customer-last-name').value = customer.lastName;
  if (customer.phone && !element('customer-phone').value) element('customer-phone').value = customer.phone;
  if (customer.email && !element('customer-email').value) element('customer-email').value = customer.email;
}

async function placeOrder(event) {

  event.preventDefault();

  if (sendingOrder || !menuReady || !element('checkout-form').reportValidity()) return;

  const errorBox = element('checkout-error');

  clearCheckoutErrors();

  if (!cart.length) { showCheckoutError(new Error('Add a pizza or drink before placing your order.')); return; }

  if (getCartItemCount() > MAX_ORDER_ITEMS) { showCheckoutError(new Error('An order can contain no more than ' + MAX_ORDER_ITEMS + ' total items.')); return; }

  try {

    const payload = {

      customerFirstName: element('customer-first-name').value.trim(),

      customerLastName: element('customer-last-name').value.trim(),

      customerPhone: element('customer-phone').value.trim(),

      customerEmail: element('customer-email').value.trim(),

      pickupTime: element('pickup-time').value,

      notes: element('order-notes').value.trim(),

      paymentMethod: 'Demo card',

      paymentLastFour: demoCardLastFour(),

      paymentExpiryMonth: element('card-expiry').value.replace(/\D/g, '').slice(0, 2),

      paymentExpiryYear: element('card-expiry').value.replace(/\D/g, '').slice(2),

      // Server recalculates every price; card number and CVV are never sent.

      items: cart.map(function (item) { return {type: item.type, pizzaSize: item.pizzaSize, drinkName: item.drinkName, drinkSize: item.drinkSize, quantity: item.quantity, toppings: item.toppings}; })

    };

    sendingOrder = true;

    element('place-order').disabled = true;

    element('place-order').textContent = 'Sending your order…';

    const order = await apiRequest('/api/customer/orders', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});

    element('order-success').innerHTML = 'Order #' + Number(order.id) + ' was placed. <a class="alert-link" href="/order-tracker.html?order=' + encodeURIComponent(order.id) + '">Track your order</a> using your order number and phone number.';
    element('order-success').hidden = false;

    cart = [];

    element('checkout-form').reset();

    renderCart();

    element('order-success').focus();

    announce('Order ' + order.id + ' placed. Use the tracking link and your phone number to follow its progress.');

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

  try {
    const accountState = await apiRequest('/api/customer/account');
    prefillCustomer(accountState.customer);
  } catch (_error) {
    // Guest ordering and tracking continue if account lookup is unavailable.
  }

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

  const requestedFocus = new URLSearchParams(window.location.search).get('focus');

  if (requestedFocus === 'order') {

    showView('menu');

    window.requestAnimationFrame(function () { element('menu-tab').focus(); });

  }

}

document.querySelectorAll('[data-view]').forEach(function (button) {

  button.addEventListener('click', function () { showView(button.dataset.view); });

  button.addEventListener('keydown', function (event) {

    const tabs = Array.from(document.querySelectorAll('[data-view]')).filter(function (tab) { return !tab.disabled; });

    let index = tabs.indexOf(button);

    if (index < 0 || tabs.length < 2) return;

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
    if (showView(button.dataset.openView)) element(button.dataset.openView + '-tab').focus();
  });
});
document.querySelectorAll('[data-preset]').forEach(function (button) {
  button.addEventListener('click', function () {
    element('pizza-size').value = 'Medium';
    element('pizza-quantity').value = '1';
    document.querySelectorAll('.topping').forEach(function (input) {
      setToppingCount(input, button.dataset.preset === 'pepperoni' && input.dataset.name === 'Pepperoni' ? '1' : '0');
    });
    updatePizzaEstimate();
    element('pizza-size').focus();
    announce('Medium ' + button.dataset.preset + ' pizza selected. Customize it, then add it to your order.');
  });
});
element('pizza-form').addEventListener('submit', addPizza);

element('drink-form').addEventListener('submit', addDrink);

element('pizza-form').addEventListener('input', updatePizzaEstimate);

element('topping-options').addEventListener('click', function (event) {
  const button = event.target.closest('.topping');
  if (!button) return;
  const current = Number(button.dataset.count);
  if (current >= 3) {
    announce(button.dataset.name + ' is already at the maximum of 3 servings.');
    return;
  }
  setToppingCount(button, current + 1);
  updatePizzaEstimate();
  announce(button.dataset.name + ': ' + (current + 1) + ' servings selected. Maximum 3.');
});

element('checkout-form').addEventListener('submit', placeOrder);

element('card-expiry').addEventListener('input', maskExpiryInput);
element('card-expiry').addEventListener('blur', function () {
  try {
    validateExpiry();
    element('card-expiry').classList.remove('is-invalid');
    element('card-expiry').removeAttribute('aria-invalid');
  } catch (error) {
    element('card-expiry').classList.add('is-invalid');
    element('card-expiry').setAttribute('aria-invalid', 'true');
    element('card-expiry-error').textContent = error.message;
  }
});



element('go-checkout').addEventListener('click', function () {
  if (!cart.length || !menuReady) return;
  unlockStep('checkout');
  if (showView('checkout')) element('customer-first-name').focus();
});

element('back-menu').addEventListener('click', function () { showView('menu'); element('menu-tab').focus(); });

element('cart-items').addEventListener('click', function (event) {

  const button = event.target.closest('[data-remove]');

  if (!button) return;

  cart.splice(Number(button.dataset.remove), 1);

  clearCartLimitError();

  renderCart();

  const remaining = element('cart-items').querySelectorAll('[data-remove]');

  if (remaining.length) remaining[Math.min(Number(button.dataset.remove), remaining.length - 1)].focus();

  else element('menu-tab').focus();

  announce('Item removed from your order.');

});


initializeCustomerDashboard();

