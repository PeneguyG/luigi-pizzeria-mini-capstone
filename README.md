# Luigi's Pizzeria

Luigi's Pizzeria is a pickup-ordering and order-management web application. It uses a Flask backend, MariaDB for persistent data, and responsive Bootstrap 5 pages with vanilla JavaScript. The deployed application entry point is `backend.customer_portal_app:app`; it serves both the website and same-origin JSON API.

## Features

### Customer website

- Landing page with business hours, customer sign-in/sign-up, staff sign-in, and order tracking links.
- Customer accounts are stored in MariaDB. Sign-up and sign-in work across devices; passwords are hashed server-side. The customer account area supports sign-out, saved cart drafts, and account order history.
- Guest checkout is supported separately from signed-in ordering. Guests see the current manager-selected specials; signed-in customers with order history can see and reorder recent pizzas. Signed-in customers without pizza history see the specials.
- Pizza ordering groups toppings into Meats, Vegetables, and Fruit. Each topping can have up to three servings. Drink size, cart quantity, pickup time, notes, and the current tax rate are supported.
- Pickup scheduling follows the restaurant's 10:00 a.m.–11:00 p.m. daily business hours. Online pickup slots end at 10:40 p.m.; same-day orders require 20 minutes' notice. Employee-entered dates can be scheduled up to two months ahead.
- The backend validates orders and calculates prices and 9.75% tax. A successful order receives a customer-facing random code generated with Python's `secrets` module and redirects to its tracking view.
- The standalone order tracker supports order-code lookup and phone-number lookup. Signed-in customers can view their orders. Tracking credentials are protected by tokens; only token hashes are stored for customer receipts.
- Customer password recovery uses a recovery code. The code is generated from the signed-in account and must be saved by the customer; this project does not send recovery email.

### Employee dashboard

- Individual staff sign-in with Flask sessions and owner, manager, and employee roles.
- Employees can create POS orders, view and update active orders, mark orders overdue based on the configured business timezone, and browse completed order history.
- Active and completed orders show pickup times in 12-hour format. Order history supports search, a scrollable list, and pagination.
- Managers and owners can manage staff accounts, search registered customer accounts, view a selected customer's orders, and manage exactly two rotating specials. Owners can create or promote managers; managers can manage employee accounts. Staff accounts support activation, deactivation, and password changes.
- The manager dashboard shows live daily and weekly sales and allows comparing a selected day or week with the current period.
- Employee and customer interfaces use Bootstrap utilities, keyboard-accessible controls, labeled forms, and live announcements for dynamic updates.

## Project layout

```text
backend/
  customer_portal_app.py   Main Flask app, JSON API, pricing, and database access
  customer_accounts.py    Customer signup, sign-in, sessions, and recovery
  app.py                  Legacy employee-only Flask app
templates/                Jinja HTML pages
static/
  css/                    Page stylesheets
  images/                 Logo and topping images
  js/                     Vanilla JavaScript for each page
database/
  customer_portal.sql     Current schema for the deployed application
  schema.sql              Legacy employee-only schema
  demo_data.sql           Optional demo active and completed orders
  migrations/             SQL upgrades for existing installations
docs/data-flow.md         Application and database data-flow diagrams
deploy-gce.sh             Debian 13 / Google Compute Engine provisioning
requirements*.txt         Python dependencies
```

## Technology

- Python 3.9+ with Flask, PyMySQL, and `tzdata`
- MariaDB
- HTML5, CSS3, Bootstrap 5, and vanilla JavaScript
- Gunicorn and Nginx for production deployment

Install Python dependencies with:

```bash
python -m pip install -r requirements-customer-portal.txt
```

## Local setup

Create the current customer and employee database schema from the repository root:

```bash
mariadb -u root -p < database/customer_portal.sql
```

Create an application database user with limited permissions (change the password):

```sql
CREATE USER 'luigis_app'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON luigis_pizzeria.* TO 'luigis_app'@'localhost';
```

Set the connection settings in your shell. Do not commit database passwords or session keys:

```bash
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_NAME=luigis_pizzeria
export DB_USER=luigis_app
export DB_PASSWORD='your-local-database-password'
export FLASK_SECRET_KEY='replace-with-a-long-random-secret'
export SESSION_COOKIE_SECURE=false
export BUSINESS_TIMEZONE=America/Chicago
```

For PowerShell, set the same values with `$env:NAME = "value"`, for example:

```powershell
$env:DB_HOST = "127.0.0.1"
$env:DB_PORT = "3306"
$env:DB_NAME = "luigis_pizzeria"
$env:DB_USER = "luigis_app"
$env:DB_PASSWORD = "your-local-database-password"
$env:FLASK_SECRET_KEY = "replace-with-a-long-random-secret"
$env:SESSION_COOKIE_SECURE = "false"
$env:BUSINESS_TIMEZONE = "America/Chicago"
```

Then create the initial owner and run Flask:

```bash
python -m flask --app backend.customer_portal_app create-owner
python -m backend.customer_portal_app
```

Open `http://127.0.0.1:5000/`. The app defaults to `America/Chicago` for business hours, pickup validation, overdue status, and sales reporting. Set `BUSINESS_TIMEZONE` to another IANA timezone if the restaurant is elsewhere.

## Main pages

| URL | Purpose |
| --- | --- |
| `/` | Customer landing page |
| `/signup` | Customer account creation |
| `/customer` | Customer menu, cart, and checkout |
| `/order-tracker` | Guest and signed-in order tracking |
| `/staff-signin` | Employee sign-in |
| `/employee` | Role-based employee dashboard |
| `/staff-change-password` | Staff password change |

## API overview

### Customer APIs

- `POST /api/customer/signup`, `POST /api/customer/signin`, `POST /api/customer/signout`, `GET /api/customer/account`
- `POST /api/customer/recovery-code`, `POST /api/customer/recover-password`
- `GET /api/customer/menu`, `GET /api/customer/specials`, `GET /api/customer/favorites`
- `POST /api/customer/orders` creates a customer or guest pickup order.
- `GET /api/customer/orders/<order_code>` returns a receipt when supplied a valid tracking token.
- `POST /api/customer/track` looks up orders by order code or phone number.
- `GET/PUT /api/customer/draft` saves and restores a signed-in customer's cart; `GET /api/customer/receipts` returns their account orders.

### Employee and manager APIs

- `POST /api/staff/login`, `GET /api/staff/session`, `POST /api/staff/logout`, `POST /api/staff/change-password`
- `GET/POST /api/staff/accounts`, `PATCH/DELETE /api/staff/accounts/<id>` for role-authorized staff administration.
- `GET /api/employee/orders` lists active orders; `POST /api/employee/orders` creates an employee POS order; `PATCH /api/employee/orders/<id>` updates an order status.
- `GET /api/employee/order-history` lists completed orders.
- `GET /api/staff/customers?q=...` searches registered customer accounts; `GET /api/staff/customer-account-orders?email=...` returns a registered customer's orders.
- `GET /api/staff/sales-summary?date=YYYY-MM-DD&compare=day|week` returns the live and comparison sales metrics.
- `GET /api/customer/specials` serves the current specials; managers and owners save exactly two specials with `PUT /api/staff/specials`.

All staff APIs enforce Flask session authentication, role permissions, and CSRF checks on state-changing requests. Customer account endpoints use secure session cookies. The application validates order items and recalculates prices and tax on the server; it does not trust totals supplied by the browser. Customer orders are limited to 20 total pizzas and drinks; employee orders are limited to 50. Each topping is limited to three servings per pizza.

## Database updates

Use `database/customer_portal.sql` for a new installation. `database/schema.sql` is the older employee-only schema and is not the schema used by the deployed app. For existing databases, review and apply the relevant files in `database/migrations/` before restarting the application. The GCE provisioning script applies the current schema and includes idempotent compatibility upgrades for older databases.

The public order-code migration is:

```bash
mariadb -u root -p luigis_pizzeria < database/migrations/20261024_add_public_order_code.sql
```

The provisioning script applies it and other required compatibility changes. Do not rerun an `ALTER TABLE ADD COLUMN` manually if the column already exists; check `information_schema.columns` first.

Optional demo order records can be added with:

```bash
mariadb -u root -p luigis_pizzeria < database/demo_data.sql
```

The seed script creates marked sample active and completed orders and skips matching demo rows when run again.

## Google Compute Engine deployment

`deploy-gce.sh` provisions a Debian 13 (trixie) VM, MariaDB, Nginx, a systemd service, Gunicorn, DuckDNS updates, and a Let's Encrypt HTTPS certificate. It is configured for a small `e2-micro` VM, including bounded MariaDB memory and a 1 GiB swap file.

1. Create a Debian 13 VM and configure the Google Cloud firewall to allow TCP 80 and 443. Keep MariaDB port 3306 private.
2. Create a DuckDNS hostname and have its token available.
3. Clone this repository and run the installer:

   ```bash
   git clone https://github.com/PeneguyG/luigi-pizzeria-mini-capstone.git
   cd luigi-pizzeria-mini-capstone
   sudo bash ./deploy-gce.sh
   ```

The script defaults to `luigispizzeriapickup.duckdns.org`, prompts for the DuckDNS token and certificate email, and stores generated application credentials in `/etc/luigi-pizzeria/app.env`. Use `APP_REPO_URL` and `APP_REPO_BRANCH` to choose a different source branch. After deployment, create the owner account once:

```bash
sudo bash -c 'set -a; . /etc/luigi-pizzeria/app.env; set +a; cd /opt/luigi-pizzeria; .venv/bin/flask --app backend.customer_portal_app create-owner'
```

To update an existing VM, fetch and check out the desired repository branch as the repository owner, then run the provisioning script again to apply compatible schema/configuration updates and restart services. Keep `/etc/luigi-pizzeria/app.env` private and back up MariaDB before manual schema changes.

Useful service commands:

```bash
sudo systemctl status luigi-pizzeria nginx mariadb
sudo journalctl -u luigi-pizzeria -f
sudo systemctl status luigi-pizzeria-duckdns.timer
```

## Data-flow diagram

See [docs/data-flow.md](docs/data-flow.md) for system context, customer and employee order flows, authentication, and the MariaDB tables used by each process.
