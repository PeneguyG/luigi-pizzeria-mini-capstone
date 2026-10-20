'use strict';

const form = document.getElementById('passwordForm');
const message = document.getElementById('passwordMessage');
const currentPasswordInput = document.getElementById('currentPassword');
const newPasswordInput = document.getElementById('newPassword');
const confirmPasswordInput = document.getElementById('confirmPassword');
const submitButton = form.querySelector('button[type="submit"]');
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

function showMessage(text) {
  message.textContent = text;
  message.className = 'message error';
}

function clearMessage() {
  message.textContent = '';
  message.className = 'message';
  [currentPasswordInput, newPasswordInput, confirmPasswordInput].forEach(function (input) {
    input.removeAttribute('aria-invalid');
  });
}

form.addEventListener('submit', async function (event) {
  event.preventDefault();
  clearMessage();
  if (newPasswordInput.value !== confirmPasswordInput.value) {
    showMessage('The new password entries do not match.');
    confirmPasswordInput.setAttribute('aria-invalid', 'true');
    confirmPasswordInput.focus();
    return;
  }

  submitButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/staff/change-password', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        currentPassword: currentPasswordInput.value,
        newPassword: newPasswordInput.value,
        confirmPassword: confirmPasswordInput.value
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      showMessage(payload.error || 'The password could not be changed. Please try again.');
      const invalidInput = (payload.error || '').toLowerCase().includes('current password')
        ? currentPasswordInput
        : newPasswordInput;
      invalidInput.setAttribute('aria-invalid', 'true');
      invalidInput.focus();
      return;
    }
    window.location.assign(payload.redirect);
  } catch (_error) {
    showMessage('The password service could not be reached. Please try again.');
    currentPasswordInput.focus();
  } finally {
    submitButton.disabled = false;
    form.removeAttribute('aria-busy');
  }
});

form.querySelectorAll('input').forEach(function (input) {
  input.addEventListener('input', clearMessage);
});

if (new URLSearchParams(window.location.search).get('focus') === 'password') {
  window.requestAnimationFrame(function () { currentPasswordInput.focus(); });
}
