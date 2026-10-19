// Customer sign up / sign in for the prototype.
// No database yet (see proposal), so accounts are kept in the browser's
// localStorage. Swap these helpers for API calls once the database exists.

const CUSTOMERS_KEY = "luigis_customers";
const SESSION_KEY = "luigis_customer_session";

function loadCustomers() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOMERS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCustomers(customers) {
  localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(customers));
}

async function hashPassword(password) {
  if (window.crypto && crypto.subtle) {
    const bytes = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback for browsers that block crypto.subtle on file:// pages.
  return btoa(unescape(encodeURIComponent(password)));
}

function showMessage(text, type) {
  const box = document.getElementById("authMessage");
  box.textContent = text;
  box.className = "message " + type;
}

function clearMessage() {
  document.getElementById("authMessage").className = "message";
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.getElementById("signupForm").classList.toggle("hidden", name !== "signup");
  document.getElementById("signinForm").classList.toggle("hidden", name !== "signin");
  clearMessage();
}

function renderSession() {
  const email = localStorage.getItem(SESSION_KEY);
  const customer = loadCustomers().find((c) => c.email === email);
  const signedIn = Boolean(customer);

  document.getElementById("authPanel").classList.toggle("hidden", signedIn);
  document.getElementById("accountPanel").classList.toggle("hidden", !signedIn);
  document.getElementById("headerSignIn").classList.toggle("hidden", signedIn);
  document.getElementById("signOut").classList.toggle("hidden", !signedIn);
  document.getElementById("welcome").classList.toggle("hidden", !signedIn);

  const cta = document.getElementById("heroCta");
  if (signedIn) {
    const firstName = customer.name.split(" ")[0];
    document.getElementById("welcome").textContent = "Hi, " + firstName;
    document.getElementById("accountGreeting").textContent = "Welcome back, " + firstName + "!";
    cta.textContent = "View My Account";
  } else {
    cta.textContent = "Sign Up to Order";
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const name = document.getElementById("suName").value.trim();
  const email = document.getElementById("suEmail").value.trim().toLowerCase();
  const phone = document.getElementById("suPhone").value.trim();
  const password = document.getElementById("suPassword").value;
  const confirm = document.getElementById("suConfirm").value;

  if (!name || !email || !phone || !password) {
    return showMessage("Please fill out every field.", "error");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showMessage("Please enter a valid email address.", "error");
  }
  if (phone.replace(/\D/g, "").length < 10) {
    return showMessage("Please enter a 10-digit phone number.", "error");
  }
  if (password.length < 8) {
    return showMessage("Password must be at least 8 characters.", "error");
  }
  if (password !== confirm) {
    return showMessage("Passwords do not match.", "error");
  }

  const customers = loadCustomers();
  if (customers.some((c) => c.email === email)) {
    return showMessage("An account with that email already exists. Try signing in.", "error");
  }

  customers.push({
    name,
    email,
    phone,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  saveCustomers(customers);
  localStorage.setItem(SESSION_KEY, email);
  event.target.reset();
  renderSession();
}

async function handleSignin(event) {
  event.preventDefault();
  const email = document.getElementById("siEmail").value.trim().toLowerCase();
  const password = document.getElementById("siPassword").value;

  const customer = loadCustomers().find((c) => c.email === email);
  if (!customer || customer.passwordHash !== (await hashPassword(password))) {
    return showMessage("Incorrect email or password.", "error");
  }

  localStorage.setItem(SESSION_KEY, email);
  event.target.reset();
  renderSession();
}

function handleSignOut() {
  localStorage.removeItem(SESSION_KEY);
  switchTab("signin");
  renderSession();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
document.getElementById("signupForm").addEventListener("submit", handleSignup);
document.getElementById("signinForm").addEventListener("submit", handleSignin);
document.getElementById("signOut").addEventListener("click", handleSignOut);
document.getElementById("headerSignIn").addEventListener("click", () => {
  switchTab("signin");
  document.getElementById("account").scrollIntoView({ behavior: "smooth" });
});

renderSession();
