'use strict';

const form = document.getElementById('staffForm');
const message = document.getElementById('staffMessage');
const emailInput = document.getElementById('employeeId');
const passwordInput = document.getElementById('staffPassword');
const submitButton = form.querySelector('button[type="submit"]');
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

function showMessage(text) {
  message.textContent = text;
  message.className = 'message error';
}

function clearMessage() {
  message.textContent = '';
  message.className = 'message';
  emailInput.removeAttribute('aria-invalid');
  passwordInput.removeAttribute('aria-invalid');
}

form.addEventListener('submit', async function (event) {
  event.preventDefault();
  clearMessage();
  submitButton.disabled = true;
  form.setAttribute('aria-busy', 'true');

  try {
    const response = await fetch('/api/staff/login' + window.location.search, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        password: passwordInput.value
      })
    });
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const errorText = response.status === 429
        ? 'Too many sign-in attempts. Wait a minute, then try again.'
        : (payload.error || 'Sign-in failed. Please try again.');
      showMessage(errorText);
      emailInput.setAttribute('aria-invalid', 'true');
      passwordInput.setAttribute('aria-invalid', 'true');
      passwordInput.focus();
      return;
    }
    window.location.assign(payload.redirect);
  } catch (_error) {
    showMessage('The sign-in service could not be reached. Please try again.');
    passwordInput.focus();
  } finally {
    submitButton.disabled = false;
    form.removeAttribute('aria-busy');
  }
});

form.querySelectorAll('input').forEach(function (input) {
  input.addEventListener('input', clearMessage);
});

if (new URLSearchParams(window.location.search).get('focus') === 'signin') {
  window.requestAnimationFrame(function () { emailInput.focus(); });
}
