// Employee sign in for the prototype.
// Employees don't sign up themselves; a manager creates their login.
// Until the database exists, the employee list lives here. These are
// DEMO accounts only — never ship real passwords in front-end code.

const EMPLOYEES = [
  { id: "1001", name: "Luigi", role: "Manager", password: "pizza1001" },
  { id: "1002", name: "Maria", role: "Cashier", password: "pizza1002" },
  { id: "1003", name: "Tony", role: "Kitchen", password: "pizza1003" },
];

const STAFF_SESSION_KEY = "luigis_staff_session";

function showStaffMessage(text) {
  const box = document.getElementById("staffMessage");
  box.textContent = text;
  box.className = "message error";
}

function renderStaffSession() {
  const id = sessionStorage.getItem(STAFF_SESSION_KEY);
  const employee = EMPLOYEES.find((e) => e.id === id);
  const signedIn = Boolean(employee);

  document.getElementById("loginView").classList.toggle("hidden", signedIn);
  document.getElementById("dashboardView").classList.toggle("hidden", !signedIn);
  document.getElementById("staffWelcome").classList.toggle("hidden", !signedIn);
  document.getElementById("staffSignOut").classList.toggle("hidden", !signedIn);

  if (signedIn) {
    document.getElementById("staffWelcome").textContent = employee.name + " (#" + employee.id + ")";
    document.getElementById("roleBadge").textContent = employee.role;
  }
}

document.getElementById("staffForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = document.getElementById("employeeId").value.trim();
  const password = document.getElementById("staffPassword").value;

  const employee = EMPLOYEES.find((e) => e.id === id && e.password === password);
  if (!employee) {
    return showStaffMessage("Incorrect employee ID or password.");
  }

  // sessionStorage: staff are signed out when the browser tab closes,
  // which suits shared restaurant computers.
  sessionStorage.setItem(STAFF_SESSION_KEY, employee.id);
  event.target.reset();
  document.getElementById("staffMessage").className = "message";
  renderStaffSession();
});

document.getElementById("staffSignOut").addEventListener("click", () => {
  sessionStorage.removeItem(STAFF_SESSION_KEY);
  renderStaffSession();
});

renderStaffSession();
