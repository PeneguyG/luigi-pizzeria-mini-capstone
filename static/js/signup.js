'use strict';

// Prototype-only customer accounts. A production account system must validate
// credentials and store password hashes on the server, never in browser storage.
const CUSTOMERS_KEY = 'luigis_customers';
const SESSION_KEY = 'luigis_customer_session';
const DEFAULT_ORDER_URL = '/customer?focus=order';
const allowedReturnUrls = new Set([
  '/customer?focus=order',
  '/customer?focus=tracker'
]);

const signupForm = document.getElementById('signupForm');
const signinForm = document.getElementById('signinForm');
const signupPanel = document.getElementById('signupPanel');
const signinPanel = document.getElementById('signinPanel');
const authMessage = document.getElementById('authMessage');
const accountPanel = document.getElementById('accountPanel');
const authPanel = document.getElementById('authPanel');
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const query = new URLSearchParams(window.location.search);

function returnUrl() {
  const requested = query.get('next');
  return allowedReturnUrls.has(requested) ? requested : DEFAULT_ORDER_URL;
}

function loadCustomers() {
  try {
    const records = JSON.parse(localStorage.getItem(CUSTOMERS_KEY) || '[]');
    return Array.isArray(records) ? records.filter(function (record) {
      return record && typeof record.email === 'string' && typeof record.passwordHash === 'string';
    }) : [];
  } catch (_error) {
    return [];
  }
}

function saveCustomers(customers) {
  localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(customers));
}

async function hashPassword(password) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('This browser cannot run the account demo securely. Open the site over HTTPS or localhost.');
  }
  const bytes = new TextEncoder().encode(password);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(function (byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function showMessage(text, type) {
  authMessage.textContent = text;
  authMessage.className = 'message ' + type;
}

function clearMessage() {
  authMessage.textContent = '';
  authMessage.className = 'message';
}

function switchTab(name, moveFocus) {
  const isSignup = name === 'signup';
  tabs.forEach(function (tab) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  signupPanel.hidden = !isSignup;
  signupPanel.classList.toggle('hidden', !isSignup);
  signinPanel.hidden = isSignup;
  signinPanel.classList.toggle('hidden', isSignup);
  clearMessage();
  if (moveFocus) {
    const form = isSignup ? signupForm : signinForm;
    const firstField = form.querySelector('input');
    if (firstField) firstField.focus();
  }
}

function signedInCustomer() {
  try {
    const email = localStorage.getItem(SESSION_KEY);
    return loadCustomers().find(function (customer) { return customer.email === email; }) || null;
  } catch (_error) {
    return null;
  }
}

function renderSession() {
  const customer = signedInCustomer();
  const signedIn = Boolean(customer);
  authPanel.hidden = signedIn;
  authPanel.classList.toggle('hidden', signedIn);
  accountPanel.hidden = !signedIn;
  accountPanel.classList.toggle('hidden', !signedIn);
  document.getElementById('headerSignIn').hidden = signedIn;
  document.getElementById('headerSignIn').classList.toggle('hidden', signedIn);
  document.getElementById('signOut').hidden = !signedIn;
  document.getElementById('signOut').classList.toggle('hidden', !signedIn);
  const welcome = document.getElementById('welcome');
  welcome.hidden = !signedIn;
  welcome.classList.toggle('hidden', !signedIn);

  if (signedIn) {
    const firstName = customer.name.trim().split(/\s+/)[0] || 'there';
    welcome.textContent = 'Signed in as ' + firstName;
    document.getElementById('accountGreeting').textContent = 'Welcome back, ' + firstName + '!';
  }
}

function redirectToOrder() {
  window.location.assign(returnUrl());
}

async function handleSignup(event) {
  event.preventDefault();
  clearMessage();
  const nameInput = document.getElementById('suName');
  const emailInput = document.getElementById('suEmail');
  const phoneInput = document.getElementById('suPhone');
  const passwordInput = document.getElementById('suPassword');
  const confirmInput = document.getElementById('suConfirm');
  const name = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const phone = phoneInput.value.trim();
  const password = passwordInput.value;
  const confirm = confirmInput.value;

  nameInput.setCustomValidity(name ? '' : 'Enter your full name.');
  phoneInput.setCustomValidity(phone.replace(/\D/g, '').length >= 10 ? '' : 'Enter a phone number with at least 10 digits.');
  passwordInput.setCustomValidity(password.length >= 8 ? '' : 'Use at least 8 characters.');
  confirmInput.setCustomValidity(password === confirm ? '' : 'The passwords do not match.');
  const invalid = [nameInput, emailInput, phoneInput, passwordInput, confirmInput].find(function (input) {
    return !input.validity.valid;
  });
  if (invalid) {
    invalid.reportValidity();
    invalid.focus();
    return;
  }

  const customers = loadCustomers();
  if (customers.some(function (customer) { return customer.email.toLowerCase() === email; })) {
    switchTab('signin', true);
    document.getElementById('siEmail').value = email;
    showMessage('An account with this email already exists. Choose Sign in instead.', 'error');
    return;
  }

  try {
    customers.push({
      name: name,
      email: email,
      phone: phone,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString()
    });
    saveCustomers(customers);
    localStorage.setItem(SESSION_KEY, email);
    event.target.reset();
    redirectToOrder();
  } catch (error) {
    showMessage(error.message || 'This browser could not save the demo account.', 'error');
  }
}

async function handleSignin(event) {
  event.preventDefault();
  clearMessage();
  const email = document.getElementById('siEmail').value.trim().toLowerCase();
  const password = document.getElementById('siPassword').value;
  const customer = loadCustomers().find(function (record) { return record.email.toLowerCase() === email; });

  try {
    if (!customer || customer.passwordHash !== await hashPassword(password)) {
      showMessage('Email or password is incorrect.', 'error');
      document.getElementById('siEmail').focus();
      return;
    }
    localStorage.setItem(SESSION_KEY, customer.email);
    event.target.reset();
    redirectToOrder();
  } catch (error) {
    showMessage(error.message || 'This browser could not complete sign in.', 'error');
  }
}

function handleSignOut() {
  localStorage.removeItem(SESSION_KEY);
  renderSession();
  switchTab('signin', true);
}

tabs.forEach(function (tab, index) {
  tab.addEventListener('click', function () { switchTab(tab.dataset.tab, true); });
  tab.addEventListener('keydown', function (event) {
    let nextIndex = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      tabs[nextIndex].focus();
      switchTab(tabs[nextIndex].dataset.tab, false);
    }
  });
});

document.getElementById('signupForm').addEventListener('submit', handleSignup);
document.getElementById('signinForm').addEventListener('submit', handleSignin);
document.getElementById('signOut').addEventListener('click', handleSignOut);
document.getElementById('headerSignIn').addEventListener('click', function () { switchTab('signin', true); });
document.getElementById('suPhone').addEventListener('input', function () { this.setCustomValidity(''); });
document.getElementById('suPassword').addEventListener('input', function () {
  this.setCustomValidity('');
  document.getElementById('suConfirm').setCustomValidity('');
});
document.getElementById('suConfirm').addEventListener('input', function () { this.setCustomValidity(''); });

const initialMode = query.get('mode') === 'signin' ? 'signin' : 'signup';
switchTab(initialMode, false);
renderSession();
if (!signedInCustomer() && (query.has('mode') || query.has('next'))) {
  const firstField = (initialMode === 'signin' ? signinForm : signupForm).querySelector('input');
  if (firstField) firstField.focus();
}
