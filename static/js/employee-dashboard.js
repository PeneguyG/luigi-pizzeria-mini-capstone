'use strict';

    /* Same-origin Flask API. The server recalculates item prices and tax before saving. */
    const pizzaPricing = {
      Small: { inches: 12, base: 5, topping: 1, portion: '¼ cup' },
      Medium: { inches: 14, base: 7, topping: 2, portion: '½ cup' },
      Large: { inches: 18, base: 9, topping: 3, portion: '1 cup' }
    };
    const drinkPricing = { Small: 1, Medium: 2, Large: 3 };
    const TAX_RATE = 0.0975;
    const statusStyles = {
      Confirmed: { background: '#f1e6d3', color: '#514126' },
      'In-Progress': { background: '#dce9f2', color: '#24445a' },
      Ready: { background: '#dcebdd', color: '#24462a' },
      Overdue: { background: '#f1dada', color: '#652c2c' }
    };
    const allowedStatuses = ['Confirmed', 'In-Progress', 'Ready', 'Overdue', 'Completed'];

    let nextCartItemId = 1;

    const dashboardStatus = document.getElementById('dashboard-status');
    const activeOrdersList = document.getElementById('active-orders-list');
    const historyList = document.getElementById('history-list');
    const cartItems = [];
    const MAX_ORDER_ITEMS = 20;
    const posForm = document.getElementById('pos-form');
    let activeOrders = [];
    let overdueCheckRunning = false;
    const overdueUpdatesInProgress = new Set();

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
      return Array.from(document.querySelectorAll('.pizza-topping')).map(function (input) {
        return { name: input.dataset.topping, quantity: Number(input.value) || 0 };
      }).filter(function (topping) { return topping.quantity > 0; });
    }

    function getPizzaConfiguration() {
      const size = document.getElementById('pizza-size').value;
      const pricing = pizzaPricing[size];
      const quantity = Math.max(1, Math.min(20, Number(document.getElementById('pizza-quantity').value) || 1));
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
      document.getElementById('pizza-quantity').value = '1';
      document.querySelectorAll('.pizza-topping').forEach(function (input) { input.value = '0'; });
      updatePizzaPreview();
    }

    function getMinimumPickupTime() {
      const today = new Date();
      const nextMinute = new Date();
      nextMinute.setSeconds(0, 0);
      nextMinute.setMinutes(nextMinute.getMinutes() + 1);
      if (nextMinute.getDate() !== today.getDate() || nextMinute.getMonth() !== today.getMonth() || nextMinute.getFullYear() !== today.getFullYear()) {
        return null;
      }
      return String(nextMinute.getHours()).padStart(2, '0') + ':' + String(nextMinute.getMinutes()).padStart(2, '0');
    }

    function updatePickupTimeValidity() {
      const input = document.getElementById('pickup-time');
      const error = document.getElementById('pickup-time-error');
      const minimum = getMinimumPickupTime();
      if (minimum) input.min = minimum;
      else input.removeAttribute('min');
      const invalidPastTime = Boolean(input.value) && (!minimum || input.value < minimum);
      input.setCustomValidity(invalidPastTime ? 'Pickup time must be later than the current time today.' : '');
      error.textContent = minimum
        ? 'Pickup time must be later than the current time today.'
        : 'There are no later pickup times available today.';
      error.hidden = !invalidPastTime;
      return !invalidPastTime;
    }

    const customerPhoneInput = document.getElementById('customer-phone');
    const customerNameInput = document.getElementById('customer-name');
    const customerPhonePattern = /^(?:\+?1[ .-]?)?(?:\([2-9][0-9]{2}\)|[2-9][0-9]{2})[ .-]?[2-9][0-9]{2}[ .-]?[0-9]{4}$/;
    const orderValidationFields = [
      customerNameInput,
      customerPhoneInput,
      document.getElementById('order-channel'),
      document.getElementById('pickup-time')
    ];

    function validateCustomerName() {
      const name = customerNameInput.value.trim();
      customerNameInput.setCustomValidity(name ? '' : 'Enter the customer\'s name.');
      return customerNameInput.validity.valid;
    }

    function validateCustomerPhone() {
      const phone = customerPhoneInput.value.trim();
      const phoneError = document.getElementById('customer-phone-error');
      const malformed = phone.length > 0 && !customerPhonePattern.test(phone);
      customerPhoneInput.setCustomValidity(malformed
        ? 'Enter a valid 10-digit US phone number. Letters are not allowed.'
        : '');
      phoneError.textContent = phone
        ? 'Enter a valid 10-digit US phone number. Use digits with optional spaces, parentheses, periods, or hyphens; letters are not allowed.'
        : 'Enter the customer\'s phone number.';
      return customerPhoneInput.validity.valid;
    }

    function clearDrinkSelection() {
      document.getElementById('drink-option').value = 'Iced tea';
      document.getElementById('drink-size').value = 'Medium';
      document.getElementById('drink-quantity').value = '1';
      updateDrinkButtonLabel();
    }

    function updateDrinkButtonLabel() {
      const size = document.getElementById('drink-size').value;
      const drink = document.getElementById('drink-option').value;
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
      const invalidInput = Array.from(document.querySelectorAll('.pizza-topping'))
        .find(function (input) { return !input.checkValidity(); });
      if (invalidInput) {
        invalidInput.reportValidity();
        invalidInput.focus();
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
      const drink = document.getElementById('drink-option').value;
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
      const response = await fetch(path, Object.assign({ cache: 'no-store' }, options || {}));
      let payload = null;
      try { payload = await response.json(); } catch (_error) { /* Non-JSON response */ }
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error : 'Request failed (' + response.status + ').');
      }
      return payload;
    }

    async function listOrders() {
      return apiRequest('/api/employee/orders');
    }

    async function listOrderHistory() {
      return apiRequest('/api/employee/order-history');
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
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return { label: 'Timestamp unavailable', iso: '' };
      return {
        label: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date),
        iso: date.toISOString()
      };
    }

    function getOrderTotal(order) {
      if (Number.isFinite(Number(order.totalPrice))) return Number(order.totalPrice);
      return (order.items || []).reduce(function (sum, item) { return sum + item.unitPrice * item.quantity; }, 0);
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
      if (status === 'Completed') return '<span class="badge rounded-pill text-dark" style="background-color:#e4efe3;">Completed</span>';
      const style = statusStyles[status] || statusStyles.Confirmed;
      return '<span data-order-status-badge="' + escapeHTML(orderId) + '" class="badge rounded-pill" style="background-color:' + style.background + ';color:' + style.color + ';">' + escapeHTML(status) + '</span>';
    }

    function orderCard(order) {
      const id = escapeHTML(order.id);
      const safeId = String(order.id).replace(/[^a-zA-Z0-9_-]/g, '-');
      const detailsId = 'order-details-' + safeId;
      const statusOptions = allowedStatuses.map(function (status) {
        const label = status === 'Completed' ? 'Completed / picked up' : status;
        return '<option value="' + escapeHTML(status) + '"' + (order.status === status ? ' selected' : '') + '>' + escapeHTML(label) + '</option>';
      }).join('');
      const details = [
        '<div class="col-12 col-md-6"><span class="fw-semibold">Phone:</span> ' + escapeHTML(order.customerPhone || 'Not provided') + '</div>',
        '<div class="col-12 col-md-6"><span class="fw-semibold">Channel:</span> ' + escapeHTML(order.channel || 'Not specified') + '</div>',
        '<div class="col-12 col-md-6"><span class="fw-semibold">Source:</span> ' + escapeHTML(order.source || 'Order system') + '</div>',
        '<div class="col-12"><span class="fw-semibold">Notes:</span> ' + escapeHTML(order.notes || 'None') + '</div>'
      ].join('');
      const taxDetails = Number.isFinite(Number(order.taxPrice))
        ? ' <span class="small text-secondary">(includes ' + formatMoney(order.taxPrice) + ' tax)</span>' : '';
      return '<article class="card" data-order-card="' + id + '" style="border-color:#ded5d2;"><div class="card-body p-3 p-md-4">' +
        '<div class="d-flex flex-column flex-lg-row justify-content-between gap-3"><div class="flex-grow-1">' +
        '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><h4 class="h6 mb-0">Order ' + id + '</h4>' +
        statusBadge(order.status, order.id) + '<span class="badge rounded-pill text-dark" style="background-color:#f4f1e7;">' + escapeHTML(order.source || 'Order system') + '</span></div>' +
        '<p class="mb-1"><strong>' + escapeHTML(order.customerName) + '</strong></p><p class="small mb-2"><span class="fw-semibold">Items:</span></p>' +
        '<ul class="small mb-2">' + formatOrderItems(order.items) + '</ul>' +
        '<p class="small mb-2"><span class="fw-semibold">Order total:</span> ' + formatMoney(getOrderTotal(order)) + taxDetails +
        ' <span class="text-secondary">· Pickup ' + escapeHTML(order.pickupTime || 'Not specified') + '</span></p>' +
        '<button class="btn btn-sm btn-link link-danger px-0 py-1" type="button" data-details-button="' + id +
        '" aria-label="Show details for order ' + id + '" aria-expanded="false" aria-controls="' + detailsId + '">Show order details</button>' +
        '<div id="' + detailsId + '" class="row g-2 small mt-1" hidden>' + details + '</div></div>' +
        '<div class="d-flex flex-column flex-sm-row flex-lg-column align-items-stretch gap-2" style="min-width:14rem;">' +
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
      const timestamp = formatTimestamp(order.completedAt);
      const timeTag = timestamp.iso ? '<time datetime="' + escapeHTML(timestamp.iso) + '">' + escapeHTML(timestamp.label) + '</time>' : escapeHTML(timestamp.label);
      const taxDetails = Number.isFinite(Number(order.taxPrice))
        ? '<span class="small text-secondary"> (includes ' + formatMoney(order.taxPrice) + ' tax)</span>' : '';
      return '<article class="card" style="border-color:#ded5d2;"><div class="card-body p-3 p-md-4">' +
        '<div class="d-flex flex-column flex-md-row justify-content-between gap-3"><div class="flex-grow-1">' +
        '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><h4 class="h6 mb-0">Order ' + id + '</h4>' +
        '<span class="badge rounded-pill text-dark" style="background-color:#e4efe3;">Completed</span></div>' +
        '<p class="mb-2"><strong>' + escapeHTML(order.customerName) + '</strong></p>' +
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

    function pickupTimeHasPassed(pickupTime, now) {
      const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(String(pickupTime || ''));
      if (!match) return false;
      const pickupSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60;
      const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
      return currentSeconds > pickupSeconds;
    }

    function updateOrderStatusInUi(order, preserveFocusedSelection) {
      const card = activeOrdersList.querySelector('[data-order-card="' + CSS.escape(String(order.id)) + '"]');
      if (!card) return;
      const badge = card.querySelector('[data-order-status-badge]');
      const style = statusStyles[order.status] || statusStyles.Confirmed;
      if (badge) {
        badge.textContent = order.status;
        badge.style.backgroundColor = style.background;
        badge.style.color = style.color;
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
      const changedOrders = [];
      const failedOrders = [];

      try {
        if (refreshFromApi) synchronizeActiveOrders(await listOrders());
        const now = new Date();
        const candidates = activeOrders.filter(function (order) {
          return order.status !== 'Completed' && order.status !== 'Overdue' && pickupTimeHasPassed(order.pickupTime, now);
        });

        for (const order of candidates) {
          const id = String(order.id);
          if (overdueUpdatesInProgress.has(id)) continue;
          overdueUpdatesInProgress.add(id);
          try {
            const result = await updateOrderStatus(order.id, 'Overdue');
            order.status = result && result.status ? result.status : 'Overdue';
            updateOrderStatusInUi(order, true);
            changedOrders.push(order);
          } catch (error) {
            failedOrders.push({ id: id, message: error.message });
          } finally {
            overdueUpdatesInProgress.delete(id);
          }
        }

        if (failedOrders.length) {
          const failedIds = failedOrders.map(function (item) { return item.id; }).join(', ');
          overdueError.textContent = 'Could not mark order' + (failedOrders.length === 1 ? ' ' : 's ') + failedIds +
            ' overdue. ' + failedOrders[0].message + ' Refresh orders and try again.';
          overdueError.hidden = false;
        } else {
          overdueError.hidden = true;
          overdueError.textContent = '';
        }

        if (changedOrders.length) {
          const ids = changedOrders.map(function (order) { return String(order.id); }).join(', ');
          announce('Order' + (changedOrders.length === 1 ? ' ' : 's ') + ids +
            ' automatically marked overdue because the requested pickup time passed.');
        }
      } catch (error) {
        overdueError.textContent = 'Could not check active orders for overdue pickup times. ' + error.message;
        overdueError.hidden = false;
      } finally {
        overdueCheckRunning = false;
      }
    }

    async function renderHistory() {
      try {
        const orders = await listOrderHistory();
        document.getElementById('history-list').innerHTML = orders.map(historyCard).join('');
        const loadError = document.getElementById('history-load-error');
        loadError.hidden = true;
        loadError.textContent = '';
        document.getElementById('empty-history').hidden = orders.length !== 0;
        document.getElementById('history-count').textContent = String(orders.length);
      } catch (error) {
        const loadError = document.getElementById('history-load-error');
        loadError.textContent = 'Could not load order history. ' + error.message;
        loadError.hidden = false;
        document.getElementById('empty-history').hidden = true;
        announce('Could not load order history. ' + error.message);
      }
    }

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const rolePreview = document.getElementById('role-preview');
    const rolePreviewSection = document.getElementById('role-preview-section');
    const roleLevels = { employee: 1, manager: 2, admin: 3 };
    const roleNames = { employee: 'Employee', manager: 'Manager', admin: 'Admin' };
    let staffSession = null;
    try {
      const savedSession = JSON.parse(sessionStorage.getItem('luigis_staff_session') || 'null');
      if (savedSession && typeof savedSession.id === 'string' && typeof savedSession.name === 'string' && roleLevels[savedSession.role]) {
        staffSession = savedSession;
      }
    } catch (_error) {
      staffSession = null;
    }
    let activeRole = staffSession ? staffSession.role : rolePreview.value;

    function roleCanSee(element) {
      const requiredRole = element.dataset.minimumRole;
      return !requiredRole || roleLevels[activeRole] >= roleLevels[requiredRole];
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
        item.style.backgroundColor = selected ? '#f1dada' : 'transparent';
        item.style.color = selected ? '#592f2f' : '#302c2b';
        const allowed = roleCanSee(item);
        item.hidden = !allowed;
        panel.hidden = !selected || !allowed;
        panel.setAttribute('aria-hidden', String(panel.hidden));
      });
      if (moveFocus !== false) tab.focus();
      if (tab.id === 'orders-tab') renderOrders();
      if (tab.id === 'history-tab') renderHistory();
    }

    function applyRole(role, announceChange) {
      activeRole = roleLevels[role] ? role : 'employee';
      rolePreview.value = activeRole;
      rolePreview.disabled = Boolean(staffSession);
      rolePreviewSection.hidden = Boolean(staffSession);

      const sessionLabel = document.getElementById('staff-session-label');
      const signOutButton = document.getElementById('dashboard-staff-signout');
      sessionLabel.hidden = !staffSession;
      signOutButton.hidden = !staffSession;
      if (staffSession) {
        sessionLabel.textContent = 'Demo sign-in: ' + staffSession.name + ' (' + roleNames[activeRole] + ')';
      }

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

      if (announceChange) {
        const message = activeRole === 'admin'
          ? 'Admin role selected. All dashboard views are available in this demo.'
          : activeRole === 'manager'
            ? 'Manager role selected. Manager tools and order views are available.'
            : 'Employee role selected. Point of Sales, active orders, and order history are available.';
        announce(message);
      }
    }

    rolePreview.addEventListener('change', function () {
      staffSession = null;
      applyRole(rolePreview.value, true);
    });

    document.getElementById('dashboard-staff-signout').addEventListener('click', function () {
      sessionStorage.removeItem('luigis_staff_session');
      window.location.assign('/staff-signin.html?focus=signin');
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
    applyRole(activeRole, false);
    if (new URLSearchParams(window.location.search).get('focus') === 'dashboard') {
      window.requestAnimationFrame(function () {
        document.getElementById('dashboard-heading').focus();
      });
    }

    const employeeAccessForm = document.getElementById('employee-access-form');
    const employeePreviewList = document.getElementById('employee-preview-list');
    const employeePreviewRecords = [];
    employeeAccessForm.addEventListener('submit', function (event) {
      event.preventDefault();
      const nameInput = document.getElementById('employee-name');
      const emailInput = document.getElementById('employee-email');
      const roleInput = document.getElementById('employee-role');
      const emailError = document.getElementById('employee-email-error');
      const inputs = [nameInput, emailInput];
      nameInput.setCustomValidity(nameInput.value.trim() ? '' : 'Enter the employee\'s name.');
      emailInput.setCustomValidity('');
      emailError.textContent = 'Enter a valid email address.';
      employeeAccessForm.classList.add('was-validated');
      inputs.forEach(function (input) {
        input.setAttribute('aria-invalid', String(!input.validity.valid));
      });

      const invalidInput = inputs.find(function (input) { return !input.validity.valid; });
      if (invalidInput) {
        invalidInput.focus();
        announce('Please enter a valid employee name and email address.');
        return;
      }

      const email = emailInput.value.trim().toLowerCase();
      if (employeePreviewRecords.some(function (record) { return record.email === email; })) {
        emailInput.setCustomValidity('This employee preview already uses that email address.');
        emailError.textContent = 'This email address is already in the employee preview.';
        emailInput.setAttribute('aria-invalid', 'true');
        emailInput.focus();
        announce('That email address is already in the employee preview.');
        return;
      }
      emailInput.setCustomValidity('');
      emailInput.removeAttribute('aria-invalid');

      const record = {
        name: nameInput.value.trim(),
        email: email,
        role: roleInput.value
      };
      employeePreviewRecords.push(record);
      document.getElementById('employee-preview-empty')?.remove();

      const listItem = document.createElement('li');
      listItem.className = 'list-group-item d-flex flex-column flex-sm-row justify-content-between gap-1';
      const employeeName = document.createElement('span');
      employeeName.className = 'fw-semibold';
      employeeName.textContent = record.name;
      const employeeDetails = document.createElement('span');
      employeeDetails.className = 'text-secondary';
      employeeDetails.textContent = record.email + ' · ' + record.role;
      listItem.append(employeeName, employeeDetails);
      employeePreviewList.append(listItem);

      employeeAccessForm.reset();
      employeeAccessForm.classList.remove('was-validated');
      inputs.forEach(function (input) { input.removeAttribute('aria-invalid'); });
      announce(record.name + ' added to the browser-only employee preview as ' + record.role + '.');
      nameInput.focus();
    });

    [document.getElementById('employee-name'), document.getElementById('employee-email')].forEach(function (input) {
      input.addEventListener('input', function () {
        if (this.id === 'employee-name') {
          this.setCustomValidity(this.value.trim() ? '' : 'Enter the employee\'s name.');
        } else {
          this.setCustomValidity('');
          document.getElementById('employee-email-error').textContent = 'Enter a valid email address.';
        }
        if (employeeAccessForm.classList.contains('was-validated')) {
          this.setAttribute('aria-invalid', String(!this.validity.valid));
        }
      });
    });

    document.getElementById('pizza-size').addEventListener('change', updatePizzaPreview);
    document.getElementById('pizza-quantity').addEventListener('input', function () {
      if (this.classList.contains('is-invalid')) validateItemQuantity(this, 'pizza', MAX_ORDER_ITEMS);
      updatePizzaPreview();
    });
    document.querySelectorAll('.pizza-topping').forEach(function (input) {
      input.addEventListener('input', updatePizzaPreview);
      input.addEventListener('change', updatePizzaPreview);
    });
    document.getElementById('pickup-time').addEventListener('input', updatePickupTimeValidity);
    document.getElementById('pickup-time').addEventListener('change', updatePickupTimeValidity);
    posForm.addEventListener('input', function (event) {
      if (event.target === customerNameInput) validateCustomerName();
      if (event.target === customerPhoneInput) validateCustomerPhone();
      if (posForm.classList.contains('was-validated') && orderValidationFields.includes(event.target)) {
        event.target.setAttribute('aria-invalid', String(!event.target.validity.valid));
      }
    });
    posForm.addEventListener('change', function (event) {
      if (event.target === customerNameInput) validateCustomerName();
      if (event.target === customerPhoneInput) validateCustomerPhone();
      if (posForm.classList.contains('was-validated') && orderValidationFields.includes(event.target)) {
        event.target.setAttribute('aria-invalid', String(!event.target.validity.valid));
      }
    });
    document.getElementById('drink-size').addEventListener('change', updateDrinkButtonLabel);
    document.getElementById('drink-option').addEventListener('change', updateDrinkButtonLabel);
    document.getElementById('drink-quantity').addEventListener('input', function () {
      if (this.classList.contains('is-invalid')) validateItemQuantity(this, 'drinks', MAX_ORDER_ITEMS);
      updateDrinkButtonLabel();
    });
    document.getElementById('add-pizza').addEventListener('click', addPizzaToCart);
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
      validateCustomerName();
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
        customerName: String(data.get('customerName')).trim(),
        customerPhone: String(data.get('customerPhone')).trim(),
        channel: String(data.get('channel')),
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
        posForm.classList.remove('was-validated');
        posForm.querySelectorAll('[aria-invalid]').forEach(function (control) { control.removeAttribute('aria-invalid'); });
        posForm.querySelectorAll('.is-invalid').forEach(function (control) { control.classList.remove('is-invalid'); });
        customerNameInput.setCustomValidity('');
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

    renderCart();
    updatePizzaPreview();
    updatePickupTimeValidity();
    updateDrinkButtonLabel();
    renderOrders();
    renderHistory();
    window.setInterval(function () { checkForOverdueOrders(true); }, 30000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForOverdueOrders(true);
    });
