'use strict';

const DEFAULT_ORDER_URL = '/customer?focus=order';
const allowedReturnUrls = new Set(['/customer?focus=order', '/order-tracker.html']);
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

async function accountRequest(path, body) {
  const options = {method: 'GET', cache: 'no-store', credentials: 'same-origin'};
  if (body !== undefined) {
    options.method = 'POST';
    options.headers = {'Content-Type': 'application/json', 'X-Luigi-Request': '1'};
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload;
  try { payload = await response.json(); }
  catch (_error) { throw new Error('The account service returned an unexpected response.'); }
  if (!response.ok) throw new Error(payload.error || 'The account request could not be completed.');
  return payload;
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
    const field = (isSignup ? signupForm : signinForm).querySelector('input');
    if (field) field.focus();
  }
}

function renderSession(customer) {
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
    const firstName = (customer.firstName || customer.name || 'there').trim().split(/\s+/)[0];
    welcome.textContent = 'Signed in as ' + firstName;
    document.getElementById('accountGreeting').textContent = 'Welcome back, ' + firstName + '!';
  }
}

function redirectToOrder() { window.location.assign(returnUrl()); }

function setSubmitting(form, isSubmitting, label) {
  const button = form.querySelector('[type="submit"]');
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
  button.disabled = isSubmitting;
  button.textContent = isSubmitting ? label : button.dataset.defaultLabel;
  form.setAttribute('aria-busy', String(isSubmitting));
}

async function handleSignup(event) {
  event.preventDefault();
  clearMessage();
  const firstNameInput = document.getElementById('suFirstName');
  const lastNameInput = document.getElementById('suLastName');
  const emailInput = document.getElementById('suEmail');
  const phoneInput = document.getElementById('suPhone');
  const passwordInput = document.getElementById('suPassword');
  const confirmInput = document.getElementById('suConfirm');
  const firstName = firstNameInput.value.trim();
  const lastName = lastNameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const phone = phoneInput.value.trim();
  const password = passwordInput.value;
  const confirm = confirmInput.value;
  const phoneDigits = phone.replace(/\D/g, '');

  firstNameInput.setCustomValidity(firstName ? '' : 'Enter your first name.');
  lastNameInput.setCustomValidity(lastName ? '' : 'Enter your last name.');
  phoneInput.setCustomValidity(phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits[0] === '1') ? '' : 'Enter a valid 10-digit US phone number.');
  passwordInput.setCustomValidity(password.length >= 8 ? '' : 'Use at least 8 characters.');
  confirmInput.setCustomValidity(password === confirm ? '' : 'The passwords do not match.');
  const invalid = [firstNameInput, lastNameInput, emailInput, phoneInput, passwordInput, confirmInput].find(function (input) { return !input.validity.valid; });
  if (invalid) { invalid.reportValidity(); invalid.focus(); return; }

  setSubmitting(signupForm, true, 'Creating account…');
  try {
    await accountRequest('/api/customer/signup', {
      firstName: firstName,
      lastName: lastName,
      email: email,
      phone: phone,
      password: password
    });
    signupForm.reset();
    redirectToOrder();
  } catch (error) {
    if (error.message.indexOf('already exists') !== -1) {
      switchTab('signin', false);
      document.getElementById('siEmail').value = email;
    }
    showMessage(error.message, 'error');
  } finally { setSubmitting(signupForm, false); }
}

async function handleSignin(event) {
  event.preventDefault();
  clearMessage();
  if (!signinForm.reportValidity()) return;
  setSubmitting(signinForm, true, 'Signing in…');
  try {
    await accountRequest('/api/customer/signin', {
      email: document.getElementById('siEmail').value.trim().toLowerCase(),
      password: document.getElementById('siPassword').value
    });
    signinForm.reset();
    redirectToOrder();
  } catch (error) {
    showMessage(error.message, 'error');
    document.getElementById('siEmail').focus();
  } finally { setSubmitting(signinForm, false); }
}

async function handleSignOut() {
  clearMessage();
  try {
    await accountRequest('/api/customer/signout', {});
    renderSession(null);
    switchTab('signin', true);
  } catch (error) { showMessage(error.message, 'error'); }
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

signupForm.addEventListener('submit', handleSignup);
signinForm.addEventListener('submit', handleSignin);
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
renderSession(null);
accountRequest('/api/customer/account').then(function (response) {
  renderSession(response.customer);
  if (!response.customer && (query.has('mode') || query.has('next'))) {
    const field = (initialMode === 'signin' ? signinForm : signupForm).querySelector('input');
    if (field) field.focus();
  }
}).catch(function (error) {
  showMessage(error.message + ' You can still try signing in or creating an account.', 'error');
});
