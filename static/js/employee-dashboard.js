'use strict';

    /* Same-origin Flask API. The server recalculates item prices and tax before saving. */
    const pizzaPricing = {
      Small: { inches: 12, base: 5, topping: 1, portion: '¼ cup' },
      Medium: { inches: 14, base: 7, topping: 2, portion: '½ cup' },
      Large: { inches: 18, base: 9, topping: 3, portion: '1 cup' }
    };
    const drinkPricing = { Small: 1, Medium: 2, Large: 3 };
    const TAX_RATE = 0.0975;
    const BUSINESS_TIMEZONE = LuigiTime.zone;
    const statusStyles = {
      Confirmed: 'bg-warning-subtle text-warning-emphasis',
      'In-Progress': 'bg-info-subtle text-info-emphasis',
      Ready: 'bg-success-subtle text-success-emphasis',
      Overdue: 'bg-danger-subtle text-danger-emphasis'
    };
    const allowedStatuses = ['Confirmed', 'In-Progress', 'Ready', 'Overdue', 'Completed'];

    let nextCartItemId = 1;

    const dashboardStatus = document.getElementById('dashboard-status');
    const activeOrdersList = document.getElementById('active-orders-list');
    const cartItems = [];
    const MAX_ORDER_ITEMS = 50;
    const MAX_TOPPING_SERVINGS = 3;
    const posForm = document.getElementById('pos-form');
    let activeOrders = [];
    let historyPage = 0;
    let historyHasMore = false;
    let historyTotal = 0;
    let historyRequestId = 0;
    let historySearchTimer = 0;
    let overdueCheckRunning = false;

    function formatMoney(amount) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount) || 0);
    }

    function escapeHTML(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
      });
    }

    function announce(message) {
      dashboardStatus.textContent = '';
      window.setTimeout(function () { dashboardStatus.textContent = message; }, 20);
    }

    function getSelectedToppings() {
      return Array.from(document.querySelectorAll('.topping-increment')).map(function (button) {
        return { name: button.dataset.topping, quantity: Number(button.dataset.count) || 0 };
      }).filter(function (topping) { return topping.quantity > 0; });
    }

    function updateToppingButtons(control, count) {
      const increment = control.querySelector('.topping-increment');
      const decrement = control.querySelector('.topping-decrement');
      const liveCount = control.querySelector('.topping-count');
      const topping = increment.dataset.topping;
      increment.dataset.count = String(count);
      decrement.dataset.count = String(count);
      increment.setAttribute('aria-disabled', String(count >= MAX_TOPPING_SERVINGS));
      decrement.setAttribute('aria-disabled', String(count <= 0));
      increment.setAttribute('aria-label', 'Add one serving of ' + topping + '. ' + count + ' of ' + MAX_TOPPING_SERVINGS + ' servings selected.');
      decrement.setAttribute('aria-label', 'Remove one serving of ' + topping + '. ' + count + ' of ' + MAX_TOPPING_SERVINGS + ' servings selected.');
      liveCount.querySelector('[aria-hidden="true"]').textContent = count + 'x';
      liveCount.querySelector('.visually-hidden').textContent = count + (count === 1 ? ' serving of ' : ' servings of ') + topping;
    }

    function getPizzaConfiguration() {
      const size = document.getElementById('pizza-size').value;
      const pricing = pizzaPricing[size];
      const quantity = Math.max(1, Math.min(MAX_ORDER_ITEMS, Number(document.getElementById('pizza-quantity').value) || 1));
      const toppings = getSelectedToppings();
      const toppingServings = toppings.reduce(function (sum, topping) { return sum + topping.quantity; }, 0);
      const unitPrice = pricing.base + toppingServings * pricing.topping;
      return { size: size, pricing: pricing, quantity: quantity, toppings: toppings, unitPrice: unitPrice, lineTotal: unitPrice * quantity };
    }

    function updatePizzaPreview() {
      const config = getPizzaConfiguration();
      document.getElementById('pizza-estimate').textContent = formatMoney(config.unitPrice);
      const toppingSummary = config.toppings.map(function (topping) {
        return topping.quantity + ' ' + (topping.quantity === 1 ? 'serving' : 'servings') + ' of ' + topping.name;
      }).join(', ');
      document.getElementById('add-pizza').setAttribute('aria-label',
        'Add ' + config.quantity + ' ' + config.size.toLowerCase() + ' pizza' +
        (toppingSummary ? ' with ' + toppingSummary : ' with no extra toppings') + ' to order');
      updateCartTotalAnnouncement();
    }

    function clearPizzaSelection() {
      document.getElementById('pizza-size').value = 'Medium';
      const quantityInput = document.getElementById('pizza-quantity');
      quantityInput.value = '1';
      quantityInput.setCustomValidity('');
      quantityInput.classList.remove('is-invalid');
      quantityInput.removeAttribute('aria-invalid');
      document.querySelectorAll('.topping-increment').forEach(function (button) {
        updateToppingButtons(button.parentElement, 0);
      });
      updatePizzaPreview();
    }

    function localDateInputValue(date) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date).reduce(function (result, part) {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
      }, {});
      return parts.year + '-' + parts.month + '-' + parts.day;
    }

    function localTimeInputValue(date) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).reduce(function (result, part) {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
      }, {});
      return parts.hour + ':' + parts.minute;
    }

    function addMonthsToDateValue(dateValue, amount) {
      const parts = dateValue.split('-').map(Number);
      const monthIndex = parts[1] - 1 + amount;
      const year = parts[0] + Math.floor(monthIndex / 12);
      const month = monthIndex % 12;
      const day = Math.min(parts[2], new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
      return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }

    function updatePickupDateMinimum() {
      const dateInput = document.getElementById('pickup-date');
      const today = localDateInputValue(new Date());
      dateInput.min = today;
      dateInput.max = addMonthsToDateValue(today, 2);
      if (!dateInput.value) dateInput.value = today;
      return { today: today, latest: dateInput.max };
    }

    function updatePickupTimeValidity() {
      const dateInput = document.getElementById('pickup-date');
      const timeInput = document.getElementById('pickup-time');
      const dateError = document.getElementById('pickup-date-error');
      const timeError = document.getElementById('pickup-time-error');
      const dateBounds = updatePickupDateMinimum();
      const selectedDate = dateInput.value;
      const invalidPastDate = Boolean(selectedDate) && selectedDate < dateBounds.today;
      const invalidFutureDate = Boolean(selectedDate) && selectedDate > dateBounds.latest;
      const dateMessage = invalidPastDate ? 'Past pickup dates are not allowed.' : 'Choose a date within the next two months.';
      dateInput.setCustomValidity(invalidPastDate || invalidFutureDate ? dateMessage : '');
      dateInput.classList.toggle('is-invalid', !dateInput.validity.valid);
      dateError.textContent = invalidPastDate || invalidFutureDate ? dateMessage : 'Choose a pickup date.';

      const closingTime = '22:40';
      let earliestTime = '10:00';
      let noTimesRemainToday = false;
      if (selectedDate === dateBounds.today) {
        const minimum = new Date(Date.now() + 20 * 60 * 1000);
        if (minimum.getSeconds() > 0 || minimum.getMilliseconds() > 0) minimum.setMinutes(minimum.getMinutes() + 1);
        minimum.setSeconds(0, 0);
        if (localDateInputValue(minimum) !== dateBounds.today) {
          noTimesRemainToday = true;
          earliestTime = '22:41';
        } else {
          earliestTime = localTimeInputValue(minimum);
          if (earliestTime < '10:00') earliestTime = '10:00';
          if (earliestTime > closingTime) noTimesRemainToday = true;
        }
      }
      timeInput.min = earliestTime;
      timeInput.max = closingTime;
      let invalidTime = false;
      if (noTimesRemainToday) {
        invalidTime = true;
        timeError.textContent = 'No pickup times remain today. Choose a future date.';
      } else if (timeInput.value && (timeInput.value < '10:00' || timeInput.value > closingTime)) {
        invalidTime = true;
        timeError.textContent = 'Pickup times must be between 10:00 a.m. and 10:40 p.m.';
      } else if (timeInput.value && selectedDate === dateBounds.today && timeInput.value < earliestTime) {
        invalidTime = true;
        timeError.textContent = 'For today, choose a pickup time at least 20 minutes from now (' + earliestTime + ' or later).';
      } else {
        timeError.textContent = 'Choose a pickup time from 10:00 a.m. to 10:40 p.m.';
      }
      timeInput.setCustomValidity(invalidTime ? timeError.textContent : '');
      timeInput.classList.toggle('is-invalid', invalidTime);
      return dateInput.validity.valid && timeInput.validity.valid;
    }

    const customerPhoneInput = document.getElementById('customer-phone');
    const customerFirstNameInput = document.getElementById('customer-first-name');
    const customerLastNameInput = document.getElementById('customer-last-name');
    const orderValidationFields = [
      customerFirstNameInput,
      customerLastNameInput,
      customerPhoneInput,
      document.getElementById('order-channel'),
      document.getElementById('pickup-date'),
      document.getElementById('pickup-time')
    ];

    function validateCustomerNames() {
      customerFirstNameInput.setCustomValidity(customerFirstNameInput.value.trim() ? '' : 'Enter the customer\'s first name.');
      customerLastNameInput.setCustomValidity(customerLastNameInput.value.trim() ? '' : 'Enter the customer\'s last name.');
      return customerFirstNameInput.validity.valid && customerLastNameInput.validity.valid;
    }

    function validateCustomerPhone() {
      const phone = normalizeCustomerPhone(customerPhoneInput.value);
      const phoneError = document.getElementById('customer-phone-error');
      const validDigitCount = /^\d{10}$/.test(phone);
      customerPhoneInput.setCustomValidity(phone && !validDigitCount
        ? 'Enter a valid 10-digit US phone number.' : '');
      phoneError.textContent = phone ? 'Enter a valid 10-digit US phone number.' : 'Enter the customer\'s phone number.';
      return customerPhoneInput.validity.valid;
    }

    function normalizeCustomerPhone(value) {
      let digits = String(value || '').replace(/\D/g, '').slice(0, 11);
      if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
      return digits;
    }

    function maskCustomerPhone(value) {
      const digits = normalizeCustomerPhone(value).slice(0, 10);
      if (!digits) return '';
      if (digits.length <= 3) return '(' + digits;
      if (digits.length <= 6) return '(' + digits.slice(0, 3) + ')' + digits.slice(3);
      return '(' + digits.slice(0, 3) + ')' + digits.slice(3, 6) + '-' + digits.slice(6);
    }

    function formatPhoneNumber(value) {
      const digits = String(value || '').replace(/\D/g, '');
      const localDigits = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      if (localDigits.length !== 10) return value || 'Not provided';
      return '(' + localDigits.slice(0, 3) + ')' + localDigits.slice(3, 6) + '-' + localDigits.slice(6);
    }

    function getSelectedDrink() {
      const selected = document.querySelector('.drink-type-button[aria-pressed="true"]');
      return selected ? selected.dataset.drink : 'Iced tea';
    }

    function clearDrinkSelection() {
      document.querySelectorAll('.drink-type-button').forEach(function (button) {
        const selected = button.dataset.drink === 'Iced tea';
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      document.getElementById('drink-size').value = 'Medium';
      document.getElementById('drink-quantity').value = '1';
      updateDrinkButtonLabel();
    }

    function updateDrinkButtonLabel() {
      const size = document.getElementById('drink-size').value;
      const drink = getSelectedDrink();
      const quantity = Math.max(1, Math.min(MAX_ORDER_ITEMS, Number(document.getElementById('drink-quantity').value) || 1));
      document.getElementById('add-drink').setAttribute('aria-label',
        'Add ' + quantity + ' ' + size.toLowerCase() + ' ' + drink +
        (quantity === 1 ? '' : 's') + ' to order');
    }

    function getCartSubtotalCents() {
      return cartItems.reduce(function (sum, item) { return sum + Math.round(item.unitPrice * 100) * item.quantity; }, 0);
    }

    function getCartTaxCents() {
      return Math.round(getCartSubtotalCents() * TAX_RATE);
    }

    function getCartSubtotal() {
      return getCartSubtotalCents() / 100;
    }

    function getCartTax() {
      return getCartTaxCents() / 100;
    }

    function getCartItemCount() {
      return cartItems.reduce(function (sum, item) { return sum + item.quantity; }, 0);
    }

    function canAddToCart(quantity, input) {
      const currentCount = getCartItemCount();
      if (currentCount + quantity <= MAX_ORDER_ITEMS) {
        document.getElementById('cart-error').hidden = true;
        return true;
      }
      const remaining = Math.max(0, MAX_ORDER_ITEMS - currentCount);
      const error = document.getElementById('cart-error');
      error.textContent = 'An order can contain up to ' + MAX_ORDER_ITEMS + ' total items. There are ' + currentCount +
        ' already in the cart, so you can add at most ' + remaining + ' more.';
      error.hidden = false;
      input.focus();
      return false;
    }

    function getCartTotal() {
      return (getCartSubtotalCents() + getCartTaxCents()) / 100;
    }

    function updateCartTotalAnnouncement() {
      const config = getPizzaConfiguration();
      document.getElementById('cart-total-live').textContent =
        'Subtotal ' + formatMoney(getCartSubtotal()) + '. Tax at 9.75% is ' + formatMoney(getCartTax()) +
        '. Order total ' + formatMoney(getCartTotal()) + '. Current ' + config.size.toLowerCase() +
        ' pizza estimate ' + formatMoney(config.unitPrice) + ' per pizza.';
    }

    function renderCart() {
      const list = document.getElementById('cart-items');
      const emptyMessage = document.getElementById('cart-empty');
      const cartError = document.getElementById('cart-error');
      cartError.textContent = 'Add at least one item before placing the order.';
      cartError.hidden = true;
      if (cartItems.length === 0) {
        list.innerHTML = '';
        emptyMessage.hidden = false;
      } else {
        emptyMessage.hidden = true;
        list.innerHTML = cartItems.map(function (item) {
          const description = item.description ? '<div class="small text-secondary">' + escapeHTML(item.description) + '</div>' : '';
          const removeLabel = 'Remove ' + item.quantity + ' ' + item.name + ' from order';
          return '<li class="list-group-item d-flex flex-column flex-sm-row justify-content-between align-items-sm-center gap-2">' +
            '<div><div class="fw-semibold">' + item.quantity + ' × ' + escapeHTML(item.name) + '</div>' + description +
            '<div class="small text-secondary">' + formatMoney(item.unitPrice) + ' each · ' + formatMoney(item.unitPrice * item.quantity) + ' line total</div></div>' +
            '<div class="d-flex gap-2 align-self-start align-self-sm-center"><button class="btn btn-sm btn-outline-danger" type="button" data-cart-remove="' + item.id +
            '" aria-label="' + escapeHTML(removeLabel) + '" aria-controls="cart-items">Remove</button></div></li>';
        }).join('');
      }
      document.getElementById('cart-subtotal').textContent = formatMoney(getCartSubtotal());
      document.getElementById('cart-tax').textContent = formatMoney(getCartTax());
      document.getElementById('cart-total').textContent = formatMoney(getCartTotal());
      updateCartTotalAnnouncement();
    }

    function validateItemQuantity(input, itemLabel, maximum) {
      const value = input.value.trim();
      const quantity = Number(value);
      let message = '';
      if (!value) message = 'Enter a quantity before adding ' + itemLabel + '.';
      else if (!Number.isInteger(quantity) || quantity < 1 || quantity > maximum) {
        message = 'Enter a whole number from 1 to ' + maximum + '.';
      }
      input.setCustomValidity(message);
      const valid = input.checkValidity();
      input.classList.toggle('is-invalid', !valid);
      if (valid) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', 'true');
      return valid;
    }

    function addPizzaToCart() {
      const quantityInput = document.getElementById('pizza-quantity');
      if (!validateItemQuantity(quantityInput, 'pizza', MAX_ORDER_ITEMS)) {
        quantityInput.reportValidity();
        quantityInput.focus();
        return;
      }
      const config = getPizzaConfiguration();
      if (!canAddToCart(config.quantity, quantityInput)) return;
      const toppingText = config.toppings.map(function (topping) {
        return topping.quantity + '× ' + topping.name;
      }).join(', ');
      const item = {
        id: nextCartItemId++, type: 'Pizza', name: config.size + ' (' + config.pricing.inches + '-inch) pizza',
        quantity: config.quantity, unitPrice: config.unitPrice,
        description: toppingText ? 'Toppings: ' + toppingText : '',
        pizzaSize: config.size, toppings: config.toppings.slice()
      };
      cartItems.push(item);
      clearPizzaSelection();
      quantityInput.classList.remove('is-invalid');
      quantityInput.removeAttribute('aria-invalid');
      renderCart();
      announce(config.quantity + ' ' + config.size.toLowerCase() + ' pizza' + (config.quantity === 1 ? '' : 's') +
        ' added to the order cart. Pizza choices reset to Medium, quantity 1, and no extra toppings.');
    }

    function addDrinkToCart() {
      const quantityInput = document.getElementById('drink-quantity');
      if (!validateItemQuantity(quantityInput, 'drinks', MAX_ORDER_ITEMS)) {
        quantityInput.reportValidity();
        quantityInput.focus();
        return;
      }
      const size = document.getElementById('drink-size').value;
      const drink = getSelectedDrink();
      const quantity = Number(quantityInput.value);
      if (!canAddToCart(quantity, quantityInput)) return;
      const item = {
        id: nextCartItemId++, type: 'Drink', name: size + ' ' + drink, quantity: quantity,
        unitPrice: drinkPricing[size], description: '', drinkName: drink, drinkSize: size
      };
      cartItems.push(item);
      clearDrinkSelection();
      quantityInput.classList.remove('is-invalid');
      quantityInput.removeAttribute('aria-invalid');
      renderCart();
      announce(quantity + ' ' + size.toLowerCase() + ' ' + drink + (quantity === 1 ? '' : 's') +
        ' added to the order cart. Drink choices reset to medium iced tea, quantity 1.');
    }

    async function apiRequest(path, options) {
      if (window.location.protocol === 'file:') {
        throw new Error('Open this dashboard through the Flask server at http://127.0.0.1:5000/ so it can reach the order API.');
      }
      const requestOptions = Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options || {});
      requestOptions.headers = Object.assign({ 'Accept': 'application/json' }, requestOptions.headers || {});
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(requestOptions.method || 'GET').toUpperCase())) {
        requestOptions.headers['X-CSRF-Token'] = document.querySelector('meta[name="csrf-token"]').content;
      }
      const response = await fetch(path, requestOptions);
      let payload = null;
      try { payload = await response.json(); } catch (_error) { /* Non-JSON response */ }
      if (!response.ok) {
        if (response.status === 401 && payload && payload.code === 'authentication_required') {
          window.location.assign('/staff-signin.html?focus=signin');
        }
        if (response.status === 403 && payload && payload.code === 'password_change_required') {
          window.location.assign('/staff-change-password.html?focus=password');
        }
        throw new Error(payload && payload.error ? payload.error : 'Request failed (' + response.status + ').');
      }
      return payload;
    }

    async function listOrders() {
      return apiRequest('/api/employee/orders');
    }

    async function listOrderHistory(page, query) {
      const params = new URLSearchParams({ page: String(page), q: query || '' });
      return apiRequest('/api/employee/order-history?' + params.toString());
    }

    async function createOrder(orderInput) {
      return apiRequest('/api/employee/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(orderInput)
      });
    }

    async function updateOrderStatus(orderId, status) {
      return apiRequest('/api/employee/orders/' + encodeURIComponent(orderId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ status: status })
      });
    }

    function formatTimestamp(timestamp) {
      if (!timestamp) return { label: 'Timestamp unavailable', iso: '' };
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return { label: 'Timestamp unavailable', iso: '' };
      return {
        label: new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date),
        iso: date.toISOString()
      };
    }

    function getOrderTotal(order) {
      if (Number.isFinite(Number(order.totalPrice))) return Number(order.totalPrice);
      return (order.items || []).reduce(function (sum, item) { return sum + item.unitPrice * item.quantity; }, 0);
    }

    function formatPickupSchedule(order) {
      return [order.pickupDate, order.pickupTime].filter(Boolean).join(' ')
        || (order.pickupTime ? order.pickupTime : 'Not specified');
    }

    function formatOrderItems(items) {
      return (items || []).map(function (item) {
        const toppingSummary = item.type === 'Pizza'
          ? (item.toppings || []).map(function (topping) {
            const name = typeof topping === 'string' ? topping : topping.name;
            const quantity = typeof topping === 'string' ? 1 : topping.quantity;
            return escapeHTML(quantity) + '× ' + escapeHTML(name);
          }).join(', ')
          : '';
        const description = toppingSummary ? ' <span class="text-secondary">(Toppings: ' + toppingSummary + ')</span>' : '';
        return '<li>' + escapeHTML(item.quantity) + ' × ' + escapeHTML(item.name) + description + '</li>';
      }).join('');
    }

    function statusBadge(status, orderId) {
      if (status === 'Completed') return '<span class="badge rounded-pill bg-success-subtle text-success-emphasis">Completed</span>';
      const style = statusStyles[status] || statusStyles.Confirmed;
      return '<span data-order-status-badge="' + escapeHTML(orderId) + '" class="badge rounded-pill ' + style + '">' + escapeHTML(status) + '</span>';
    }

    function orderCard(order) {
      const id = escapeHTML(order.id);
      const displayCode = escapeHTML(order.publicOrderCode || order.id);
      const safeId = String(order.id).replace(/[^a-zA-Z0-9_-]/g, '-');
      const detailsId = 'order-details-' + safeId;
      const statusOptions = allowedStatuses.map(function (status) {
        const label = status === 'Completed' ? 'Completed / picked up' : status;
        return '<option value="' + escapeHTML(status) + '"' + (order.status === status ? ' selected' : '') + '>' + escapeHTML(label) + '</option>';
      }).join('');
      const details = [
        '<div class="col-12 col-md-6"><span class="fw-semibold">Phone:</span> ' + escapeHTML(formatPhoneNumber(order.customerPhone)) + '</div>',
        '<div class="col-12 col-md-6"><span class="fw-semibold">Channel:</span> ' + escapeHTML(order.channel || 'Not specified') + '</div>',
        '<div class="col-12 col-md-6"><span class="fw-semibold">Source:</span> ' + escapeHTML(order.source || 'Order system') + '</div>',
        '<div class="col-12"><span class="fw-semibold">Notes:</span> ' + escapeHTML(order.notes || 'None') + '</div>'
      ].join('');
      const taxDetails = Number.isFinite(Number(order.taxPrice))
        ? ' <span class="small text-secondary">(includes ' + formatMoney(order.taxPrice) + ' tax)</span>' : '';
      return '<article class="card" data-order-card="' + id + '"><div class="card-body p-3 p-md-4">' +
        '<div class="d-flex flex-column flex-lg-row justify-content-between gap-3"><div class="flex-grow-1">' +
        '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><h4 class="h6 mb-0">Order ' + displayCode + '</h4>' +
        statusBadge(order.status, order.id) + '<span class="badge rounded-pill bg-body-secondary text-body-secondary">' + escapeHTML(order.source || 'Order system') + '</span></div>' +
        '<p class="mb-1"><strong>' + escapeHTML(order.customerName) + '</strong></p><p class="small mb-2"><span class="fw-semibold">Items:</span></p>' +
        '<ul class="small mb-2">' + formatOrderItems(order.items) + '</ul>' +
        '<p class="small mb-2"><span class="fw-semibold">Order total:</span> ' + formatMoney(getOrderTotal(order)) + taxDetails +
        ' <span class="text-secondary">· Pickup ' + escapeHTML(formatPickupSchedule(order)) + '</span></p>' +
        '<button class="btn btn-sm btn-link link-danger px-0 py-1" type="button" data-details-button="' + id +
        '" aria-label="Show details for order ' + id + '" aria-expanded="false" aria-controls="' + detailsId + '">Show order details</button>' +
        '<div id="' + detailsId + '" class="row g-2 small mt-1" hidden>' + details + '</div></div>' +
        '<div class="d-flex flex-column flex-sm-row flex-lg-column align-items-stretch gap-2">' +
        '<label class="visually-hidden" for="status-' + safeId + '">Status for order ' + id + '</label>' +
        '<select class="form-select form-select-sm" id="status-' + safeId + '" data-status-select="' + id + '" aria-label="Choose new status for order ' + id + '">' + statusOptions + '</select>' +
        '<button class="btn btn-sm btn-outline-danger" type="button" data-status-button="' + id + '" aria-label="Save status for order ' + id +
        '" aria-controls="active-orders-list">Update status</button></div></div></div></article>';
    }

    function synchronizeActiveOrders(orders) {
      const existingCards = new Map();
      const previousOrders = new Map(activeOrders.map(function (order) { return [String(order.id), order]; }));
      activeOrdersList.querySelectorAll('[data-order-card]').forEach(function (card) {
        existingCards.set(card.dataset.orderCard, card);
      });
      const nextIds = new Set(orders.map(function (order) { return String(order.id); }));

      existingCards.forEach(function (card, id) {
        if (nextIds.has(id)) return;
        if (card.contains(document.activeElement)) document.getElementById('refresh-orders').focus();
        card.remove();
      });

      for (let index = orders.length - 1; index >= 0; index -= 1) {
        const order = orders[index];
        const existingCard = existingCards.get(String(order.id));
        if (existingCard && existingCard.isConnected) {
          const previousOrder = previousOrders.get(String(order.id));
          if (!previousOrder || previousOrder.status !== order.status) updateOrderStatusInUi(order, true);
        } else {
          activeOrdersList.insertAdjacentHTML('afterbegin', orderCard(order));
        }
      }

      activeOrders = orders;
      document.getElementById('empty-orders').hidden = orders.length !== 0;
      document.getElementById('order-count').textContent = String(orders.length);
    }

    function historyCard(order) {
      const id = escapeHTML(order.id);
      const displayCode = escapeHTML(order.publicOrderCode || order.id);
      const timestamp = formatTimestamp(order.completedAt);
      const timeTag = timestamp.iso ? '<time datetime="' + escapeHTML(timestamp.iso) + '">' + escapeHTML(timestamp.label) + '</time>' : escapeHTML(timestamp.label);
      const taxDetails = Number.isFinite(Number(order.taxPrice))
        ? '<span class="small text-secondary"> (includes ' + formatMoney(order.taxPrice) + ' tax)</span>' : '';
      return '<article class="card"><div class="card-body p-3 p-md-4">' +
        '<div class="d-flex flex-column flex-md-row justify-content-between gap-3"><div class="flex-grow-1">' +
        '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><h4 class="h6 mb-0">Order ' + displayCode + '</h4>' +
        '<span class="badge rounded-pill bg-success-subtle text-success-emphasis">Completed</span></div>' +
        '<p class="mb-1"><strong>' + escapeHTML(order.customerName) + '</strong></p>' +
        '<p class="small text-secondary mb-2"><span class="fw-semibold">Phone:</span> ' + escapeHTML(formatPhoneNumber(order.customerPhone)) + '</p>' +
        '<p class="small fw-semibold mb-1">Items ordered</p><ul class="small mb-0">' + formatOrderItems(order.items) + '</ul></div>' +
        '<div class="text-md-end"><p class="h6 mb-2">Total: ' + formatMoney(getOrderTotal(order)) + taxDetails + '</p>' +
        '<p class="small mb-0"><span class="fw-semibold">Completed:</span> ' + timeTag + '</p></div></div></div></article>';
    }

    async function renderOrders() {
      try {
        const orders = await listOrders();
        activeOrders = orders;
        activeOrdersList.innerHTML = orders.map(orderCard).join('');
        const loadError = document.getElementById('orders-load-error');
        loadError.hidden = true;
        loadError.textContent = '';
        document.getElementById('empty-orders').hidden = orders.length !== 0;
        document.getElementById('order-count').textContent = String(orders.length);
        await checkForOverdueOrders();
      } catch (error) {
        const loadError = document.getElementById('orders-load-error');
        loadError.textContent = 'Could not load active orders. ' + error.message;
        loadError.hidden = false;
        document.getElementById('empty-orders').hidden = true;
        announce('Could not load active orders. ' + error.message);
      }
    }

    function updateOrderStatusInUi(order, preserveFocusedSelection) {
      const card = activeOrdersList.querySelector('[data-order-card="' + CSS.escape(String(order.id)) + '"]');
      if (!card) return;
      const badge = card.querySelector('[data-order-status-badge]');
      if (badge) {
        badge.textContent = order.status;
        badge.classList.remove('bg-warning-subtle', 'text-warning-emphasis', 'bg-info-subtle', 'text-info-emphasis', 'bg-success-subtle', 'text-success-emphasis', 'bg-danger-subtle', 'text-danger-emphasis');
        badge.classList.add.apply(badge.classList, (statusStyles[order.status] || statusStyles.Confirmed).split(' '));
      }
      const statusSelect = card.querySelector('[data-status-select]');
      if (statusSelect && !(preserveFocusedSelection && statusSelect === document.activeElement)) {
        statusSelect.value = order.status;
      }
    }

    async function checkForOverdueOrders(refreshFromApi) {
      if (overdueCheckRunning) return;
      overdueCheckRunning = true;
      const overdueError = document.getElementById('overdue-update-error');
      try {
        const previousStatuses = new Map(activeOrders.map(function (order) { return [String(order.id), order.status]; }));
        // The API evaluates pickup times in BUSINESS_TIMEZONE and returns the
        // authoritative Overdue status; browser timezone and clock are ignored.
        synchronizeActiveOrders(await listOrders());
        const newlyOverdue = activeOrders.filter(function (order) {
          return order.status === 'Overdue' && previousStatuses.get(String(order.id)) !== 'Overdue';
        });
        overdueError.hidden = true;
        overdueError.textContent = '';
        if (newlyOverdue.length) {
          announce('Order' + (newlyOverdue.length === 1 ? ' ' : 's ') + newlyOverdue.map(function (order) {
            return String(order.publicOrderCode || order.id);
          }).join(', ') + ' automatically marked overdue using the restaurant timezone.');
        }
      } catch (error) {
        overdueError.textContent = 'Could not refresh pickup statuses. ' + error.message;
        overdueError.hidden = false;
      } finally {
        overdueCheckRunning = false;
      }
    }

    async function renderHistory(options) {
      const requestedPage = options && Number.isInteger(options.page) ? Math.max(0, options.page) : 0;
      const requestId = ++historyRequestId;
      const query = document.getElementById('history-search').value.trim();
      const list = document.getElementById('history-list');
      const status = document.getElementById('history-status');
      const nextPageButton = document.getElementById('history-next-page');
      const previousPageButton = document.getElementById('history-previous-page');
      const pagination = document.getElementById('history-pagination');
      list.replaceChildren();
      list.setAttribute('aria-busy', 'true');
      status.textContent = 'Loading completed orders.';
      nextPageButton.disabled = true;
      previousPageButton.disabled = true;
      try {
        const payload = await listOrderHistory(requestedPage, query);
        if (requestId !== historyRequestId) return;
        const orders = payload.orders || [];
        const cards = orders.map(historyCard).join('');
        list.innerHTML = cards;
        historyPage = requestedPage;
        historyHasMore = Boolean(payload.hasMore);
        historyTotal = Number(payload.total) || 0;
        const loadError = document.getElementById('history-load-error');
        loadError.hidden = true;
        loadError.textContent = '';
        document.getElementById('empty-history').hidden = list.children.length !== 0;
        document.getElementById('history-count').textContent = String(historyTotal);
        const pageCount = Math.max(1, Math.ceil(historyTotal / 20));
        const firstItem = historyTotal ? requestedPage * 20 + 1 : 0;
        const lastItem = Math.min((requestedPage + 1) * 20, historyTotal);
        status.textContent = historyTotal
          ? 'Showing orders ' + firstItem + ' to ' + lastItem + ' of ' + historyTotal + '.'
          : (query ? 'No completed orders match your search.' : 'No completed orders are in history.');
        document.getElementById('history-page-label').textContent = 'Page ' + (requestedPage + 1) + ' of ' + pageCount;
        pagination.hidden = pageCount <= 1;
        previousPageButton.disabled = requestedPage <= 0;
        nextPageButton.disabled = !historyHasMore;
      } catch (error) {
        if (requestId !== historyRequestId) return;
        const loadError = document.getElementById('history-load-error');
        loadError.textContent = 'Could not load order history. ' + error.message;
        loadError.hidden = false;
        document.getElementById('empty-history').hidden = true;
        pagination.hidden = historyTotal <= 20;
        announce('Could not load order history. ' + error.message);
      } finally {
        if (requestId === historyRequestId) {
          list.removeAttribute('aria-busy');
          nextPageButton.disabled = !historyHasMore;
          previousPageButton.disabled = historyPage <= 0;
        }
      }
    }

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const currentStaff = {
      id: Number(document.body.dataset.staffId),
      name: document.body.dataset.staffName,
      role: document.body.dataset.staffRole
    };
    const sidebar = document.getElementById('dashboard-sidebar');
    const mainColumn = document.getElementById('dashboard-main-column');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    sidebarToggle.addEventListener('click', function () {
      const hideSidebar = sidebarToggle.getAttribute('aria-expanded') === 'true';
      sidebar.hidden = hideSidebar;
      sidebarToggle.setAttribute('aria-expanded', String(!hideSidebar));
      const label = hideSidebar ? 'Show navigation sidebar' : 'Hide navigation sidebar';
      sidebarToggle.setAttribute('aria-label', label);
      sidebarToggle.setAttribute('title', label);
      mainColumn.classList.toggle('col-md-9', !hideSidebar);
      mainColumn.classList.toggle('col-lg-10', !hideSidebar);
    });
    sidebar.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !sidebar.hidden) {
        sidebar.hidden = true;
        sidebarToggle.setAttribute('aria-expanded', 'false');
        sidebarToggle.setAttribute('aria-label', 'Show navigation sidebar');
        sidebarToggle.setAttribute('title', 'Show navigation sidebar');
        mainColumn.classList.remove('col-md-9', 'col-lg-10');
        sidebarToggle.focus();
      }
    });
    const roleLevels = { employee: 1, manager: 2, owner: 3 };
    const roleNames = { employee: 'Employee', manager: 'Manager', owner: 'Owner' };
    const salesSummaryStatus = document.getElementById('sales-summary-status');
    const salesSummaryError = document.getElementById('sales-summary-error');
    const salesSummaryContent = document.getElementById('sales-summary-content');
    const salesSummaryTableBody = document.getElementById('sales-summary-table-body');
    const salesSummaryUpdated = document.getElementById('sales-summary-updated');
    const refreshSalesSummaryButton = document.getElementById('refresh-sales-summary');
    const salesCompareDate = document.getElementById('sales-compare-date');
    const salesCompareMode = document.getElementById('sales-compare-mode');
    const salesCompareButton = document.getElementById('compare-sales-button');
    const salesComparisonBody = document.getElementById('sales-comparison-table-body');
    salesCompareDate.max = localDateInputValue(new Date());
    salesCompareDate.value = salesCompareDate.max;
    let salesSummaryRequestActive = false;
    let lastSalesSummaryFingerprint = null;

    function createSalesSummaryRow(period, summary) {
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = period;
      row.append(heading);
      [String(summary.orders), formatMoney(summary.averageOrder), formatMoney(summary.sales)].forEach(function (value) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      return row;
    }

    function renderSalesComparison(comparison) {
      const current = comparison.current || {orders: 0, averageOrder: 0, sales: 0};
      const selected = comparison.selected || {orders: 0, averageOrder: 0, sales: 0};
      document.getElementById('sales-comparison-current-heading').textContent = comparison.currentLabel;
      document.getElementById('sales-comparison-selected-heading').textContent = comparison.selectedLabel;
      document.getElementById('sales-comparison-label').textContent = comparison.selectedLabel + ' compared with ' + comparison.currentLabel;
      const rows = [
        {label: 'Sales', current: Number(current.sales) || 0, selected: Number(selected.sales) || 0, format: formatMoney},
        {label: 'Orders', current: Number(current.orders) || 0, selected: Number(selected.orders) || 0, format: function (value) { return String(value); }},
        {label: 'Average order', current: Number(current.averageOrder) || 0, selected: Number(selected.averageOrder) || 0, format: formatMoney}
      ];
      salesComparisonBody.replaceChildren();
      rows.forEach(function (metric) {
        const row = document.createElement('tr');
        const heading = document.createElement('th');
        heading.scope = 'row';
        heading.textContent = metric.label;
        const currentCell = document.createElement('td');
        currentCell.textContent = metric.format(metric.current);
        const selectedCell = document.createElement('td');
        selectedCell.textContent = metric.format(metric.selected);
        const differenceCell = document.createElement('td');
        const delta = metric.selected - metric.current;
        differenceCell.textContent = (delta > 0 ? '+' : '') + metric.format(delta);
        row.append(heading, currentCell, selectedCell, differenceCell);
        salesComparisonBody.append(row);
      });
    }

    async function loadManagerSalesSummary(options) {
      const shouldAnnounce = !options || options.announce !== false;
      if (salesSummaryRequestActive || !['manager', 'owner'].includes(currentStaff.role)) return;
      salesSummaryRequestActive = true;
      salesSummaryContent.setAttribute('aria-busy', 'true');
      if (shouldAnnounce) refreshSalesSummaryButton.disabled = true;
      if (shouldAnnounce) salesCompareButton.disabled = true;
      try {
        const query = new URLSearchParams({date: salesCompareDate.value, compare: salesCompareMode.value});
        const summary = await apiRequest('/api/staff/sales-summary?' + query.toString());
        const today = summary.today || { orders: 0, averageOrder: 0, sales: 0 };
        const week = summary.week || { orders: 0, averageOrder: 0, sales: 0 };
        const comparison = summary.comparison;
        const fingerprint = [today.orders, today.averageOrder, today.sales, week.orders, week.averageOrder, week.sales,
          comparison && comparison.selected.orders, comparison && comparison.selected.sales].join('|');
        const changed = lastSalesSummaryFingerprint !== null && lastSalesSummaryFingerprint !== fingerprint;

        document.getElementById('today-sales-total').textContent = formatMoney(today.sales);
        document.getElementById('today-sales-orders').textContent = today.orders + (today.orders === 1 ? ' order today' : ' orders today');
        document.getElementById('week-sales-total').textContent = formatMoney(week.sales);
        document.getElementById('week-sales-orders').textContent = week.orders + (week.orders === 1 ? ' order this week' : ' orders this week');
        salesSummaryTableBody.replaceChildren(
          createSalesSummaryRow('Today', today),
          createSalesSummaryRow('This week', week)
        );
        if (comparison) renderSalesComparison(comparison);
        const generatedAt = new Date(summary.generatedAt);
        salesSummaryUpdated.textContent = Number.isNaN(generatedAt.getTime())
          ? ''
          : 'Last updated ' + new Intl.DateTimeFormat('en-US', {
            dateStyle: 'medium', timeStyle: 'short', timeZone: summary.timezone
          }).format(generatedAt) + ' (' + summary.timezone + ').';
        salesSummaryError.hidden = true;
        salesSummaryError.textContent = '';
        if (changed) salesSummaryStatus.textContent = 'New sales activity is reflected in the summary.';
        else if (shouldAnnounce) salesSummaryStatus.textContent = 'Sales summary refreshed.';
        else if (lastSalesSummaryFingerprint === null) salesSummaryStatus.textContent = 'Live sales tracking is connected.';
        lastSalesSummaryFingerprint = fingerprint;
      } catch (error) {
        salesSummaryError.textContent = 'Could not load sales totals. ' + error.message;
        salesSummaryError.hidden = false;
        if (shouldAnnounce) salesSummaryStatus.textContent = 'Sales summary could not be refreshed.';
      } finally {
        salesSummaryContent.setAttribute('aria-busy', 'false');
        salesSummaryRequestActive = false;
        if (shouldAnnounce) refreshSalesSummaryButton.disabled = false;
        if (shouldAnnounce) salesCompareButton.disabled = false;
      }
    }

    let managerSpecials = [];
    let specialsRequestActive = false;

    function showSpecialMessage(message, isError) {
      const target = document.getElementById('specials-message');
      target.textContent = message;
      target.className = 'alert mb-3 ' + (isError ? 'alert-danger' : 'alert-success');
      target.setAttribute('role', isError ? 'alert' : 'status');
      target.setAttribute('aria-live', isError ? 'assertive' : 'polite');
      target.hidden = !message;
    }

    function renderSpecialToppings(selected) {
      const counts = new Map((selected || []).map(function (topping) { return [topping.name, Number(topping.quantity) || 0]; }));
      const groups = {Meats: ['Pepperoni', 'Italian sausage', 'Beef'], Vegetables: ['Green peppers', 'Jalapenos', 'Onion', 'Black olives', 'Diced tomatoes'], Fruit: ['Pineapple']};
      const container = document.getElementById('special-toppings');
      container.replaceChildren();
      Object.keys(groups).forEach(function (category) {
        const col = document.createElement('div');
        col.className = 'col-12 col-lg-4';
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'border rounded p-2 h-100';
        const legend = document.createElement('legend');
        legend.className = 'h6 px-1';
        legend.textContent = category;
        fieldset.append(legend);
        groups[category].forEach(function (name) {
          const row = document.createElement('div');
          row.className = 'd-flex align-items-center justify-content-between gap-2 py-1';
          const label = document.createElement('span');
          label.className = 'small';
          label.textContent = name;
          const controls = document.createElement('div');
          controls.className = 'btn-group btn-group-sm';
          controls.setAttribute('role', 'group');
          controls.setAttribute('aria-label', name + ' servings');
          const count = counts.get(name) || 0;
          const remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'btn btn-outline-secondary'; remove.dataset.specialTopping = name; remove.dataset.change = '-1';
          remove.textContent = '−'; remove.disabled = count <= 0; remove.setAttribute('aria-label', 'Remove one serving of ' + name);
          const value = document.createElement('span');
          value.className = 'btn btn-light border topping-count'; value.textContent = count + 'x'; value.setAttribute('aria-live', 'polite'); value.setAttribute('aria-label', count + ' servings of ' + name);
          const add = document.createElement('button');
          add.type = 'button'; add.className = 'btn btn-outline-danger'; add.dataset.specialTopping = name; add.dataset.change = '1';
          add.textContent = '+'; add.disabled = count >= MAX_TOPPING_SERVINGS; add.setAttribute('aria-label', 'Add one serving of ' + name + (count >= MAX_TOPPING_SERVINGS ? ', maximum reached' : ''));
          controls.append(remove, value, add); row.append(label, controls); fieldset.append(row);
        });
        col.append(fieldset); container.append(col);
      });
      updateSpecialEstimate();
    }

    function selectedSpecialToppings() {
      return Array.from(document.querySelectorAll('#special-toppings .topping-count')).map(function (count) {
        const name = count.getAttribute('aria-label').replace(/^\d+ servings? of /, '');
        const quantity = Number.parseInt(count.textContent, 10) || 0;
        return {name: name, quantity: quantity};
      }).filter(function (topping) { return topping.quantity > 0; });
    }

    function updateSpecialEstimate() {
      const size = document.getElementById('special-size').value;
      const price = pizzaPricing[size];
      const servings = selectedSpecialToppings().reduce(function (sum, topping) { return sum + topping.quantity; }, 0);
      document.getElementById('special-estimate').textContent = 'Estimated pizza price: ' + formatMoney(price.base + servings * price.topping);
    }

    function renderCurrentSpecials() {
      const container = document.getElementById('current-specials');
      container.replaceChildren();
      managerSpecials.forEach(function (special, index) {
        const col = document.createElement('div'); col.className = 'col-12 col-md-6';
        const card = document.createElement('article'); card.className = 'card h-100';
        const body = document.createElement('div'); body.className = 'card-body';
        const heading = document.createElement('h5'); heading.className = 'h6'; heading.textContent = 'Special ' + (index + 1) + ': ' + special.name;
        const description = document.createElement('p'); description.className = 'small text-secondary'; description.textContent = special.description || 'No description provided.';
        const toppings = document.createElement('p'); toppings.className = 'small mb-3'; toppings.textContent = special.size + ' · ' + (special.toppings.map(function (t) { return (t.quantity > 1 ? t.quantity + '× ' : '') + t.name; }).join(', ') || 'Cheese and marinara');
        const replace = document.createElement('button'); replace.type = 'button'; replace.className = 'btn btn-sm btn-outline-danger'; replace.dataset.editSpecial = String(index); replace.textContent = 'Replace this special';
        body.append(heading, description, toppings, replace); card.append(body); col.append(card); container.append(col);
      });
      container.setAttribute('aria-busy', 'false');
    }

    function fillSpecialForm(index, moveFocus) {
      const special = managerSpecials[index];
      if (!special) return;
      document.getElementById('special-slot').value = String(index);
      document.getElementById('special-name').value = special.name;
      document.getElementById('special-description').value = special.description || '';
      document.getElementById('special-size').value = special.size;
      renderSpecialToppings(special.toppings);
      if (moveFocus) document.getElementById('special-name').focus();
    }

    async function loadManagerSpecials() {
      if (specialsRequestActive || !['manager', 'owner'].includes(currentStaff.role)) return;
      specialsRequestActive = true;
      const list = document.getElementById('current-specials');
      list.setAttribute('aria-busy', 'true');
      try {
        const payload = await apiRequest('/api/customer/specials');
        managerSpecials = payload.specials || [];
        renderCurrentSpecials();
        fillSpecialForm(Number(document.getElementById('special-slot').value) || 0, false);
        showSpecialMessage('', false);
      } catch (error) {
        list.setAttribute('aria-busy', 'false');
        showSpecialMessage('Could not load specials. ' + error.message, true);
      } finally { specialsRequestActive = false; }
    }

    document.getElementById('special-toppings').addEventListener('click', function (event) {
      const button = event.target.closest('[data-special-topping]');
      if (!button) return;
      const current = Number(button.parentElement.querySelector('.topping-count').textContent) || 0;
      const next = Math.max(0, Math.min(MAX_TOPPING_SERVINGS, current + Number(button.dataset.change)));
      const name = button.dataset.specialTopping;
      const toppings = selectedSpecialToppings().filter(function (t) { return t.name !== name; });
      if (next) toppings.push({name: name, quantity: next});
      renderSpecialToppings(toppings);
      document.getElementById('special-topping-status').textContent = name + ': ' + next + (next === 1 ? ' serving selected.' : ' servings selected.') + ' Maximum 3.';
    });
    document.getElementById('special-size').addEventListener('change', updateSpecialEstimate);
    document.getElementById('special-slot').addEventListener('change', function () { fillSpecialForm(Number(this.value), false); });
    document.getElementById('current-specials').addEventListener('click', function (event) {
      const button = event.target.closest('[data-edit-special]');
      if (!button) return;
      fillSpecialForm(Number(button.dataset.editSpecial), true);
    });
    document.getElementById('clear-special-form').addEventListener('click', function () {
      document.getElementById('special-form').reset(); renderSpecialToppings([]); document.getElementById('special-name').focus();
    });
    document.getElementById('special-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!this.reportValidity()) return;
      const slot = Number(document.getElementById('special-slot').value);
      const next = {name: document.getElementById('special-name').value.trim(), description: document.getElementById('special-description').value.trim(), size: document.getElementById('special-size').value, toppings: selectedSpecialToppings()};
      const updated = managerSpecials.slice(); updated[slot] = next;
      const button = document.getElementById('save-special'); button.disabled = true;
      try {
        const payload = await apiRequest('/api/staff/specials', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({specials: updated})});
        managerSpecials = payload.specials || updated; renderCurrentSpecials();
        showSpecialMessage('Special ' + (slot + 1) + ' saved. Customers without order history will see it.');
      } catch (error) { showSpecialMessage('Special could not be saved. ' + error.message, true); }
      finally { button.disabled = false; }
    });

    function roleCanSee(element) {
      const requiredRole = element.dataset.minimumRole;
      return !requiredRole || (roleLevels[currentStaff.role] || 0) >= roleLevels[requiredRole];
    }

    function availableTabs() {
      return tabs.filter(function (tab) { return !tab.hidden; });
    }

    function activateTab(tab, moveFocus) {
      if (!tab || tab.hidden) return;
      tabs.forEach(function (item) {
        const selected = item === tab;
        const panel = document.getElementById(item.dataset.panel);
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        item.classList.toggle('active', selected);
        item.classList.toggle('text-dark', !selected);
        item.classList.toggle('bg-danger-subtle', selected);
        item.classList.toggle('text-danger-emphasis', selected);
        const allowed = roleCanSee(item);
        item.hidden = !allowed;
        panel.hidden = !selected || !allowed;
        panel.setAttribute('aria-hidden', String(panel.hidden));
      });
      if (moveFocus !== false) tab.focus();
      if (tab.id === 'orders-tab') renderOrders();
      if (tab.id === 'history-tab') renderHistory();
      if (tab.id === 'manager-tab') { loadManagerSalesSummary(); loadManagerSpecials(); }
      if (tab.id === 'customers-tab') loadCustomerDirectory();
    }

    function applyStaffAccess() {
      const sessionLabel = document.getElementById('staff-session-label');
      const signOutButton = document.getElementById('dashboard-staff-signout');
      sessionLabel.textContent = 'Signed in: ' + currentStaff.name + ' · ' + roleNames[currentStaff.role];
      sessionLabel.hidden = false;
      signOutButton.hidden = false;

      document.querySelectorAll('[data-minimum-role]').forEach(function (element) {
        if (element.getAttribute('role') === 'tabpanel') {
          if (!roleCanSee(element)) {
            element.hidden = true;
            element.setAttribute('aria-hidden', 'true');
          }
        } else {
          element.hidden = !roleCanSee(element);
          element.setAttribute('aria-hidden', String(element.hidden));
        }
      });

      const selectedTab = tabs.find(function (tab) {
        return tab.getAttribute('aria-selected') === 'true' && roleCanSee(tab);
      });
      const firstAvailableTab = tabs.find(roleCanSee);
      activateTab(selectedTab || firstAvailableTab, false);

    }

    document.getElementById('dashboard-staff-signout').addEventListener('click', async function (event) {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await apiRequest('/api/staff/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        window.location.assign('/staff-signin.html?focus=signin');
      } catch (error) {
        button.disabled = false;
        announce('Sign out could not be completed. ' + error.message);
      }
    });

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activateTab(tab, false); });
      tab.addEventListener('keydown', function (event) {
        const visibleTabs = availableTabs();
        const currentIndex = visibleTabs.indexOf(tab);
        if (currentIndex === -1) return;
        let nextIndex = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % visibleTabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = visibleTabs.length - 1;
        if (nextIndex !== null) {
          event.preventDefault();
          activateTab(visibleTabs[nextIndex], true);
        }
      });
    });
    applyStaffAccess();
    if (new URLSearchParams(window.location.search).get('focus') === 'dashboard') {
      window.requestAnimationFrame(function () {
        document.getElementById('dashboard-heading').focus();
      });
    }

    const employeeAccessForm = document.getElementById('employee-access-form');
    const staffAccountList = document.getElementById('staff-account-list');
    const staffAccessMessage = document.getElementById('staff-access-message');
    const employeeRoleInput = document.getElementById('employee-role');
    const managerRoleOption = document.getElementById('manager-role-option');
    const employeeAccountIdInput = document.getElementById('employee-account-id');
    const employeeTempPasswordInput = document.getElementById('employee-temp-password');
    const employeeTempPasswordField = document.getElementById('employee-temp-password-field');
    const employeeAccountSubmit = document.getElementById('employee-account-submit');
    const cancelAccountEdit = document.getElementById('cancel-account-edit');
    const staffAccountsById = new Map();
    const customerDirectoryList = document.getElementById('customer-directory-list');
    const customerDirectoryStatus = document.getElementById('customer-directory-status');
    const customerSearchInput = document.getElementById('customer-search');
    const customerSearchForm = document.getElementById('customer-search-form');
    const customerHistorySection = document.getElementById('customer-order-history');
    const customerOrdersList = document.getElementById('customer-orders-list');
    const customerOrdersStatus = document.getElementById('customer-orders-status');
    const customerRecordsByEmail = new Map();
    let customerSearchTimer = null;
    let customerDirectoryRequestId = 0;
    let customerHistoryRequestId = 0;
    managerRoleOption.hidden = currentStaff.role !== 'owner';

    function clearAccountForm() {
      employeeAccessForm.reset();
      employeeAccessForm.classList.remove('was-validated');
      employeeAccountIdInput.value = '';
      employeeTempPasswordField.hidden = false;
      employeeTempPasswordInput.required = true;
      employeeAccountSubmit.textContent = 'Create staff account';
      cancelAccountEdit.hidden = true;
    }

    function beginAccountEdit(account) {
      employeeAccountIdInput.value = String(account.id);
      document.getElementById('employee-first-name').value = account.firstName || (account.fullName || '').trim().split(/\s+/)[0] || '';
      document.getElementById('employee-last-name').value = account.lastName || (account.fullName || '').trim().split(/\s+/).slice(1).join(' ');
      document.getElementById('employee-email').value = account.email;
      employeeRoleInput.value = account.role;
      employeeTempPasswordInput.value = '';
      employeeTempPasswordInput.required = false;
      employeeTempPasswordField.hidden = true;
      employeeAccountSubmit.textContent = 'Save account changes';
      cancelAccountEdit.hidden = false;
      document.getElementById('employee-first-name').focus();
    }

    function showStaffAccessMessage(text, isError) {
      staffAccessMessage.textContent = text;
      staffAccessMessage.className = 'alert mb-3 ' + (isError ? 'alert-danger' : 'alert-success');
      staffAccessMessage.setAttribute('role', isError ? 'alert' : 'status');
      staffAccessMessage.setAttribute('aria-live', isError ? 'assertive' : 'polite');
      staffAccessMessage.hidden = false;
    }

    function renderStaffAccounts(accounts) {
      staffAccountList.replaceChildren();
      staffAccountsById.clear();
      if (accounts.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'list-group-item text-secondary';
        empty.textContent = 'No staff accounts are available to manage.';
        staffAccountList.append(empty);
        return;
      }

      accounts.forEach(function (account) {
        staffAccountsById.set(String(account.id), account);
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-2';

        const details = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'fw-semibold';
        name.textContent = account.fullName;
        const meta = document.createElement('div');
        meta.className = 'small text-secondary';
        meta.textContent = account.email + ' · ' + roleNames[account.role] + ' · ' + (account.isActive ? 'Active' : 'Inactive') +
          (account.mustChangePassword ? ' · Must change temporary password' : '');
        details.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'd-flex flex-wrap gap-2';
        const edit = document.createElement('button');
        edit.className = 'btn btn-sm btn-outline-secondary';
        edit.type = 'button';
        edit.dataset.staffEditId = String(account.id);
        edit.setAttribute('aria-controls', 'employee-access-form');
        edit.setAttribute('aria-label', 'Edit ' + account.fullName + ' (' + account.email + ')');
        edit.textContent = 'Edit';
        edit.disabled = account.id === currentStaff.id || account.role === 'owner';

        const action = document.createElement('button');
        action.className = account.isActive ? 'btn btn-sm btn-outline-danger' : 'btn btn-sm btn-outline-success';
        action.type = 'button';
        action.dataset.staffAccountId = String(account.id);
        action.dataset.nextActive = String(!account.isActive);
        action.setAttribute('aria-controls', 'staff-account-list');
        action.setAttribute('aria-label', (account.isActive ? 'Deactivate ' : 'Reactivate ') + account.fullName + ' (' + account.email + ')');
        action.textContent = account.isActive ? 'Deactivate' : 'Reactivate';
        action.disabled = account.id === currentStaff.id || account.role === 'owner';
        actions.append(edit, action);
        if (!account.isActive && account.role !== 'owner') {
          const deleteButton = document.createElement('button');
          deleteButton.className = 'btn btn-sm btn-outline-danger';
          deleteButton.type = 'button';
          deleteButton.dataset.staffDeleteId = String(account.id);
          deleteButton.setAttribute('aria-controls', 'staff-account-list');
          deleteButton.setAttribute('aria-label', 'Delete deactivated account for ' + account.fullName + ' (' + account.email + ')');
          deleteButton.textContent = 'Delete';
          actions.append(deleteButton);
        }
        item.append(details, actions);
        staffAccountList.append(item);
      });
    }

    async function loadStaffAccounts() {
      if (!['manager', 'owner'].includes(currentStaff.role)) return;
      staffAccountList.setAttribute('aria-busy', 'true');
      try {
        const payload = await apiRequest('/api/staff/accounts');
        renderStaffAccounts(payload.accounts || []);
      } catch (error) {
        showStaffAccessMessage(error.message, true);
        announce('Staff accounts could not be loaded. ' + error.message);
      } finally {
        staffAccountList.removeAttribute('aria-busy');
      }
    }

    function renderCustomerDirectory(customers) {
      customerDirectoryList.replaceChildren();
      customerRecordsByEmail.clear();
      if (customers.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'list-group-item text-secondary';
        empty.textContent = 'No registered customer accounts match this search.';
        customerDirectoryList.append(empty);
        customerDirectoryStatus.textContent = 'No registered customer accounts found.';
        return;
      }

      customers.forEach(function (customer) {
        customerRecordsByEmail.set(String(customer.email), customer);
        const item = document.createElement('li');
        item.className = 'list-group-item';
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'btn btn-link link-dark text-start text-decoration-none p-0 w-100';
        select.dataset.customerEmail = String(customer.email);
        select.setAttribute('aria-controls', 'customer-order-history');
        select.setAttribute('aria-expanded', 'false');
        select.setAttribute('aria-label', 'View order history for registered account ' + customer.fullName);

        const name = document.createElement('span');
        name.className = 'd-block fw-semibold';
        name.textContent = customer.fullName || [customer.firstName, customer.lastName].filter(Boolean).join(' ');
        const details = document.createElement('span');
        details.className = 'd-block small text-secondary';
        const contact = [formatPhoneNumber(customer.phone), customer.email].filter(Boolean).join(' · ');
        details.textContent = contact;
        select.append(name, details);
        item.append(select);
        customerDirectoryList.append(item);
      });
      customerDirectoryStatus.textContent = customers.length + (customers.length === 1 ? ' registered customer account found.' : ' registered customer accounts found.');
    }

    async function loadCustomerDirectory() {
      if (!['manager', 'owner'].includes(currentStaff.role)) return;
      const requestId = ++customerDirectoryRequestId;
      const query = customerSearchInput.value.trim();
      const url = '/api/staff/customers' + (query ? '?q=' + encodeURIComponent(query) : '');
      customerHistorySection.hidden = true;
      customerOrdersList.replaceChildren();
      customerDirectoryList.setAttribute('aria-busy', 'true');
      customerDirectoryStatus.textContent = 'Loading customers.';
      try {
        const payload = await apiRequest(url);
        if (requestId !== customerDirectoryRequestId) return;
        renderCustomerDirectory(payload.customers || []);
      } catch (error) {
        if (requestId !== customerDirectoryRequestId) return;
        customerDirectoryList.replaceChildren();
        customerDirectoryStatus.textContent = 'Customer list could not be loaded. ' + error.message;
        announce('Customer list could not be loaded. ' + error.message);
      } finally {
        if (requestId === customerDirectoryRequestId) customerDirectoryList.removeAttribute('aria-busy');
      }
    }

    function renderCustomerOrders(orders) {
      customerOrdersList.replaceChildren();
      if (orders.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'text-secondary';
        empty.textContent = 'This customer has no recorded orders.';
        customerOrdersList.append(empty);
        return;
      }
      orders.forEach(function (order) {
        const card = document.createElement('article');
        card.className = 'card border';
        const body = document.createElement('div');
        body.className = 'card-body';
        const heading = document.createElement('h5');
        heading.className = 'h6';
        heading.textContent = 'Order ' + (order.publicOrderCode || order.id) + ' · ' + order.status;
        const meta = document.createElement('p');
        meta.className = 'small text-secondary mb-2';
        meta.textContent = [formatTimestamp(order.createdAt).label, order.channel, order.pickupDate || order.pickupTime ? 'Pickup ' + formatPickupSchedule(order) : ''].filter(Boolean).join(' · ');
        const lines = document.createElement('ul');
        lines.className = 'small mb-2';
        (order.items || []).forEach(function (line) {
          const item = document.createElement('li');
          const lineName = line.description || line.name || line.drinkName || 'Item';
          const toppings = Array.isArray(line.toppings) && line.toppings.length
            ? ' — ' + line.toppings.map(function (topping) {
              return topping.name + (Number(topping.quantity) > 1 ? ' × ' + topping.quantity : '');
            }).join(', ')
            : '';
          item.textContent = line.quantity + ' × ' + lineName + toppings;
          lines.append(item);
        });
        const total = document.createElement('p');
        total.className = 'fw-semibold mb-0';
        total.textContent = 'Total: ' + formatMoney(order.totalPrice);
        body.append(heading, meta, lines, total);
        card.append(body);
        customerOrdersList.append(card);
      });
    }

    async function loadCustomerOrderHistory(customer) {
      const requestId = ++customerHistoryRequestId;
      customerHistorySection.hidden = false;
      document.getElementById('selected-customer-summary').textContent = [
        customer.fullName,
        formatPhoneNumber(customer.phone),
        customer.email
      ].filter(Boolean).join(' · ');
      customerOrdersStatus.textContent = 'Loading order history.';
      customerOrdersList.setAttribute('aria-busy', 'true');
      try {
        const payload = await apiRequest('/api/staff/customer-account-orders?email=' + encodeURIComponent(customer.email));
        if (requestId !== customerHistoryRequestId) return;
        renderCustomerOrders(payload.orders || []);
        customerOrdersStatus.textContent = (payload.orders || []).length +
          ((payload.orders || []).length === 1 ? ' order found.' : ' orders found.');
        document.getElementById('customer-order-history-heading').focus();
      } catch (error) {
        if (requestId !== customerHistoryRequestId) return;
        customerOrdersList.replaceChildren();
        customerOrdersStatus.textContent = 'Order history could not be loaded. ' + error.message;
        announce('Order history could not be loaded. ' + error.message);
      } finally {
        if (requestId === customerHistoryRequestId) customerOrdersList.removeAttribute('aria-busy');
      }
    }

    customerSearchForm.addEventListener('submit', function (event) {
      event.preventDefault();
      window.clearTimeout(customerSearchTimer);
      loadCustomerDirectory();
    });
    customerSearchInput.addEventListener('input', function () {
      window.clearTimeout(customerSearchTimer);
      customerSearchTimer = window.setTimeout(loadCustomerDirectory, 250);
    });
    customerDirectoryList.addEventListener('click', function (event) {
      const button = event.target.closest('[data-customer-email]');
      if (!button) return;
      customerDirectoryList.querySelectorAll('[data-customer-email]').forEach(function (result) {
        result.setAttribute('aria-expanded', String(result === button));
      });
      const customer = customerRecordsByEmail.get(button.dataset.customerEmail);
      if (customer) loadCustomerOrderHistory(customer);
    });

    employeeAccessForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      employeeAccessForm.classList.add('was-validated');
      if (!employeeAccessForm.reportValidity()) return;

      const firstNameInput = document.getElementById('employee-first-name');
      const lastNameInput = document.getElementById('employee-last-name');
      const emailInput = document.getElementById('employee-email');
      const button = employeeAccessForm.querySelector('button[type="submit"]');
      const editId = employeeAccountIdInput.value;
      const isEditing = Boolean(editId);
      const requestBody = {
        firstName: firstNameInput.value.trim(),
        lastName: lastNameInput.value.trim(),
        email: emailInput.value.trim(),
        role: employeeRoleInput.value
      };
      if (!isEditing) requestBody.temporaryPassword = employeeTempPasswordInput.value;
      button.disabled = true;
      employeeAccessForm.setAttribute('aria-busy', 'true');
      try {
        const payload = await apiRequest(isEditing ? '/api/staff/accounts/' + encodeURIComponent(editId) : '/api/staff/accounts', {
          method: isEditing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        clearAccountForm();
        const updatedName = payload.account.fullName;
        showStaffAccessMessage(isEditing
          ? 'Account details updated for ' + updatedName + '.'
          : 'Account created for ' + updatedName + '. The staff member must change the temporary password at first sign-in.', false);
        announce(isEditing ? 'Staff account updated for ' + updatedName + '.' : 'Staff account created for ' + updatedName + '.');
        await loadStaffAccounts();
        firstNameInput.focus();
      } catch (error) {
        showStaffAccessMessage(error.message, true);
        announce('Staff account could not be saved. ' + error.message);
        if (error.message.toLowerCase().includes('email')) {
          emailInput.setAttribute('aria-invalid', 'true');
          emailInput.focus();
        }
      } finally {
        button.disabled = false;
        employeeAccessForm.removeAttribute('aria-busy');
      }
    });

    cancelAccountEdit.addEventListener('click', function () {
      clearAccountForm();
      document.getElementById('employee-first-name').focus();
    });

    staffAccountList.addEventListener('click', async function (event) {
      const deleteButton = event.target.closest('[data-staff-delete-id]');
      if (deleteButton) {
        const staffId = deleteButton.dataset.staffDeleteId;
        const account = staffAccountsById.get(staffId);
        if (!account || account.isActive) return;
        const confirmed = window.confirm('Permanently delete the deactivated staff account for ' + account.fullName + ' (' + account.email + ')? This cannot be undone.');
        if (!confirmed) return;
        deleteButton.disabled = true;
        try {
          await apiRequest('/api/staff/accounts/' + encodeURIComponent(staffId), {
            method: 'DELETE'
          });
          showStaffAccessMessage('Deactivated account for ' + account.fullName + ' was permanently deleted.', false);
          announce('Deactivated staff account for ' + account.fullName + ' was permanently deleted.');
          await loadStaffAccounts();
          document.getElementById('employee-list-heading').focus();
        } catch (error) {
          deleteButton.disabled = false;
          showStaffAccessMessage(error.message, true);
          announce('Staff account could not be deleted. ' + error.message);
        }
        return;
      }

      const editButton = event.target.closest('[data-staff-edit-id]');
      if (editButton) {
        const account = staffAccountsById.get(editButton.dataset.staffEditId);
        if (account) beginAccountEdit(account);
        return;
      }
      const button = event.target.closest('[data-staff-account-id]');
      if (!button) return;
      const staffId = button.dataset.staffAccountId;
      const nextActive = button.dataset.nextActive === 'true';
      button.disabled = true;
      try {
        await apiRequest('/api/staff/accounts/' + encodeURIComponent(staffId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: nextActive })
        });
        showStaffAccessMessage('Staff account ' + (nextActive ? 'reactivated' : 'deactivated') + '.', false);
        await loadStaffAccounts();
        const updatedButton = staffAccountList.querySelector('[data-staff-account-id="' + CSS.escape(staffId) + '"]');
        if (updatedButton) updatedButton.focus();
      } catch (error) {
        button.disabled = false;
        showStaffAccessMessage(error.message, true);
        announce('Staff account could not be updated. ' + error.message);
      }
    });

    employeeAccessForm.querySelectorAll('input').forEach(function (input) {
      input.addEventListener('input', function () { this.removeAttribute('aria-invalid'); });
    });

    loadStaffAccounts();

    document.getElementById('pizza-size').addEventListener('change', updatePizzaPreview);
    document.getElementById('pizza-quantity').addEventListener('input', function () {
      if (this.classList.contains('is-invalid')) validateItemQuantity(this, 'pizza', MAX_ORDER_ITEMS);
      updatePizzaPreview();
    });
    document.querySelectorAll('.topping-increment').forEach(function (button) {
      const control = button.parentElement;
      updateToppingButtons(control, 0);
      button.addEventListener('click', function () {
        const current = Number(button.dataset.count) || 0;
        if (current >= MAX_TOPPING_SERVINGS) {
          announce('Maximum of ' + MAX_TOPPING_SERVINGS + ' servings of ' + button.dataset.topping + ' selected.');
          return;
        }
        updateToppingButtons(control, current + 1);
        updatePizzaPreview();
      });
      control.querySelector('.topping-decrement').addEventListener('click', function () {
        const current = Number(button.dataset.count) || 0;
        if (current <= 0) return;
        updateToppingButtons(control, current - 1);
        updatePizzaPreview();
      });
    });
    document.getElementById('pickup-date').addEventListener('input', updatePickupTimeValidity);
    document.getElementById('pickup-date').addEventListener('change', updatePickupTimeValidity);
    document.getElementById('pickup-time').addEventListener('input', updatePickupTimeValidity);
    document.getElementById('pickup-time').addEventListener('change', updatePickupTimeValidity);
    posForm.addEventListener('input', function (event) {
      if (event.target === customerFirstNameInput || event.target === customerLastNameInput) validateCustomerNames();
      if (event.target === customerPhoneInput) {
        const maskedPhone = maskCustomerPhone(customerPhoneInput.value);
        if (customerPhoneInput.value !== maskedPhone) customerPhoneInput.value = maskedPhone;
        validateCustomerPhone();
      }
      if (posForm.classList.contains('was-validated') && orderValidationFields.includes(event.target)) {
        event.target.setAttribute('aria-invalid', String(!event.target.validity.valid));
      }
    });
    posForm.addEventListener('change', function (event) {
      if (event.target === customerFirstNameInput || event.target === customerLastNameInput) validateCustomerNames();
      if (event.target === customerPhoneInput) {
        const maskedPhone = maskCustomerPhone(customerPhoneInput.value);
        if (customerPhoneInput.value !== maskedPhone) customerPhoneInput.value = maskedPhone;
        validateCustomerPhone();
      }
      if (posForm.classList.contains('was-validated') && orderValidationFields.includes(event.target)) {
        event.target.setAttribute('aria-invalid', String(!event.target.validity.valid));
      }
    });
    document.getElementById('drink-size').addEventListener('change', updateDrinkButtonLabel);
    document.querySelectorAll('.drink-type-button').forEach(function (button) {
      button.addEventListener('click', function () {
        document.querySelectorAll('.drink-type-button').forEach(function (option) {
          const selected = option === button;
          option.classList.toggle('active', selected);
          option.setAttribute('aria-pressed', String(selected));
        });
        updateDrinkButtonLabel();
      });
    });
    document.getElementById('drink-quantity').addEventListener('input', function () {
      if (this.classList.contains('is-invalid')) validateItemQuantity(this, 'drinks', MAX_ORDER_ITEMS);
      updateDrinkButtonLabel();
    });
    document.getElementById('add-pizza').addEventListener('click', addPizzaToCart);
    document.getElementById('clear-pizza-selection').addEventListener('click', function () {
      clearPizzaSelection();
      announce('Pizza selection cleared. Size is medium, quantity is one, and no toppings are selected.');
    });
    document.getElementById('add-drink').addEventListener('click', addDrinkToCart);

    document.getElementById('cart-items').addEventListener('click', function (event) {
      const removeButton = event.target.closest('[data-cart-remove]');
      if (!removeButton) return;
      const index = cartItems.findIndex(function (item) { return String(item.id) === removeButton.dataset.cartRemove; });
      if (index !== -1) {
        const removed = cartItems.splice(index, 1)[0];
        renderCart();
        announce(removed.name + ' removed from the order cart.');
      }
    });

    document.getElementById('clear-cart').addEventListener('click', function () {
      cartItems.length = 0;
      renderCart();
      announce('Order cart cleared.');
    });

    posForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      validateCustomerNames();
      validateCustomerPhone();
      updatePickupTimeValidity();
      posForm.classList.add('was-validated');
      orderValidationFields.forEach(function (control) {
        control.setAttribute('aria-invalid', String(!control.validity.valid));
      });
      const cartError = document.getElementById('cart-error');
      const invalid = orderValidationFields.find(function (control) { return !control.validity.valid; });
      if (invalid) {
        invalid.focus();
        announce('Please correct the required or invalid fields before placing the order.');
        return;
      }
      if (cartItems.length === 0) {
        cartError.textContent = 'Add at least one item before placing the order.';
        cartError.hidden = false;
        document.getElementById('add-pizza').focus();
        announce('Add at least one pizza or drink before placing the order.');
        return;
      }
      cartError.hidden = true;
      const submitError = document.getElementById('order-submit-error');
      submitError.hidden = true;
      submitError.textContent = '';
      const data = new FormData(posForm);
      const orderInput = {
        customerFirstName: String(data.get('customerFirstName')).trim(),
        customerLastName: String(data.get('customerLastName')).trim(),
        customerPhone: normalizeCustomerPhone(data.get('customerPhone')),
        channel: String(data.get('channel')),
        pickupDate: String(data.get('pickupDate') || ''),
        pickupTime: String(data.get('pickupTime') || ''),
        items: cartItems.map(function (item) {
          return {
            type: item.type,
            quantity: item.quantity,
            pizzaSize: item.pizzaSize || null,
            toppings: item.toppings || [],
            drinkName: item.drinkName || null,
            drinkSize: item.drinkSize || null
          };
        }),
        notes: String(data.get('notes') || '')
      };
      const submitButton = document.getElementById('submit-order-button');
      submitButton.disabled = true;
      posForm.setAttribute('aria-busy', 'true');
      announce('Saving order.');
      try {
        const saved = await createOrder(orderInput);
        cartItems.length = 0;
        posForm.reset();
        clearPizzaSelection();
        clearDrinkSelection();
        posForm.classList.remove('was-validated');
        posForm.querySelectorAll('[aria-invalid]').forEach(function (control) { control.removeAttribute('aria-invalid'); });
        posForm.querySelectorAll('.is-invalid').forEach(function (control) { control.classList.remove('is-invalid'); });
        customerFirstNameInput.setCustomValidity('');
        customerLastNameInput.setCustomValidity('');
        customerPhoneInput.setCustomValidity('');
        document.getElementById('pickup-time-error').hidden = true;
        updatePickupTimeValidity();
        cartError.hidden = true;
        submitError.hidden = true;
        renderCart();
        updatePizzaPreview();
        updateDrinkButtonLabel();
        activateTab(document.getElementById('orders-tab'), true);
        announce('Order ' + saved.id + ' for ' + saved.customerName + ' was placed and added to active orders.');
      } catch (error) {
        submitError.textContent = 'Order could not be placed. ' + error.message;
        submitError.hidden = false;
        announce('Order could not be placed. ' + error.message);
      } finally {
        submitButton.disabled = false;
        posForm.removeAttribute('aria-busy');
      }
    });

    document.getElementById('active-orders-list').addEventListener('click', async function (event) {
      const detailsButton = event.target.closest('[data-details-button]');
      if (detailsButton) {
        const expanded = detailsButton.getAttribute('aria-expanded') === 'true';
        const panel = document.getElementById(detailsButton.getAttribute('aria-controls'));
        detailsButton.setAttribute('aria-expanded', String(!expanded));
        detailsButton.setAttribute('aria-label', (expanded ? 'Show' : 'Hide') + ' details for order ' + detailsButton.dataset.detailsButton);
        detailsButton.textContent = expanded ? 'Show order details' : 'Hide order details';
        panel.hidden = expanded;
        return;
      }
      const statusButton = event.target.closest('[data-status-button]');
      if (!statusButton) return;
      const orderId = statusButton.dataset.statusButton;
      const select = activeOrdersList.querySelector('[data-status-select="' + CSS.escape(orderId) + '"]');
      statusButton.disabled = true;
      try {
        const updated = await updateOrderStatus(orderId, select.value);
        await renderOrders();
        if (updated.status === 'Completed') {
          await renderHistory();
          announce('Order ' + orderId + ' was completed and moved to order history.');
        } else {
          announce('Order ' + orderId + ' status updated to ' + updated.status + '.');
        }
      } catch (error) {
        announce('Status could not be updated. ' + error.message);
      }
    });

    document.getElementById('refresh-orders').addEventListener('click', async function () {
      await renderOrders();
      announce('Active orders refreshed.');
    });
    document.getElementById('refresh-history').addEventListener('click', async function () {
      await renderHistory();
      announce('Order history refreshed.');
    });
    document.getElementById('history-next-page').addEventListener('click', function () {
      if (historyHasMore) renderHistory({ page: historyPage + 1 });
    });
    document.getElementById('history-previous-page').addEventListener('click', function () {
      if (historyPage > 0) renderHistory({ page: historyPage - 1 });
    });
    document.getElementById('history-search').addEventListener('input', function () {
      window.clearTimeout(historySearchTimer);
      historySearchTimer = window.setTimeout(function () { renderHistory(); }, 250);
    });
    refreshSalesSummaryButton.addEventListener('click', function () {
      loadManagerSalesSummary();
    });
    document.getElementById('sales-comparison-form').addEventListener('submit', function (event) {
      event.preventDefault();
      if (!salesCompareDate.reportValidity()) return;
      loadManagerSalesSummary();
    });

    renderCart();
    updatePizzaPreview();
    updatePickupTimeValidity();
    updateDrinkButtonLabel();
    renderOrders();
    renderHistory();
    window.setInterval(function () { checkForOverdueOrders(true); }, 30000);
    window.setInterval(function () {
      const managerTab = document.getElementById('manager-tab');
      if (!document.hidden && !managerTab.hidden && managerTab.getAttribute('aria-selected') === 'true') {
        loadManagerSalesSummary({ announce: false });
      }
    }, 15000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        checkForOverdueOrders(true);
        const managerTab = document.getElementById('manager-tab');
        if (!managerTab.hidden && managerTab.getAttribute('aria-selected') === 'true') {
          loadManagerSalesSummary({ announce: false });
        }
      }
    });
