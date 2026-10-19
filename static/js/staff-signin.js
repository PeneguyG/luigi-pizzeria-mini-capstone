'use strict';

// Temporary browser-only demo credentials. Authentication and authorization
// must move to the server before this is used with real employee accounts.
const EMPLOYEES = Object.freeze([
  { id: '1001', password: 'pizza1001' },
  { id: '1002', password: 'pizza1002' },
  { id: '1003', password: 'pizza1003' },
  { id: '1004', password: 'pizza1004' }
]);

const form = document.getElementById('staffForm');
const message = document.getElementById('staffMessage');
const idInput = document.getElementById('employeeId');
const passwordInput = document.getElementById('staffPassword');

function showMessage(text) {
  message.textContent = text;
  message.className = 'message error';
}

function clearMessage() {
  message.textContent = '';
  message.className = 'message';
  idInput.removeAttribute('aria-invalid');
  passwordInput.removeAttribute('aria-invalid');
}

form.addEventListener('submit', function (event) {
  event.preventDefault();
  clearMessage();

  const employee = EMPLOYEES.find(function (entry) {
    return entry.id === idInput.value.trim() && entry.password === passwordInput.value;
  });

  if (!employee) {
    showMessage('Employee ID or password is incorrect. Check both fields and try again.');
    idInput.setAttribute('aria-invalid', 'true');
    passwordInput.setAttribute('aria-invalid', 'true');
    passwordInput.focus();
    return;
  }

  // Do not persist a mock role session: the dashboard role dropdown remains
  // available for testing until backend authentication and RBAC are added.
  try {
    sessionStorage.removeItem('luigis_staff_session');
  } catch (_error) {
    // Storage is optional for this temporary, role-free redirect.
  }

  // The dashboard reads this query parameter and moves focus to its heading.
  window.location.assign('/employee-dashboard.html?focus=dashboard');
});

form.querySelectorAll('input').forEach(function (input) {
  input.addEventListener('input', clearMessage);
});

if (new URLSearchParams(window.location.search).get('focus') === 'signin') {
  window.requestAnimationFrame(function () { idInput.focus(); });
}
