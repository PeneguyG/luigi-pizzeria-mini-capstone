'use strict';

const trackerElement = function (id) { return document.getElementById(id); };
let refreshTimer = null;
let currentOrder = null;
let signedInAccount = null;
let refreshRunning = false;

function safeText(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]; }); }
function formatMoney(value) { return '$' + Number(value || 0).toFixed(2); }
function displayOrderCode(order) { return String(order.publicOrderCode || ('PZ-LEGACY-' + order.id)); }
function announceTracker(message) { trackerElement('tracker-announcement').textContent = message; }
function maskPhoneInput(value) {
  let digits = String(value || '').replace(/\D/g, '').slice(0, 11);
  const countryCode = digits.length === 11 && digits[0] === '1';
  if (countryCode) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  let formatted = '';
  if (digits.length) formatted = '(' + digits.slice(0, 3);
  if (digits.length >= 3) formatted += ') ';
  if (digits.length > 3) formatted += digits.slice(3, 6);
  if (digits.length > 6) formatted += '-' + digits.slice(6, 10);
  return countryCode && digits.length === 10 ? '+1 ' + formatted : formatted;
}
function showTrackerError(message) {
  const box = trackerElement('tracker-error');
  box.textContent = message;
  box.hidden = !message;
  if (message) box.focus();
}
async function trackerRequest(path, options) {
  const config = Object.assign({cache: 'no-store', credentials: 'same-origin'}, options || {});
  const method = String(config.method || 'GET').toUpperCase();
  if (path.indexOf('/api/customer/') === 0 && !['GET','HEAD','OPTIONS'].includes(method)) {
    config.headers = Object.assign({}, config.headers || {}, {'X-Luigi-Request':'1'});
  }
  const response = await fetch(path, config);
  let data;
  try { data = await response.json(); } catch (_error) { throw new Error('The tracking service returned an unexpected response.'); }
  if (!response.ok) throw new Error(data.error || 'We could not load order tracking.');
  return data;
}
function itemsMarkup(items) {
  return (items || []).map(function (item) {
    const description = item.type === 'Pizza' && item.toppings && item.toppings.length
      ? item.toppings.map(function (topping) { return Number(topping.quantity) + '× ' + topping.name; }).join(', ')
      : (item.description || '');
    return '<div class="border-bottom py-3"><div class="d-flex justify-content-between gap-2"><strong>' + Number(item.quantity) + ' × ' + safeText(item.name) + '</strong><span>' + formatMoney(Number(item.quantity) * Number(item.unitPrice)) + '</span></div><p class="small text-secondary mb-0 mt-1">' + safeText(description) + '</p></div>';
  }).join('') || '<p class="text-secondary">No order items are available.</p>';
}
function renderOrder(order, authenticated) {
  currentOrder = order;
  trackerElement('order-result').hidden = false;
  const orderCode = displayOrderCode(order);
  trackerElement('order-result-heading').textContent = 'Order ' + orderCode + ' · Thanks, ' + order.customerName + '!';
  trackerElement('order-pickup').textContent = 'Pickup at Luigi’s Pizzeria' + (order.pickupTime ? ' · Requested time: ' + order.pickupTime : ' · Next available pickup');
  const statusName = order.status === 'In-Progress' ? 'In the kitchen' : order.status === 'Completed' ? 'Picked up' : order.status;
  trackerElement('order-status').textContent = statusName;
  const steps = ['Confirmed','In-Progress','Ready','Completed'];
  const labels = ['Order received','In the kitchen','Ready for pickup','Picked up'];
  const current = order.status === 'Overdue' ? 1 : steps.indexOf(order.status);
  trackerElement('order-steps').innerHTML = steps.map(function (_status, index) {
    return '<li class="' + (index < current ? 'done' : index === current ? 'current' : '') + '"' + (index === current ? ' aria-current="step"' : '') + '><span class="dot" aria-hidden="true">' + (index < current ? '✓' : index + 1) + '</span><span class="visually-hidden">' + (index < current ? 'Completed: ' : index === current ? 'Current step: ' : 'Upcoming: ') + '</span>' + labels[index] + '</li>';
  }).join('');
  const messages = {
    'Confirmed':'Your order is confirmed. Our team will start preparing it soon.',
    'In-Progress':'Our kitchen is preparing your order.',
    'Ready':'Your order is ready. Please give the team your name and order code at pickup.',
    'Overdue':'Your order is taking longer than expected. The team is working on it.',
    'Completed':'Your order has been picked up. Thanks for choosing Luigi’s!'
  };
  trackerElement('order-status-message').textContent = messages[order.status] || 'Order status loaded.';
  trackerElement('order-items').innerHTML = itemsMarkup(order.items);
  const payment = order.paymentMethod === 'Demo card' ? 'Demo card ending ' + (order.paymentLastFour || '—') + ' (no real payment processed).' : 'Pay at pickup.';
  trackerElement('order-details').innerHTML = '<p>' + safeText(order.customerName) + '<br>' + safeText(order.customerPhone) + (order.customerEmail ? '<br>' + safeText(order.customerEmail) : '') + '</p><p>' + safeText(payment) + '</p><strong>Total: ' + formatMoney(order.totalPrice) + '</strong>' + (order.notes ? '<p class="mt-2">Notes: ' + safeText(order.notes) + '</p>' : '');
  trackerElement('last-checked').textContent = 'Last checked ' + new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  if (!authenticated && order.customerEmail) {
    trackerElement('express-account-card').hidden = false;
    trackerElement('express-account-form').dataset.email = order.customerEmail;
    trackerElement('express-account-form').dataset.firstName = order.customerFirstName || '';
    trackerElement('express-account-form').dataset.lastName = order.customerLastName || '';
    trackerElement('express-account-form').dataset.phone = order.customerPhone || '';
  } else {
    trackerElement('express-account-card').hidden = true;
  }
  announceTracker('Order code ' + orderCode + ' status: ' + statusName + '.');
}
async function loadGuestOrder(orderCode, phone, quiet) {
  if (!quiet) showTrackerError('');
  try {
    const result = await trackerRequest('/api/customer/track', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderNumber:orderCode,phone:phone})});
    if (Array.isArray(result.orders)) return result;
    renderOrder(result, false);
    trackerElement('order-result-heading').focus();
    return result;
  } catch (error) {
    if (!quiet) showTrackerError(error.message);
    throw error;
  }
}
async function refreshAuthenticatedOrders() {
  if (!signedInAccount || refreshRunning) return;
  refreshRunning = true;
  try {
    const receipts = await trackerRequest('/api/customer/receipts');
    const results = await Promise.all((receipts.receipts || []).map(async function (receipt) {
      try { return await trackerRequest('/api/customer/orders/' + encodeURIComponent(receipt.orderCode), {headers:{'X-Order-Token':receipt.token}}); }
      catch (_error) { return null; }
    }));
    const active = results.filter(function (order) { return order && order.status !== 'Completed'; });
    const list = trackerElement('active-orders-list');
    trackerElement('active-orders-section').hidden = false;
    if (!active.length) {
      list.innerHTML = '<p class="text-secondary mb-0">You have no active orders right now.</p>';
    } else {
      list.innerHTML = active.map(function (order) {
        return '<article class="border-top py-3"><div class="d-flex flex-wrap justify-content-between gap-2"><h3 class="h5">Order ' + safeText(displayOrderCode(order)) + '</h3><span class="badge rounded-pill soft-green align-self-start">' + safeText(order.status === 'In-Progress' ? 'In the kitchen' : order.status) + '</span></div><p class="text-secondary">' + safeText(order.customerName) + (order.pickupTime ? ' · Pickup ' + safeText(order.pickupTime) : '') + '</p><div>' + itemsMarkup(order.items) + '</div><strong>Total: ' + formatMoney(order.totalPrice) + '</strong></article>';
      }).join('');
    }
    const latestOrder = results.find(function (order) { return Boolean(order); });
    if (latestOrder) renderOrder(latestOrder, true);
  } catch (error) { showTrackerError(error.message); }
  finally { refreshRunning = false; }
}
async function refreshGuestOrder() {
  if (!currentOrder || signedInAccount || document.hidden) return;
  try { await loadGuestOrder(displayOrderCode(currentOrder), trackerElement('lookup-phone').value, true); }
  catch (_error) { /* Keep the last confirmed status visible during a temporary connection issue. */ }
}
function showPhoneMatches(orders) {
  const section = trackerElement('phone-order-matches');
  const list = trackerElement('phone-matches-list');
  const result = trackerElement('order-result');
  result.hidden = true;
  list.replaceChildren();
  orders.forEach(function (order) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-group-item list-group-item-action d-flex flex-wrap justify-content-between align-items-center gap-2';
    const description = document.createElement('span');
    const code = document.createElement('strong');
    code.textContent = 'Order ' + displayOrderCode(order);
    const meta = document.createElement('span');
    meta.className = 'd-block small text-secondary';
    meta.textContent = [order.status, order.pickupTime ? 'Pickup ' + order.pickupTime : ''].filter(Boolean).join(' · ');
    description.append(code, meta);
    const total = document.createElement('span');
    total.className = 'fw-semibold';
    total.textContent = formatMoney(order.totalPrice);
    button.append(description, total);
    button.addEventListener('click', function () {
      currentOrder = order;
      section.hidden = true;
      renderOrder(order, false);
      trackerElement('order-result-heading').focus();
      const url = new URL(window.location.href);
      url.searchParams.set('order', displayOrderCode(order));
      window.history.replaceState({}, '', url);
      clearTimeout(refreshTimer);
      if (order.status !== 'Completed') refreshTimer = setTimeout(refreshGuestOrder, 5000);
    });
    list.append(button);
  });
  section.hidden = false;
  section.querySelector('h2').focus();
  announceTracker(orders.length + (orders.length === 1 ? ' order found for that phone number.' : ' orders found for that phone number.'));
}
trackerElement('lookup-phone').addEventListener('input', function (event) {
  const input = event.currentTarget;
  const start = input.selectionStart;
  const priorDigits = input.value.slice(0, start).replace(/\D/g, '').length;
  input.value = maskPhoneInput(input.value);
  let cursor = input.value.length;
  if (priorDigits === 0) {
    cursor = 0;
  } else if (priorDigits < 10) {
    let seen = 0;
    for (let index = 0; index < input.value.length; index += 1) {
      if (/\d/.test(input.value[index])) seen += 1;
      if (seen >= priorDigits) { cursor = index + 1; break; }
    }
  }
  input.setSelectionRange(cursor, cursor);
});
trackerElement('guest-tracker-form').addEventListener('submit', async function (event) {
  event.preventDefault();
  const orderCode = trackerElement('order-number').value.trim().toUpperCase();
  const phoneValue = trackerElement('lookup-phone').value.trim();
  const phoneDigits = phoneValue.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!orderCode && !phoneValue) {
    showTrackerError('Enter either your order code or phone number.');
    trackerElement('order-number').focus();
    return;
  }
  if (phoneValue && phoneDigits.length !== 10) {
    showTrackerError('Enter a complete 10-digit phone number.');
    trackerElement('lookup-phone').focus();
    return;
  }
  if (orderCode && !trackerElement('order-number').checkValidity()) {
    trackerElement('order-number').reportValidity();
    return;
  }
  trackerElement('phone-order-matches').hidden = true;
  trackerElement('order-result').hidden = true;
  currentOrder = null;
  clearTimeout(refreshTimer);
  const submit = trackerElement('guest-lookup-submit');
  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    const result = await loadGuestOrder(orderCode, phoneDigits, false);
    if (Array.isArray(result.orders)) {
      if (result.orders.length === 1) {
        renderOrder(result.orders[0], false);
        trackerElement('order-result-heading').focus();
        currentOrder = result.orders[0];
        if (result.orders[0].status !== 'Completed') refreshTimer = setTimeout(refreshGuestOrder, 5000);
      } else {
        showPhoneMatches(result.orders);
      }
    }
    const order = Array.isArray(result.orders) ? result.orders[0] : result;
    const url = new URL(window.location.href);
    url.searchParams.set('order', displayOrderCode(order));
    window.history.replaceState({}, '', url);
    if (!Array.isArray(result.orders)) {
      clearTimeout(refreshTimer);
      if (order.status !== 'Completed') refreshTimer = setTimeout(refreshGuestOrder, 5000);
    }
  } catch (_error) { /* The accessible error is rendered by loadGuestOrder. */ }
  finally { submit.disabled = false; submit.textContent = 'Find order'; }
});
trackerElement('refresh-active-orders').addEventListener('click', refreshAuthenticatedOrders);
trackerElement('express-account-form').addEventListener('submit', async function (event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = trackerElement('express-account-submit');
  const error = trackerElement('express-account-error');
  error.hidden = true;
  button.disabled = true;
  try {
    const account = await trackerRequest('/api/customer/signup', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstName:form.dataset.firstName,lastName:form.dataset.lastName,phone:form.dataset.phone,email:form.dataset.email,password:trackerElement('express-account-password').value})});
    form.hidden = true;
    trackerElement('express-account-status').textContent = 'Account created for ' + account.email + '. Your verified orders are linked to the account.';
    signedInAccount = account;
    refreshAuthenticatedOrders();
  } catch (error) {
    trackerElement('express-account-error').textContent = error.message;
    trackerElement('express-account-error').hidden = false;
  } finally { button.disabled = false; }
});
async function initializeTracker() {
  const requestedOrder = new URLSearchParams(window.location.search).get('order');
  const requestedCode = requestedOrder && /^\d+$/.test(requestedOrder)
    ? 'PZ-LEGACY-' + requestedOrder
    : String(requestedOrder || '').trim().toUpperCase();
  const hasRequestedCode = /^PZ-(?:[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}|LEGACY-[0-9]{1,20})$/.test(requestedCode);
  if (hasRequestedCode) trackerElement('order-number').value = requestedCode;
  try {
    const account = await trackerRequest('/api/customer/account');
    signedInAccount = account.customer;
    if (signedInAccount) {
      trackerElement('guest-lookup').hidden = true;
      trackerElement('active-orders-section').hidden = false;
      await refreshAuthenticatedOrders();
      refreshTimer = setInterval(refreshAuthenticatedOrders, 10000);
      return;
    }
  } catch (_error) { /* Guest tracking remains available without an account session. */ }
  if (hasRequestedCode) trackerElement('order-number').focus();
}
initializeTracker();
