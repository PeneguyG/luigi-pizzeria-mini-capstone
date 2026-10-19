'use strict';

// Front-end demonstration only. Credentials and role checks in browser code
// are visible and editable; production RBAC must be enforced by the server.
const EMPLOYEES = Object.freeze([
  { id: '1001', name: 'Luigi', role: 'admin', password: 'pizza1001' },
  { id: '1002', name: 'Maria', role: 'manager', password: 'pizza1002' },
  { id: '1003', name: 'Tony', role: 'employee', password: 'pizza1003' },
  { id: '1004', name: 'Rosa', role: 'employee', password: 'pizza1004' }
]);

const STAFF_SESSION_KEY = 'luigis_staff_session';
const form = document.getElementById('staffForm');
const message = document.getElementById('staffMessage');
const sessionPanel = document.getElementById('staffSession');

const roleDetails = {
  admin: 'Admin demo: access to employee, manager, and admin dashboard views.',
  manager: 'Manager demo: access to employee and manager dashboard views.',
  employee: 'Employee demo: access to point of sale, active orders, and order history.'
};

function employeeForSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STAFF_SESSION_KEY) || 'null');
    if (!saved || typeof saved.id !== 'string') return null;
    return EMPLOYEES.find(function (employee) {
      return employee.id === saved.id && employee.role === saved.role;
    }) || null;
  } catch (_error) {
    return null;
  }
}

function showMessage(text) {
  message.textContent = text;
  message.className = 'message error';
}

function clearMessage() {
  message.textContent = '';
  message.className = 'message';
  document.getElementById('employeeId').removeAttribute('aria-invalid');
  document.getElementById('staffPassword').removeAttribute('aria-invalid');
}

function renderSession() {
  const employee = employeeForSession();
  const signedIn = Boolean(employee);
  form.hidden = signedIn;
  sessionPanel.hidden = !signedIn;
  sessionPanel.classList.toggle('hidden', !signedIn);
  document.getElementById('demo-warning').hidden = signedIn;
  document.querySelector('.demo-accounts').hidden = signedIn;

  if (signedIn) {
    document.getElementById('staffWelcome').textContent = employee.name + ' · ' + employee.role;
    document.getElementById('rolePermissions').textContent = roleDetails[employee.role];
  }
}

form.addEventListener('submit', function (event) {
  event.preventDefault();
  clearMessage();

  const idInput = document.getElementById('employeeId');
  const passwordInput = document.getElementById('staffPassword');
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

  try {
    sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify({
      id: employee.id,
      name: employee.name,
      role: employee.role
    }));
  } catch (_error) {
    showMessage('This browser could not start a staff session. Enable session storage and try again.');
    return;
  }

  // The dashboard reads this role to show its matching mock permissions.
  // Nginx still applies its separate shared Basic Auth check on /employee.
  window.location.assign('/employee?focus=dashboard');
});

document.getElementById('staffSignOut').addEventListener('click', function () {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
  renderSession();
  clearMessage();
  document.getElementById('employeeId').focus();
});

form.querySelectorAll('input').forEach(function (input) {
  input.addEventListener('input', function () {
    clearMessage();
  });
});

renderSession();
if (new URLSearchParams(window.location.search).get('focus') === 'signin' && !employeeForSession()) {
  window.requestAnimationFrame(function () { document.getElementById('employeeId').focus(); });
}
