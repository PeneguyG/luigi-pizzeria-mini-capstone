"""Flask API and same-origin host for Luigi's employee order dashboard."""

from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
import logging
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Flask, jsonify, request, send_from_directory
import pymysql
from pymysql.cursors import DictCursor


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

TAX_RATE_BPS = 975
TAX_RATE = Decimal(TAX_RATE_BPS) / Decimal(10000)
CENT = Decimal("0.01")
ALLOWED_STATUSES = {"Confirmed", "In-Progress", "Ready", "Overdue", "Completed"}
ALLOWED_CHANNELS = {"In-store", "Phone pickup"}
DRINKS = {"Iced tea", "Dr. Pepper", "Cola", "Un-cola"}
DRINK_PRICES = {
    "Small": Decimal("1.00"),
    "Medium": Decimal("2.00"),
    "Large": Decimal("3.00"),
}
PIZZA_PRICES = {
    "Small": {"inches": 12, "base": Decimal("5.00"), "topping": Decimal("1.00"), "portion": "¼ cup"},
    "Medium": {"inches": 14, "base": Decimal("7.00"), "topping": Decimal("2.00"), "portion": "½ cup"},
    "Large": {"inches": 18, "base": Decimal("9.00"), "topping": Decimal("3.00"), "portion": "1 cup"},
}
ALLOWED_TOPPINGS = {
    "Pepperoni", "Italian sausage", "Beef", "Green peppers", "Jalapenos",
    "Pineapple", "Onion", "Black olives", "Diced tomatoes",
}

class ApiError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def database_connection():
    """Open a MariaDB connection using process environment configuration."""
    password = os.environ.get("DB_PASSWORD")
    if password is None:
        raise RuntimeError("DB_PASSWORD is not configured")
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "3306")),
        database=os.environ.get("DB_NAME", "luigis_pizzeria"),
        user=os.environ.get("DB_USER", "luigis_app"),
        password=password,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=False,
        connect_timeout=5,
        read_timeout=15,
        write_timeout=15,
    )


def required_text(value, label, max_length):
    if not isinstance(value, str):
        raise ApiError(label + " is required.")
    value = value.strip()
    if not value:
        raise ApiError(label + " is required.")
    if len(value) > max_length:
        raise ApiError(label + " is too long.")
    return value


def parse_quantity(value, item_type):
    if isinstance(value, bool):
        raise ApiError("Item quantity must be a whole number.")
    try:
        quantity = int(value)
        if isinstance(value, float) and not value.is_integer():
            raise ValueError()
    except (TypeError, ValueError):
        raise ApiError("Item quantity must be a whole number.")
    maximum = 20 if item_type == "Pizza" else 50
    if quantity < 1 or quantity > maximum:
        raise ApiError("Quantity must be between 1 and " + str(maximum) + ".")
    return quantity


def parse_topping_quantity(value):
    if isinstance(value, bool):
        raise ApiError("Each topping serving count must be a whole number.")
    try:
        quantity = int(value)
        if isinstance(value, float) and not value.is_integer():
            raise ValueError()
    except (TypeError, ValueError):
        raise ApiError("Each topping serving count must be a whole number.")
    if quantity < 1 or quantity > 3:
        raise ApiError("Topping servings must be between 1 and 3 per pizza.")
    return quantity


def prepare_items(raw_items):
    if not isinstance(raw_items, list) or not raw_items:
        raise ApiError("Add at least one pizza or drink before placing the order.")
    if len(raw_items) > 100:
        raise ApiError("An order can contain at most 100 cart lines.")

    items = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ApiError("Each cart item must be an object.")
        item_type = raw.get("type")
        if not isinstance(item_type, str) or item_type not in {"Pizza", "Drink"}:
            raise ApiError("Unsupported cart item type.")
        quantity = parse_quantity(raw.get("quantity"), item_type)

        if item_type == "Pizza":
            size = raw.get("pizzaSize")
            if not isinstance(size, str) or size not in PIZZA_PRICES:
                raise ApiError("Choose a valid pizza size.")
            raw_toppings = raw.get("toppings", [])
            if not isinstance(raw_toppings, list):
                raise ApiError("Pizza toppings must be a list of topping serving counts.")
            toppings = []
            seen_toppings = set()
            for raw_topping in raw_toppings:
                if not isinstance(raw_topping, dict):
                    raise ApiError("Each topping needs a name and serving count.")
                topping_name = raw_topping.get("name")
                if not isinstance(topping_name, str) or topping_name not in ALLOWED_TOPPINGS:
                    raise ApiError("One or more selected toppings are unavailable.")
                if topping_name in seen_toppings:
                    raise ApiError("A topping can only be listed once per pizza.")
                seen_toppings.add(topping_name)
                toppings.append({"name": topping_name, "quantity": parse_topping_quantity(raw_topping.get("quantity"))})

            pricing = PIZZA_PRICES[size]
            topping_servings = sum(topping["quantity"] for topping in toppings)
            unit_price = pricing["base"] + pricing["topping"] * topping_servings
            topping_text = ", ".join(
                "{}× {}".format(topping["quantity"], topping["name"])
                for topping in toppings
            )
            description = "Toppings: " + topping_text if topping_text else ""
            items.append({
                "type": "Pizza",
                "name": "{} ({}-inch) pizza".format(size, pricing["inches"]),
                "pizzaSize": size,
                "drinkName": None,
                "drinkSize": None,
                "quantity": quantity,
                "unitPrice": unit_price,
                "description": description,
                "toppings": toppings,
                "portion": pricing["portion"],
                "toppingUnitPrice": pricing["topping"],
            })
        else:
            drink_name = raw.get("drinkName")
            drink_size = raw.get("drinkSize")
            if (
                not isinstance(drink_name, str) or drink_name not in DRINKS
                or not isinstance(drink_size, str) or drink_size not in DRINK_PRICES
            ):
                raise ApiError("Choose a valid drink and drink size.")
            items.append({
                "type": "Drink",
                "name": "{} {}".format(drink_size, drink_name),
                "pizzaSize": None,
                "drinkName": drink_name,
                "drinkSize": drink_size,
                "quantity": quantity,
                "unitPrice": DRINK_PRICES[drink_size],
                "description": "",
                "toppings": [],
                "portion": None,
                "toppingUnitPrice": None,
            })

    subtotal = sum((item["unitPrice"] * item["quantity"] for item in items), Decimal("0.00"))
    subtotal = subtotal.quantize(CENT, rounding=ROUND_HALF_UP)
    tax_amount = (subtotal * TAX_RATE).quantize(CENT, rounding=ROUND_HALF_UP)
    return items, subtotal, tax_amount, subtotal + tax_amount


def save_customer(cursor, customer_name, customer_phone):
    cursor.execute(
        """
        INSERT INTO customers (full_name, phone)
        VALUES (%s, %s)
        ON DUPLICATE KEY UPDATE
            full_name = VALUES(full_name),
            customer_id = LAST_INSERT_ID(customer_id)
        """,
        (customer_name, customer_phone),
    )
    return cursor.lastrowid


def insert_order_items(cursor, order_id, items):
    cursor.execute("SELECT topping_id, topping_name FROM toppings")
    topping_ids = {row["topping_name"]: row["topping_id"] for row in cursor.fetchall()}
    for line_number, item in enumerate(items, start=1):
        cursor.execute(
            """
            INSERT INTO order_items
                (order_id, line_number, item_type, item_name, pizza_size,
                 drink_name, drink_size, quantity, unit_price, description)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                order_id, line_number, item["type"], item["name"], item["pizzaSize"],
                item["drinkName"], item["drinkSize"], item["quantity"],
                item["unitPrice"], item["description"],
            ),
        )
        item_id = cursor.lastrowid
        for topping in item["toppings"]:
            cursor.execute(
                """
                INSERT INTO order_item_toppings
                    (order_item_id, topping_id, quantity, portion, unit_price)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (item_id, topping_ids[topping["name"]], topping["quantity"], item["portion"], item["toppingUnitPrice"]),
            )


def pickup_time_value(value, allow_past=False):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ApiError("Pickup time must use HH:MM format.")
    try:
        pickup_time = datetime.strptime(value, "%H:%M").time()
    except ValueError:
        raise ApiError("Pickup time must use HH:MM format.")
    timezone_name = os.environ.get("BUSINESS_TIMEZONE")
    try:
        now = datetime.now(ZoneInfo(timezone_name)) if timezone_name else datetime.now().astimezone()
    except ZoneInfoNotFoundError as exc:
        raise ApiError("BUSINESS_TIMEZONE must be a valid IANA timezone name.", 503) from exc
    current_minute = now.time().replace(tzinfo=None, second=0, microsecond=0)
    if not allow_past and pickup_time <= current_minute:
        raise ApiError("Pickup time must be later than the current time today.")
    return pickup_time


def iso_timestamp(value):
    return value.isoformat(sep=" ", timespec="milliseconds") if value else None


def serialize_order_row(row):
    pickup_time = row.get("pickupTime")
    return {
        "id": int(row["id"]),
        "source": row["source"],
        "channel": row["channel"],
        "customerName": row["customerName"],
        "customerPhone": row["customerPhone"],
        "items": [],
        "subtotalPrice": float(row["subtotal"]),
        "taxRate": int(row["taxRateBasisPoints"]) / 10000,
        "taxRateBasisPoints": int(row["taxRateBasisPoints"]),
        "taxPrice": float(row["taxAmount"]),
        "totalPrice": float(row["total"]),
        "notes": row["notes"],
        "pickupTime": str(pickup_time)[:5] if pickup_time else "",
        "status": row["status"],
        "createdAt": iso_timestamp(row["createdAt"]),
        "completedAt": iso_timestamp(row["completedAt"]),
    }


def load_orders(completed):
    connection = database_connection()
    try:
        cursor = connection.cursor()
        where_clause = "o.status = 'Completed'" if completed else "o.status <> 'Completed'"
        cursor.execute(
            """
            SELECT o.order_id AS id, o.source, o.channel, o.status, o.notes,
                   o.subtotal, o.tax_rate_bps AS taxRateBasisPoints,
                   o.tax_amount AS taxAmount, o.total,
                   o.pickup_time AS pickupTime, o.created_at AS createdAt,
                   o.completed_at AS completedAt,
                   c.full_name AS customerName, c.phone AS customerPhone
              FROM orders AS o
              JOIN customers AS c ON c.customer_id = o.customer_id
             WHERE """ + where_clause + " ORDER BY " + ("o.completed_at" if completed else "o.created_at") + " DESC, o.order_id DESC"
        )
        order_rows = cursor.fetchall()
        orders = {int(row["id"]): serialize_order_row(row) for row in order_rows}
        if not orders:
            return []

        order_ids = list(orders.keys())
        placeholders = ",".join(["%s"] * len(order_ids))
        cursor.execute(
            """
            SELECT order_item_id AS itemId, order_id AS orderId, item_type AS itemType,
                   item_name AS itemName, pizza_size AS pizzaSize, drink_name AS drinkName,
                   drink_size AS drinkSize, quantity, unit_price AS unitPrice, description
              FROM order_items
             WHERE order_id IN (""" + placeholders + ") ORDER BY order_id, line_number",
            tuple(order_ids),
        )
        item_rows = cursor.fetchall()
        item_by_id = {}
        for row in item_rows:
            item = {
                "type": row["itemType"],
                "name": row["itemName"],
                "pizzaSize": row["pizzaSize"],
                "drinkName": row["drinkName"],
                "drinkSize": row["drinkSize"],
                "quantity": int(row["quantity"]),
                "unitPrice": float(row["unitPrice"]),
                "description": row["description"],
                "toppings": [],
            }
            item_by_id[int(row["itemId"])] = item
            orders[int(row["orderId"])]["items"].append(item)

        item_ids = list(item_by_id.keys())
        if item_ids:
            topping_placeholders = ",".join(["%s"] * len(item_ids))
            cursor.execute(
                """
                SELECT oit.order_item_id AS itemId, t.topping_name AS toppingName,
                       oit.quantity AS toppingQuantity
                  FROM order_item_toppings AS oit
                  JOIN toppings AS t ON t.topping_id = oit.topping_id
                 WHERE oit.order_item_id IN (""" + topping_placeholders + ") ORDER BY t.topping_name",
                tuple(item_ids),
            )
            for row in cursor.fetchall():
                item_by_id[int(row["itemId"])]["toppings"].append({
                    "name": row["toppingName"],
                    "quantity": int(row["toppingQuantity"]),
                })
        return list(orders.values())
    finally:
        connection.close()


@app.get("/")
def dashboard():
    return send_from_directory(BASE_DIR, "employee-dashboard.html")


@app.get("/api/employee/orders")
def get_active_orders():
    try:
        return jsonify(load_orders(completed=False))
    except RuntimeError as exc:
        app.logger.error("MariaDB configuration error: %s", exc)
        return jsonify({"error": "MariaDB is not configured: " + str(exc)}), 503
    except Exception:
        app.logger.exception("Could not fetch active orders")
        return jsonify({"error": "MariaDB is unavailable or the schema is missing. Check the server log and database settings."}), 503


@app.get("/api/employee/order-history")
def get_order_history():
    try:
        return jsonify(load_orders(completed=True))
    except RuntimeError as exc:
        app.logger.error("MariaDB configuration error: %s", exc)
        return jsonify({"error": "MariaDB is not configured: " + str(exc)}), 503
    except Exception:
        app.logger.exception("Could not fetch order history")
        return jsonify({"error": "MariaDB is unavailable or the schema is missing. Check the server log and database settings."}), 503


@app.post("/api/employee/orders")
def create_order():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Send order details as JSON."}), 400

    try:
        customer_name = required_text(body.get("customerName"), "Customer name", 80)
        customer_phone = required_text(body.get("customerPhone"), "Customer phone", 30)
        channel = body.get("channel")
        if not isinstance(channel, str) or channel not in ALLOWED_CHANNELS:
            raise ApiError("Choose a valid order channel.")
        pickup_time = pickup_time_value(body.get("pickupTime"))
        notes = body.get("notes", "")
        if not isinstance(notes, str) or len(notes) > 4000:
            raise ApiError("Order notes must be text no longer than 4000 characters.")
        items, subtotal, tax_amount, total = prepare_items(body.get("items"))

        connection = database_connection()
        try:
            connection.begin()
            cursor = connection.cursor()
            customer_id = save_customer(cursor, customer_name, customer_phone)
            cursor.execute(
                """
                INSERT INTO orders
                    (customer_id, source, channel, pickup_time, status, notes,
                     subtotal, tax_rate_bps, tax_amount, total)
                VALUES (%s, 'Employee POS', %s, %s, 'Confirmed', %s, %s, %s, %s, %s)
                """,
                (customer_id, channel, pickup_time, notes, subtotal, TAX_RATE_BPS, tax_amount, total),
            )
            order_id = cursor.lastrowid

            insert_order_items(cursor, order_id, items)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        created_at = datetime.now().astimezone().replace(tzinfo=None)
        response_order = {
            "id": int(order_id),
            "source": "Employee POS",
            "channel": channel,
            "customerName": customer_name,
            "customerPhone": customer_phone,
            "items": [
                {
                    "type": item["type"],
                    "name": item["name"],
                    "pizzaSize": item["pizzaSize"],
                    "drinkName": item["drinkName"],
                    "drinkSize": item["drinkSize"],
                    "quantity": item["quantity"],
                    "unitPrice": float(item["unitPrice"]),
                    "description": item["description"],
                    "toppings": item["toppings"],
                }
                for item in items
            ],
            "subtotalPrice": float(subtotal),
            "taxRate": float(TAX_RATE),
            "taxRateBasisPoints": TAX_RATE_BPS,
            "taxPrice": float(tax_amount),
            "totalPrice": float(total),
            "notes": notes,
            "pickupTime": body.get("pickupTime", ""),
            "status": "Confirmed",
            "createdAt": iso_timestamp(created_at),
            "completedAt": None,
        }
        return jsonify(response_order), 201
    except ApiError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    except RuntimeError as exc:
        app.logger.error("MariaDB configuration error: %s", exc)
        return jsonify({"error": "MariaDB is not configured: " + str(exc)}), 503
    except Exception:
        app.logger.exception("Could not create order")
        return jsonify({"error": "Order could not be saved. Check that MariaDB is running, the connection settings are correct, and schema.sql has been applied."}), 503


@app.put("/api/employee/orders/<int:order_id>")
def edit_order(order_id):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Send order details as JSON."}), 400

    connection = None
    try:
        customer_name = required_text(body.get("customerName"), "Customer name", 80)
        customer_phone = required_text(body.get("customerPhone"), "Customer phone", 30)
        channel = body.get("channel")
        if not isinstance(channel, str) or channel not in ALLOWED_CHANNELS:
            raise ApiError("Choose a valid order channel.")
        pickup_value = body.get("pickupTime")
        notes = body.get("notes", "")
        if not isinstance(notes, str) or len(notes) > 4000:
            raise ApiError("Order notes must be text no longer than 4000 characters.")
        items, subtotal, tax_amount, total = prepare_items(body.get("items"))

        connection = database_connection()
        connection.begin()
        cursor = connection.cursor()
        cursor.execute(
            "SELECT status, pickup_time AS pickupTime FROM orders WHERE order_id = %s FOR UPDATE",
            (order_id,),
        )
        order = cursor.fetchone()
        if order is None:
            connection.rollback()
            return jsonify({"error": "Order was not found. Refresh the queue and try again."}), 404
        if order["status"] == "Completed":
            connection.rollback()
            return jsonify({"error": "Completed orders cannot be edited from the employee dashboard."}), 409

        existing_pickup = str(order["pickupTime"])[:5] if order["pickupTime"] else ""
        same_pickup = pickup_value == existing_pickup
        pickup_time = pickup_time_value(pickup_value, allow_past=same_pickup)
        customer_id = save_customer(cursor, customer_name, customer_phone)
        cursor.execute(
            """
            UPDATE orders
               SET customer_id = %s, channel = %s, pickup_time = %s, notes = %s,
                   subtotal = %s, tax_rate_bps = %s, tax_amount = %s, total = %s
             WHERE order_id = %s
            """,
            (customer_id, channel, pickup_time, notes, subtotal, TAX_RATE_BPS, tax_amount, total, order_id),
        )
        cursor.execute("DELETE FROM order_items WHERE order_id = %s", (order_id,))
        insert_order_items(cursor, order_id, items)
        connection.commit()
        return jsonify({
            "id": order_id,
            "customerName": customer_name,
            "status": order["status"],
            "subtotalPrice": float(subtotal),
            "taxPrice": float(tax_amount),
            "totalPrice": float(total),
        })
    except ApiError as exc:
        if connection is not None:
            connection.rollback()
        return jsonify({"error": str(exc)}), exc.status_code
    except RuntimeError as exc:
        if connection is not None:
            connection.rollback()
        app.logger.error("MariaDB configuration error: %s", exc)
        return jsonify({"error": "MariaDB is not configured: " + str(exc)}), 503
    except Exception:
        if connection is not None:
            connection.rollback()
        app.logger.exception("Could not edit order")
        return jsonify({"error": "Order could not be updated. Check that MariaDB is running and the connection settings are correct."}), 503
    finally:
        if connection is not None:
            connection.close()


@app.patch("/api/employee/orders/<int:order_id>")
def update_order_status(order_id):
    body = request.get_json(silent=True)
    status = body.get("status") if isinstance(body, dict) else None
    if not isinstance(status, str) or status not in ALLOWED_STATUSES:
        return jsonify({"error": "That order status is not supported."}), 400

    connection = None
    try:
        connection = database_connection()
        connection.begin()
        cursor = connection.cursor()
        cursor.execute("SELECT status FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
        order = cursor.fetchone()
        if order is None:
            connection.rollback()
            return jsonify({"error": "Order was not found. Refresh the queue and try again."}), 404
        if order["status"] == "Completed" and status != "Completed":
            connection.rollback()
            return jsonify({"error": "Completed orders cannot be reopened from the employee dashboard."}), 409
        cursor.execute(
            """
            UPDATE orders
               SET status = %s,
                   completed_at = CASE
                       WHEN %s = 'Completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP(3))
                       ELSE NULL
                   END
             WHERE order_id = %s
            """,
            (status, status, order_id),
        )
        connection.commit()
        return jsonify({"id": order_id, "status": status})
    except Exception:
        if connection is not None:
            connection.rollback()
        app.logger.exception("Could not update order status")
        return jsonify({"error": "Order status could not be updated. Check that MariaDB is running and the connection settings are correct."}), 503
    finally:
        if connection is not None:
            connection.close()


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request is too large."}), 413


if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
    )
