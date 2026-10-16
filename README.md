# Luigi's Pizzeria order management

This project contains a Bootstrap 5 employee dashboard, a Flask JSON API, and a MariaDB schema. The dashboard is served by Flask so the browser can call the API using same-origin routes.

## Requirements

- Python 3.9 or later
- MariaDB 10.2.1 or later (for enforced `CHECK` constraints)
- A MariaDB account with access to the `luigis_pizzeria` database

Install the Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Create the database and tables from the repository directory:

```powershell
cmd /c "mariadb -u root -p < schema.sql"
```

If you already created the database using the earlier schema, apply the topping-count migration and then the three-serving limit migration. If the topping-count migration was already applied, only run the second command:

```powershell
cmd /c "mariadb -u root -p luigis_pizzeria < migrations/20261014_add_topping_quantity.sql"
cmd /c "mariadb -u root -p luigis_pizzeria < migrations/20261014_limit_topping_servings_to_three.sql"
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
python app.py
```

Open `http://127.0.0.1:5000/`. Keep database credentials in environment variables; the schema does not create a user or store credentials.

## Load demo orders

After applying `schema.sql`, load sample queue and history records from the repository directory:

```powershell
cmd /c "mariadb -u root -p luigis_pizzeria < demo_data.sql"
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
