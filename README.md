# Luigi's Pizzeria order management

This project contains a Bootstrap 5 employee dashboard, a Flask JSON API, and a MariaDB schema. The dashboard is served by Flask so the browser can call the API using same-origin routes.

## Project layout

```text
backend/                 Flask application entry points
templates/               Jinja-rendered HTML pages
static/
  css/                   Page stylesheets
  js/                    Browser JavaScript
  images/                Logos and other image assets
database/
  migrations/            SQL upgrades for existing databases
  *.sql                  Schemas and optional demo seed data
deploy-gce.sh             Debian 13 / Google Compute Engine deployment
requirements*.txt        Python dependencies
```

This is a Flask project, so HTML pages belong in `templates/` and browser assets belong in `static/`; a separate `public/` directory is not needed.

## Requirements

- Python 3.9 or later
- MariaDB 10.2.1 or later (for enforced `CHECK` constraints)
- A MariaDB account with access to the `luigis_pizzeria` database

Install the Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Create the database and tables for the full customer and employee app from the repository directory:

```powershell
cmd /c "mariadb -u root -p < database/customer_portal.sql"
```

`database/schema.sql` is the earlier employee-only schema. Use it only when running the legacy `backend.app` entry point. The main app and deployment use `database/customer_portal.sql`.

If you already created the database using the earlier schema, apply the topping-count migration and then the three-serving limit migration. If the topping-count migration was already applied, only run the second command:

```powershell
cmd /c "mariadb -u root -p luigis_pizzeria < database/migrations/20261014_add_topping_quantity.sql"
cmd /c "mariadb -u root -p luigis_pizzeria < database/migrations/20261014_limit_topping_servings_to_three.sql"
```

Create a least-privilege application account after importing the schema (replace the sample password):

```sql
CREATE USER 'luigis_app'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON luigis_pizzeria.* TO 'luigis_app'@'localhost';
```

Configure the connection in PowerShell, using the MariaDB account you created for the app:

```powershell
$env:DB_HOST = "127.0.0.1"
$env:DB_PORT = "3306"
$env:DB_NAME = "luigis_pizzeria"
$env:DB_USER = "luigis_app"
$env:DB_PASSWORD = "your-local-database-password"
# Optional: set BUSINESS_TIMEZONE to the restaurant's IANA timezone if it differs from the server timezone.
# Example: $env:BUSINESS_TIMEZONE = "America/Chicago"
python -m backend.customer_portal_app
```

Open `http://127.0.0.1:5000/`. Keep database credentials in environment variables; the schema does not create a user or store credentials.

## Deploy on Google Compute Engine

`deploy-gce.sh` installs and configures the customer portal application for a Debian 13 (trixie) Compute Engine VM. It is sized for an `e2-micro`: MariaDB memory is limited, the app runs one Gunicorn worker, and the script creates a 1 GiB swap file. It clones this repository, applies `database/customer_portal.sql`, configures MariaDB, Nginx, systemd, and a recurring DuckDNS update, then requests an HTTPS certificate with Certbot.

Before running the script:

1. Create a Debian 13 VM with an external IPv4 address. A reserved static IP is recommended to avoid DNS changes when the VM is stopped and started.
2. Allow ingress TCP ports 80 and 443 in the VM's Google Cloud VPC firewall rule. Do not expose MariaDB port 3306. SSH access is also needed for setup.
3. Create a DuckDNS subdomain and have its token ready.
4. Clone this repository on the VM and run the script:

```bash
git clone https://github.com/PeneguyG/luigi-pizzeria-mini-capstone.git
cd luigi-pizzeria-mini-capstone
sudo bash ./deploy-gce.sh
```

The script defaults to `luigispizzeriapickup.duckdns.org`; override `DUCKDNS_DOMAIN` if needed. It prompts for the DuckDNS token, a Let's Encrypt contact email, and a staff password. It generates and stores a database password locally in `/etc/luigi-pizzeria/app.env`. To select another repository or branch, pass `APP_REPO_URL` or `APP_REPO_BRANCH` as environment assignments to `sudo`, for example: `sudo APP_REPO_BRANCH=main bash ./deploy-gce.sh`.

The landing page is served at `/`, customer ordering and receipt-based tracking at `/customer`, and employee order management at `/employee`. `/signup.html` and `/staff-signin.html` are browser-only sign-in prototypes: customer demo accounts are stored in local browser storage, and staff demo credentials and role checks are in JavaScript. They are not production authentication and do not enforce database or API permissions. The employee dashboard and `/api/employee/*` remain protected by Nginx Basic Auth; the username defaults to `luigi-staff`, and the shared password is chosen during setup. The app and database are on the same VM, and the database listens only on localhost.

Useful service commands:

```bash
sudo systemctl status luigi-pizzeria nginx mariadb
sudo journalctl -u luigi-pizzeria -f
sudo systemctl status luigi-pizzeria-duckdns.timer
```

## Load demo orders

After applying `database/customer_portal.sql`, load sample queue and history records from the repository directory:

```powershell
cmd /c "mariadb -u root -p luigis_pizzeria < database/demo_data.sql"
```

The script adds four active orders (Confirmed, In-Progress, Ready, and Overdue) and two completed orders. Each is marked `DEMO DATA:` in its notes. It skips existing seed orders with those notes, so it can be rerun as long as the demo markers remain unchanged. Refresh the dashboard to see the new records.

## API routes

- `POST /api/employee/orders` validates and saves a POS order and its line items in one transaction.
- `GET /api/employee/orders` returns all non-completed orders for the Bumper / active-orders view.
- `PUT /api/employee/orders/<id>` edits an active order's customer, pickup details, notes, and cart items. Prices and tax are recalculated by the server; completed orders cannot be edited.
- `PATCH /api/employee/orders/<id>` updates an order status. Completed orders move to history and cannot be reopened from the dashboard.
- `GET /api/employee/order-history` returns completed orders with their items and toppings.

The server recalculates pizza, topping, drink, and tax prices instead of trusting prices sent by the browser. Tax is 9.75% of the order subtotal, rounded to the nearest cent. Topping servings are counted per pizza, with up to 3 servings of each topping; each serving is priced according to pizza size. Order descriptions list only selected toppings and their counts. New pickup times are optional and must be later than the current time on the same day, using the server timezone or `BUSINESS_TIMEZONE`; an unchanged pickup time can remain while staff correct other order details. Pizza and drink menus reset after each successful add, and the dashboard announces the reset and updated cart totals to assistive technology.

The employee API should be placed behind the restaurant's employee authentication before it is exposed beyond a trusted local network.
