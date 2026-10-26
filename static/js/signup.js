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
const recoveryPanel = document.getElementById('recoveryPanel');
const recoveryForm = document.getElementById('recoveryForm');
const backupPanel = document.getElementById('backupCodePanel');
let signedInCustomer = null;
let backupFlow = null;
let recoveringEmail = '';
let accountBusy = false;

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
  const isSignin = name === 'signin';
  signinPanel.hidden = !isSignin;
  signinPanel.classList.toggle('hidden', !isSignin);
  recoveryPanel.hidden = name !== 'recovery';
  recoveryPanel.classList.toggle('hidden', name !== 'recovery');
  clearMessage();
  if (moveFocus) {
    const field = (name === 'recovery' ? recoveryForm : isSignup ? signupForm : signinForm).querySelector('input');
    if (field) field.focus();
  }
}

function renderSession(customer) {
  signedInCustomer = customer;
  document.getElementById('recoveryCodeSetup').hidden = !customer || Boolean(customer.hasRecoveryCode);
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
    const created = await accountRequest('/api/customer/signup', {
      firstName: firstName,
      lastName: lastName,
      email: email,
      phone: phone,
      password: password
    });
    signupForm.reset();
    renderSession({email: created.email, firstName: created.firstName, name: created.name, hasRecoveryCode: true});
    presentBackup(created.recoveryCode, 'signup');
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
    const customer = await accountRequest('/api/customer/signin', {
      email: document.getElementById('siEmail').value.trim().toLowerCase(),
      password: document.getElementById('siPassword').value
    });
    signinForm.reset();
    renderSession(customer);
    document.getElementById('accountGreeting').focus();
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

const initialMode = ['signin', 'recovery'].includes(query.get('mode')) ? query.get('mode') : 'signup';
switchTab(initialMode, false);
renderSession(null);
accountRequest('/api/customer/account').then(function (response) {
  if (backupFlow) return;
  renderSession(response.customer);
  if (!response.customer && (query.has('mode') || query.has('next'))) {
    const field = (initialMode === 'recovery' ? recoveryForm : initialMode === 'signin' ? signinForm : signupForm).querySelector('input');
    if (field) field.focus();
  }
}).catch(function (error) {
  showMessage(error.message + ' You can still try signing in or creating an account.', 'error');
});


function presentBackup(code, flow) {
  if (!code) throw new Error('Your code could not be displayed. Sign in to generate a replacement.');
  backupFlow = flow;
  if (signedInCustomer) signedInCustomer.hasRecoveryCode = true;
  document.getElementById('recoveryCodeSetup').hidden = true;
  authPanel.hidden = true;
  authPanel.classList.add('hidden');
  accountPanel.hidden = true;
  accountPanel.classList.add('hidden');
  backupPanel.hidden = false;
  backupPanel.classList.remove('hidden');
  document.getElementById('headerSignIn').hidden = true;
  document.getElementById('headerSignIn').classList.add('hidden');
  document.getElementById('signOut').hidden = true;
  document.getElementById('signOut').classList.add('hidden');
  document.getElementById('backupCodeValue').value = code;
  document.getElementById('backupSaved').checked = false;
  document.getElementById('backupContinue').disabled = true;
  document.getElementById('backupContinue').textContent = flow === 'reset' ? 'Continue to sign in' : 'Continue to ordering';
  document.getElementById('backupCodeMessage').textContent = flow === 'reset'
    ? 'Your password was updated and existing sessions were signed out. This replacement code invalidates your old code.'
    : flow === 'signup' ? 'Your account is ready. Save this code before continuing.'
    : 'This replacement code immediately invalidates your previous recovery code.';
  document.getElementById('backupCodeHeading').focus();
}

document.getElementById('openRecovery').addEventListener('click', function (event) {
  event.preventDefault();
  if (accountBusy) return;
  document.getElementById('reEmail').value = document.getElementById('siEmail').value;
  switchTab('recovery', true);
});
document.getElementById('backToSignin').addEventListener('click', function () {
  if (!accountBusy) switchTab('signin', true);
});
document.getElementById('backupSaved').addEventListener('change', function () {
  document.getElementById('backupContinue').disabled = !this.checked;
});
document.getElementById('backupContinue').addEventListener('click', function () {
  if (!document.getElementById('backupSaved').checked) return;
  const flow = backupFlow;
  document.getElementById('backupCodeValue').value = '';
  backupFlow = null;
  backupPanel.hidden = true;
  backupPanel.classList.add('hidden');
  if (flow === 'reset') {
    renderSession(null);
    switchTab('signin', true);
    document.getElementById('siEmail').value = recoveringEmail;
    showMessage('Password updated. Sign in with your new password.', 'success');
  } else {
    redirectToOrder();
  }
});

const newPassword = document.getElementById('rePassword');
const newConfirm = document.getElementById('reConfirm');
[newPassword, newConfirm].forEach(function (input) {
  input.addEventListener('input', function () { newConfirm.setCustomValidity(''); });
});
recoveryForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  if (accountBusy) return;
  newConfirm.setCustomValidity(newPassword.value === newConfirm.value ? '' : 'The passwords do not match.');
  if (!recoveryForm.reportValidity()) return;
  accountBusy = true;
  recoveringEmail = document.getElementById('reEmail').value.trim().toLowerCase();
  setSubmitting(recoveryForm, true, 'Resetting password…');
  try {
    const result = await accountRequest('/api/customer/recover-password', {
      email: recoveringEmail, recoveryCode: document.getElementById('reCode').value,
      password: newPassword.value, confirmPassword: newConfirm.value
    });
    recoveryForm.reset();
    renderSession(null);
    presentBackup(result.recoveryCode, 'reset');
  } catch (error) {
    showMessage(error.message, 'error');
    newPassword.value = '';
    newConfirm.value = '';
  } finally {
    accountBusy = false;
    setSubmitting(recoveryForm, false);
  }
});
const generateForm = document.getElementById('generateCodeForm');
generateForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  if (accountBusy || !generateForm.reportValidity()) return;
  accountBusy = true;
  const errorBox = document.getElementById('generateCodeError');
  errorBox.hidden = true;
  setSubmitting(generateForm, true, 'Generating code…');
  try {
    const result = await accountRequest('/api/customer/recovery-code', {
      password: document.getElementById('codeCurrentPassword').value
    });
    generateForm.reset();
    presentBackup(result.recoveryCode, 'generate');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    document.getElementById('codeCurrentPassword').focus();
  } finally {
    document.getElementById('codeCurrentPassword').value = '';
    accountBusy = false;
    setSubmitting(generateForm, false);
  }
});
