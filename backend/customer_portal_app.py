import json
"""Flask API and same-origin host for Luigi's employee order dashboard."""
from datetime import datetime, timedelta, time as datetime_time
import calendar

from decimal import Decimal, ROUND_HALF_UP

import logging

import hashlib

import secrets

import re

import os

from functools import wraps

from urllib.parse import urlsplit

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import click

from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for

from werkzeug.security import check_password_hash, generate_password_hash

import pymysql

from pymysql.cursors import DictCursor

app = Flask(
    __name__,
    template_folder="../templates",
    static_folder="../static",
    static_url_path="/static",
)

app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024

app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)

app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=8)

app.config["SESSION_COOKIE_HTTPONLY"] = True

app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

app.config["SESSION_COOKIE_SECURE"] = os.environ.get(
    "SESSION_COOKIE_SECURE", "true" if os.environ.get("FLASK_ENV") == "production" else "false"
).lower() in {"1", "true", "yes", "on"}

PASSWORD_MIN_LENGTH = 12

DUMMY_PASSWORD_HASH = generate_password_hash(secrets.token_urlsafe(24))

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

TAX_RATE_BPS = 975

TAX_RATE = Decimal(TAX_RATE_BPS) / Decimal(10000)

CENT = Decimal("0.01")

PUBLIC_ORDER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

MAX_CUSTOMER_ORDER_ITEMS = 20

MAX_EMPLOYEE_ORDER_ITEMS = 50

ALLOWED_STATUSES = {"Confirmed", "In-Progress", "Ready", "Overdue", "Completed"}

ALLOWED_CHANNELS = {"In-store", "Phone pickup"}

DRINKS = {"Iced tea", "Dr. Pepper", "Cola", "Un-cola"}

DRINK_PRICES = {

    "Small": Decimal("1.00"),

    "Medium": Decimal("2.00"),

    "Large": Decimal("3.00"),

}

PIZZA_PRICES = {

    "Small": {"inches": 12, "base": Decimal("5.00"), "topping": Decimal("1.00"), "portion": "Â¼ cup"},

    "Medium": {"inches": 14, "base": Decimal("7.00"), "topping": Decimal("2.00"), "portion": "Â½ cup"},

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

        init_command="SET time_zone = '+00:00'",

        write_timeout=15,

    )

def ensure_csrf_token():
    token = session.get("csrf_token")
    if not isinstance(token, str) or len(token) < 32:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token

def valid_csrf_request():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    return isinstance(expected, str) and bool(supplied) and secrets.compare_digest(expected, supplied)

def current_staff_user():
    if getattr(g, "staff_user_loaded", False):
        return g.staff_user
    g.staff_user_loaded = True
    g.staff_user = None
    staff_id = session.get("staff_id")
    auth_version = session.get("staff_auth_version")
    if not isinstance(staff_id, int) or not isinstance(auth_version, int):
        return None
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT staff_id, email, full_name, staff_role, is_active,
                   must_change_password, auth_version
              FROM staff_users
             WHERE staff_id = %s
            """,
            (staff_id,),
        )
        staff = cursor.fetchone()
        if (
            staff is None
            or not bool(staff["is_active"])
            or int(staff["auth_version"]) != auth_version
        ):
            session.clear()
            return None
        g.staff_user = staff
        return staff
    finally:
        connection.close()

def api_authentication_required():
    return jsonify({"error": "Sign in is required.", "code": "authentication_required"}), 401

def staff_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        try:
            staff = current_staff_user()
        except Exception:
            app.logger.exception("Could not load the staff session")
            return jsonify({"error": "Staff authentication is temporarily unavailable."}), 503
        if staff is None:
            return api_authentication_required()
        if staff["must_change_password"] and request.endpoint not in {
            "staff_session",
            "staff_logout",
            "staff_change_password",
        }:
            return jsonify({"error": "Change your temporary password before continuing.", "code": "password_change_required"}), 403
        g.staff_user = staff
        return view(*args, **kwargs)
    return wrapped

def roles_required(*allowed_roles):
    def decorate(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            staff = getattr(g, "staff_user", None)
            if staff is None:
                return api_authentication_required()
            if staff["staff_role"] not in allowed_roles:
                return jsonify({"error": "Your staff role does not allow this action.", "code": "forbidden"}), 403
            return view(*args, **kwargs)
        return wrapped
    return decorate

def csrf_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not valid_csrf_request():
            return jsonify({"error": "The request security token is missing or expired.", "code": "csrf_failed"}), 400
        return view(*args, **kwargs)
    return wrapped

def safe_dashboard_path(candidate):
    if candidate in {"/employee", "/employee-dashboard.html"}:
        return candidate + "?focus=dashboard"
    parsed = urlsplit(candidate or "")
    if parsed.scheme or parsed.netloc or parsed.path not in {"/employee", "/employee-dashboard.html"}:
        return "/employee-dashboard.html?focus=dashboard"
    return parsed.path + "?focus=dashboard"

def valid_staff_email(value):
    return isinstance(value, str) and len(value) <= 254 and bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value))

def public_staff_account(row):
    legacy_parts = (row.get("full_name") or "").strip().split(None, 1)
    return {
        "id": int(row["staff_id"]),
        "email": row["email"],
        "fullName": row["full_name"],
        "firstName": row.get("first_name") or (legacy_parts[0] if legacy_parts else ""),
        "lastName": row.get("last_name") or (legacy_parts[1] if len(legacy_parts) > 1 else ""),
        "role": row["staff_role"],
        "isActive": bool(row["is_active"]),
        "mustChangePassword": bool(row["must_change_password"]),
        "createdAt": iso_timestamp(row["created_at"]) if row.get("created_at") else None,
    }

def required_text(value, label, max_length):

    if not isinstance(value, str):

        raise ApiError(label + " is required.")

    value = value.strip()

    if not value:

        raise ApiError(label + " is required.")

    if len(value) > max_length:

        raise ApiError(label + " is too long.")

    if any(ord(character) < 32 for character in value):
        raise ApiError(label + ' contains invalid control characters.')
    return value

def validate_demo_payment(body):
    # Expiry metadata is validated and discarded. PAN and CVV never belong here.
    if body.get('paymentMethod') != 'Demo card' or body.get('paymentLastFour') != '4242':
        raise ApiError('Complete the demo card details.')
    month, year = body.get('paymentExpiryMonth'), body.get('paymentExpiryYear')
    if (not isinstance(month, str) or not re.fullmatch(r'0[1-9]|1[0-2]', month)
        or not isinstance(year, str) or not re.fullmatch(r'[0-9]{4}', year)):
        raise ApiError('Use a valid expiry month and four-digit year (MM/YYYY).')
    now = datetime.now()
    if (int(year), int(month)) < (now.year, now.month) or int(year) > now.year + 20:
        raise ApiError('Choose an unexpired card date within the next 20 years.')
    return '4242'

def normalize_phone_number(value):
    if not re.fullmatch(r'[0-9+(). \-]+', value):
        raise ApiError('Use only digits and phone-number punctuation.')
    digits = re.sub(r"\D", "", value)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if not re.fullmatch(r"\d{10}", digits):
        raise ApiError("Customer phone must be a valid 10-digit US number.")
    return digits

def get_or_create_customer(cursor, full_name, first_name, last_name, phone):
    # Match legacy rows that may have been saved with punctuation in the phone field.
    cursor.execute("SELECT customer_id, phone FROM customers")
    for customer in cursor.fetchall():
        existing_phone = re.sub(r"\D", "", customer["phone"])
        if len(existing_phone) == 11 and existing_phone.startswith("1"):
            existing_phone = existing_phone[1:]
        if existing_phone == phone:
            cursor.execute(
                "UPDATE customers SET full_name = %s, first_name = %s, last_name = %s WHERE customer_id = %s",
                (full_name, first_name, last_name, customer["customer_id"]),
            )
            return customer["customer_id"]

    cursor.execute(
        """INSERT INTO customers (full_name, first_name, last_name, phone)
           VALUES (%s, %s, %s, %s)
           ON DUPLICATE KEY UPDATE
             full_name = VALUES(full_name),
             first_name = VALUES(first_name),
             last_name = VALUES(last_name),
             customer_id = LAST_INSERT_ID(customer_id)""",
        (full_name, first_name, last_name, phone),
    )
    return cursor.lastrowid

def person_name_parts(body, first_key, last_key, legacy_key, label):
    """Return validated first name, last name, and a compatible display name."""
    if first_key in body or last_key in body:
        first_name = required_text(body.get(first_key), label + " first name", 80)
        last_name = required_text(body.get(last_key), label + " last name", 80)
    else:
        legacy_name = required_text(body.get(legacy_key), label, 200)
        parts = legacy_name.split(None, 1)
        first_name = parts[0]
        last_name = parts[1] if len(parts) > 1 else ""
    if not all(re.fullmatch(r"[A-Za-z ]+", part) for part in (first_name, last_name)):
        raise ApiError(label + " names must use letters and spaces.")
    full_name = " ".join(part for part in (first_name, last_name) if part)
    if len(full_name) > 200:
        raise ApiError(label + " is too long.")
    return first_name, last_name, full_name

def parse_quantity(value, maximum):

    if isinstance(value, bool):

        raise ApiError("Item quantity must be a whole number.")

    try:

        quantity = int(value)

        if isinstance(value, float) and not value.is_integer():

            raise ValueError()

    except (TypeError, ValueError):

        raise ApiError("Item quantity must be a whole number.")

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

def prepare_items(raw_items, maximum):

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

        quantity = parse_quantity(raw.get("quantity"), maximum)

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

                "{}Ã— {}".format(topping["quantity"], topping["name"])

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

    if sum(item["quantity"] for item in items) > maximum:

        raise ApiError("An order can contain no more than {} total items.".format(maximum))

    subtotal = sum((item["unitPrice"] * item["quantity"] for item in items), Decimal("0.00"))

    subtotal = subtotal.quantize(CENT, rounding=ROUND_HALF_UP)

    tax_amount = (subtotal * TAX_RATE).quantize(CENT, rounding=ROUND_HALF_UP)

    return items, subtotal, tax_amount, subtotal + tax_amount

def pickup_schedule_values(date_value, time_value, minimum_buffer_minutes=20):
    timezone_name = os.environ.get("BUSINESS_TIMEZONE")

    try:

        now = datetime.now(ZoneInfo(timezone_name)) if timezone_name else datetime.now().astimezone()

    except ZoneInfoNotFoundError as exc:

        raise ApiError("BUSINESS_TIMEZONE must be a valid IANA timezone name.", 503) from exc

    date_was_omitted = date_value in (None, "")
    if date_was_omitted:
        pickup_date = now.date()
    elif not isinstance(date_value, str):
        raise ApiError("Pickup date must use YYYY-MM-DD format.")
    else:
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
                raise ValueError()
            pickup_date = datetime.strptime(date_value, "%Y-%m-%d").date()
        except ValueError as exc:
            raise ApiError("Pickup date must use YYYY-MM-DD format.") from exc

    if pickup_date < now.date():
        raise ApiError("Pickup date cannot be in the past.")

    month_index = now.year * 12 + (now.month - 1) + 2
    latest_year, latest_month_index = divmod(month_index, 12)
    latest_month = latest_month_index + 1
    latest_day = min(now.day, calendar.monthrange(latest_year, latest_month)[1])
    latest_date = now.date().replace(year=latest_year, month=latest_month, day=latest_day)
    if pickup_date > latest_date:
        raise ApiError("Pickup date cannot be more than two months in advance.")

    opening_time = datetime_time(10, 0)
    closing_time = datetime_time(22, 40)

    if time_value in (None, ""):
        if pickup_date > now.date():
            return pickup_date, opening_time
        scheduled = max(now + timedelta(minutes=minimum_buffer_minutes), datetime.combine(pickup_date, opening_time, tzinfo=now.tzinfo))
        if scheduled.second or scheduled.microsecond:
            scheduled = scheduled.replace(second=0, microsecond=0) + timedelta(minutes=1)
        if scheduled.date() != pickup_date or scheduled.time().replace(tzinfo=None) > closing_time:
            if date_was_omitted:
                return pickup_date + timedelta(days=1), opening_time
            raise ApiError("No pickup times remain today. Choose a future date.")
        return pickup_date, scheduled.time().replace(tzinfo=None)
    if not isinstance(time_value, str):
        raise ApiError("Pickup time must use HH:MM format.")
    try:
        try:
            pickup_time = datetime.strptime(time_value, "%H:%M:%S").time()
        except ValueError:
            pickup_time = datetime.strptime(time_value, "%H:%M").time()
    except ValueError as exc:
        raise ApiError("Pickup time must use HH:MM or HH:MM:SS format.") from exc

    scheduled = datetime.combine(pickup_date, pickup_time, tzinfo=now.tzinfo)
    if pickup_time < opening_time or pickup_time > closing_time:
        raise ApiError("Pickup time must be between 10:00 a.m. and 10:40 p.m.")
    minimum = now + timedelta(minutes=minimum_buffer_minutes)
    if pickup_date == now.date() and scheduled < minimum:
        if minimum_buffer_minutes:
            raise ApiError("For pickup today, choose a time at least 20 minutes from now.")
        raise ApiError("Pickup time must be later than the current time.")

    return pickup_date, pickup_time

def iso_timestamp(value):

    return value.isoformat(sep=" ", timespec="milliseconds") if value else None

def generate_public_order_code():
    """Return a human-readable, unpredictable customer-facing order code."""
    random_part = "".join(secrets.choice(PUBLIC_ORDER_CODE_ALPHABET) for _ in range(16))
    return "PZ-{}-{}-{}-{}".format(
        random_part[:4], random_part[4:8], random_part[8:12], random_part[12:]
    )

def serialize_order_row(row):

    pickup_time = row.get("pickupTime")

    return {

        "id": int(row["id"]),

        "publicOrderCode": row.get("publicOrderCode", ""),

        "source": row["source"],

        "channel": row["channel"],

        "customerName": row["customerName"],

        "customerFirstName": row.get("customerFirstName", ""),

        "customerLastName": row.get("customerLastName", ""),

        "customerPhone": row["customerPhone"],

        "items": [],

        "subtotalPrice": float(row["subtotal"]),

        "taxRate": int(row["taxRateBasisPoints"]) / 10000,

        "taxRateBasisPoints": int(row["taxRateBasisPoints"]),

        "taxPrice": float(row["taxAmount"]),

        "totalPrice": float(row["total"]),

        "notes": row["notes"],

        "pickupTime": str(pickup_time)[:5] if pickup_time else "",

        "pickupDate": row.get("pickupDate").isoformat() if row.get("pickupDate") else "",

        "status": row["status"],

        "createdAt": iso_timestamp(row["createdAt"]),

        "completedAt": iso_timestamp(row["completedAt"]),

        "paymentMethod": row.get("paymentMethod", "Pay at pickup"),

        "paymentLastFour": row.get("paymentLastFour"),

        "customerEmail": row.get("customerEmail", ""),

    }

def load_orders(completed, order_id=None, tracking_hash=None, customer_id=None, limit=None, offset=0, search=None, public_order_code=None, account_email=None):

    connection = database_connection()

    try:

        cursor = connection.cursor()

        where_clause = "1 = 1" if completed is None else ("o.status = 'Completed'" if completed else "o.status <> 'Completed'")

        parameters = []

        if order_id is not None:

            where_clause += " AND o.order_id = %s AND o.tracking_token_hash = %s"

            parameters.extend((order_id, tracking_hash))

        if public_order_code is not None:

            where_clause += " AND o.public_order_code = %s"

            parameters.append(public_order_code)

            if tracking_hash is not None:

                where_clause += " AND o.tracking_token_hash = %s"

                parameters.append(tracking_hash)

        if account_email is not None:

            where_clause += " AND EXISTS (SELECT 1 FROM customer_order_receipts AS account_receipt WHERE account_receipt.order_id = o.order_id AND account_receipt.account_email = %s)"

            parameters.append(account_email)

        if customer_id is not None:

            where_clause += " AND o.customer_id = %s"

            parameters.append(customer_id)

        if search:
            pattern = "%" + search + "%"
            digits = re.sub(r"\D", "", search)
            where_clause += " AND (c.full_name LIKE %s OR CAST(o.order_id AS CHAR) LIKE %s OR o.public_order_code LIKE %s OR c.phone LIKE %s"
            parameters.extend((pattern, pattern, pattern, pattern))
            if digits:
                where_clause += " OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', ''), '+', '') LIKE %s"
                parameters.append("%" + digits + "%")
            where_clause += ")"

        total = None
        if limit is not None:
            cursor.execute(
                "SELECT COUNT(*) AS total FROM orders AS o JOIN customers AS c ON c.customer_id = o.customer_id WHERE " + where_clause,
                tuple(parameters),
            )
            total = int(cursor.fetchone()["total"])

        order_query = (
            "SELECT o.order_id AS id, o.public_order_code AS publicOrderCode, o.source, o.channel, o.status, o.notes, "
            "o.subtotal, o.tax_rate_bps AS taxRateBasisPoints, o.tax_amount AS taxAmount, o.total, "
            "o.pickup_date AS pickupDate, o.pickup_time AS pickupTime, o.created_at AS createdAt, o.completed_at AS completedAt, "
            "o.customer_email AS customerEmail, o.payment_method AS paymentMethod, o.payment_last_four AS paymentLastFour, "
            "c.full_name AS customerName, c.first_name AS customerFirstName, c.last_name AS customerLastName, c.phone AS customerPhone "
            "FROM orders AS o JOIN customers AS c ON c.customer_id = o.customer_id WHERE " + where_clause +
            " ORDER BY " + ("o.completed_at" if completed else "o.created_at") + " DESC, o.order_id DESC"
        )
        order_parameters = list(parameters)
        if limit is not None:
            order_query += " LIMIT %s OFFSET %s"
            order_parameters.extend((limit, offset))

        cursor.execute(order_query, tuple(order_parameters))

        order_rows = cursor.fetchall()

        orders = {int(row["id"]): serialize_order_row(row) for row in order_rows}

        if not orders:
            return ([], total) if limit is not None else []

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

        result = list(orders.values())
        return (result, total) if limit is not None else result

    finally:

        connection.close()

@app.cli.command("create-owner")
def create_owner_command():
    """Create the initial owner account once, using an interactive prompt."""
    email = click.prompt("Owner email").strip().lower()
    first_name = click.prompt("Owner first name").strip()
    last_name = click.prompt("Owner last name").strip()
    full_name = " ".join(part for part in (first_name, last_name) if part)
    password = click.prompt("Owner password", hide_input=True, confirmation_prompt=True)
    if not valid_staff_email(email):
        raise click.ClickException("Enter a valid email address.")
    if not first_name or len(first_name) > 80 or not last_name or len(last_name) > 80:
        raise click.ClickException("Owner first and last names must each be between 1 and 80 characters.")
    if len(password) < PASSWORD_MIN_LENGTH or len(password) > 128:
        raise click.ClickException("Password must be between 12 and 128 characters.")
    if not password.strip():
        raise click.ClickException("Password cannot contain only spaces.")

    connection = database_connection()
    try:
        connection.begin()
        cursor = connection.cursor()
        cursor.execute("SELECT staff_id FROM staff_users WHERE staff_role = 'owner' LIMIT 1 FOR UPDATE")
        if cursor.fetchone():
            connection.rollback()
            raise click.ClickException("An owner account already exists. Use the application to manage staff accounts.")
        cursor.execute(
            """
            INSERT INTO staff_users
                (email, full_name, first_name, last_name, password_hash, staff_role, is_active, must_change_password)
            VALUES (%s, %s, %s, %s, %s, 'owner', 1, 0)
            """,
            (email, full_name, first_name, last_name, generate_password_hash(password)),
        )
        connection.commit()
        click.echo("Initial owner account created.")
    except click.ClickException:
        raise
    except pymysql.err.IntegrityError:
        connection.rollback()
        raise click.ClickException("That email address is already in use.")
    finally:
        connection.close()

@app.post("/api/staff/login")
def staff_login():
    if not valid_csrf_request():
        return jsonify({"error": "Refresh the sign-in page and try again.", "code": "csrf_failed"}), 400
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Send sign-in details as JSON."}), 400
    email = body.get("email")
    password = body.get("password")
    email = email.strip().lower() if isinstance(email, str) else ""
    password = password if isinstance(password, str) else ""
    connection = None
    try:
        connection = database_connection()
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT staff_id, email, full_name, password_hash, staff_role,
                   is_active, must_change_password, auth_version
              FROM staff_users
             WHERE email = %s
             LIMIT 1
            """,
            (email,),
        )
        staff = cursor.fetchone()
        password_hash = staff["password_hash"] if staff else DUMMY_PASSWORD_HASH
        password_matches = check_password_hash(password_hash, password)
        if staff is None or not staff["is_active"] or not password_matches:
            return jsonify({"error": "Email or password is incorrect."}), 401

        session.clear()
        session.permanent = True
        session["staff_id"] = int(staff["staff_id"])
        session["staff_auth_version"] = int(staff["auth_version"])
        session["csrf_token"] = secrets.token_urlsafe(32)
        destination = (
            "/staff-change-password.html?focus=password"
            if staff["must_change_password"]
            else safe_dashboard_path(request.args.get("next"))
        )
        return jsonify({"redirect": destination})
    except Exception:
        app.logger.exception("Staff sign-in failed because the database was unavailable")
        return jsonify({"error": "Staff sign-in is temporarily unavailable. Please try again."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.get("/api/staff/session")
@staff_required
def staff_session():
    return jsonify({
        "staff": public_staff_account(g.staff_user),
        "csrfToken": ensure_csrf_token(),
    })

@app.post("/api/staff/logout")
@staff_required
@csrf_required
def staff_logout():
    session.clear()
    return jsonify({"redirect": "/staff-signin.html?focus=signin"})

@app.post("/api/staff/change-password")
@staff_required
@csrf_required
def staff_change_password():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Send password details as JSON."}), 400
    current_password = body.get("currentPassword")
    new_password = body.get("newPassword")
    confirm_password = body.get("confirmPassword")
    if not all(isinstance(value, str) for value in (current_password, new_password, confirm_password)):
        return jsonify({"error": "Complete all password fields."}), 400
    if len(new_password) < PASSWORD_MIN_LENGTH or len(new_password) > 128:
        return jsonify({"error": "New password must be between 12 and 128 characters."}), 400
    if new_password != confirm_password:
        return jsonify({"error": "The new password entries do not match."}), 400

    connection = None
    try:
        connection = database_connection()
        connection.begin()
        cursor = connection.cursor()
        cursor.execute(
            "SELECT password_hash FROM staff_users WHERE staff_id = %s AND is_active = 1 FOR UPDATE",
            (g.staff_user["staff_id"],),
        )
        row = cursor.fetchone()
        if row is None or not check_password_hash(row["password_hash"], current_password):
            connection.rollback()
            return jsonify({"error": "Current password is incorrect."}), 400
        if check_password_hash(row["password_hash"], new_password):
            connection.rollback()
            return jsonify({"error": "Choose a new password different from the temporary password."}), 400
        cursor.execute(
            """
            UPDATE staff_users
               SET password_hash = %s,
                   must_change_password = 0,
                   auth_version = auth_version + 1
             WHERE staff_id = %s
            """,
            (generate_password_hash(new_password), g.staff_user["staff_id"]),
        )
        cursor.execute("SELECT auth_version FROM staff_users WHERE staff_id = %s", (g.staff_user["staff_id"],))
        auth_version = int(cursor.fetchone()["auth_version"])
        connection.commit()
        session["staff_auth_version"] = auth_version
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify({"redirect": "/employee-dashboard.html?focus=dashboard"})
    except Exception:
        if connection is not None:
            connection.rollback()
        app.logger.exception("Could not change staff password")
        return jsonify({"error": "Password could not be changed. Please try again."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.get("/api/staff/accounts")
@staff_required
@roles_required("manager", "owner")
def list_staff_accounts():
    connection = None
    try:
        connection = database_connection()
        cursor = connection.cursor()
        if g.staff_user["staff_role"] == "manager":
            cursor.execute(
                """
                SELECT staff_id, email, full_name, first_name, last_name, staff_role, is_active,
                       must_change_password, created_at
                  FROM staff_users
                 WHERE staff_role = 'employee'
                 ORDER BY full_name, email
                """
            )
        else:
            cursor.execute(
                """
                SELECT staff_id, email, full_name, first_name, last_name, staff_role, is_active,
                       must_change_password, created_at
                  FROM staff_users
                 ORDER BY FIELD(staff_role, 'owner', 'manager', 'employee'), full_name, email
                """
            )
        return jsonify({"accounts": [public_staff_account(row) for row in cursor.fetchall()]})
    except Exception:
        app.logger.exception("Could not list staff accounts")
        return jsonify({"error": "Staff accounts could not be loaded."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.get("/api/staff/sales-summary")
@staff_required
@roles_required("manager", "owner")
def get_sales_summary():
    connection = None
    try:
        timezone_name = os.environ.get("BUSINESS_TIMEZONE", "UTC")
        try:
            business_timezone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise RuntimeError("BUSINESS_TIMEZONE must be a valid IANA timezone name.") from exc

        now_local = datetime.now(business_timezone)
        today_start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        week_start_local = today_start_local - timedelta(days=today_start_local.weekday())
        utc_timezone = ZoneInfo("UTC")
        now_utc = now_local.astimezone(utc_timezone).replace(tzinfo=None)
        today_start_utc = today_start_local.astimezone(utc_timezone).replace(tzinfo=None)
        week_start_utc = week_start_local.astimezone(utc_timezone).replace(tzinfo=None)

        connection = database_connection()
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT
                COUNT(CASE WHEN created_at >= %s AND created_at < %s THEN 1 END) AS today_orders,
                COALESCE(SUM(CASE WHEN created_at >= %s AND created_at < %s THEN total ELSE 0 END), 0) AS today_sales,
                COUNT(CASE WHEN created_at >= %s AND created_at < %s THEN 1 END) AS week_orders,
                COALESCE(SUM(CASE WHEN created_at >= %s AND created_at < %s THEN total ELSE 0 END), 0) AS week_sales
              FROM orders
             WHERE created_at >= %s AND created_at < %s
            """,
            (
                today_start_utc, now_utc,
                today_start_utc, now_utc,
                week_start_utc, now_utc,
                week_start_utc, now_utc,
                week_start_utc, now_utc,
            ),
        )
        row = cursor.fetchone()

        def period_summary(order_count, sales_total):
            order_count = int(order_count or 0)
            sales_total = Decimal(sales_total or 0).quantize(CENT)
            average_order = (
                (sales_total / order_count).quantize(CENT, rounding=ROUND_HALF_UP)
                if order_count else Decimal("0.00")
            )
            return {
                "orders": order_count,
                "sales": float(sales_total),
                "averageOrder": float(average_order),
            }

        return jsonify({
            "timezone": timezone_name,
            "generatedAt": now_local.isoformat(timespec="seconds"),
            "today": period_summary(row["today_orders"], row["today_sales"]),
            "week": period_summary(row["week_orders"], row["week_sales"]),
        })
    except RuntimeError as exc:
        app.logger.error("Sales summary configuration error: %s", exc)
        return jsonify({"error": str(exc)}), 503
    except Exception:
        app.logger.exception("Could not load manager sales summary")
        return jsonify({"error": "Sales totals could not be loaded. Check MariaDB and the application logs."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.post("/api/staff/accounts")
@staff_required
@roles_required("manager", "owner")
@csrf_required
def create_staff_account():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Send employee details as JSON."}), 400
    try:
        first_name, last_name, full_name = person_name_parts(
            body, "firstName", "lastName", "fullName", "Employee"
        )
    except ApiError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    email = body.get("email")
    email = email.strip().lower() if isinstance(email, str) else ""
    if not valid_staff_email(email):
        return jsonify({"error": "Enter a valid work email address."}), 400
    role = body.get("role", "employee")
    if not isinstance(role, str) or role not in {"employee", "manager"}:
        return jsonify({"error": "Choose an employee or manager role."}), 400
    if role == "manager" and g.staff_user["staff_role"] != "owner":
        return jsonify({"error": "Only the owner can create manager accounts."}), 403
    temporary_password = body.get("temporaryPassword")
    if not isinstance(temporary_password, str) or len(temporary_password) < PASSWORD_MIN_LENGTH or len(temporary_password) > 128:
        return jsonify({"error": "Temporary password must be between 12 and 128 characters."}), 400
    if not temporary_password.strip():
        return jsonify({"error": "Temporary password cannot contain only spaces."}), 400

    connection = None
    try:
        connection = database_connection()
        cursor = connection.cursor()
        cursor.execute(
            """
            INSERT INTO staff_users
                (email, full_name, first_name, last_name, password_hash, staff_role, is_active,
                 must_change_password, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, 1, 1, %s)
            """,
            (
                email,
                full_name,
                first_name,
                last_name,
                generate_password_hash(temporary_password),
                role,
                g.staff_user["staff_id"],
            ),
        )
        new_staff_id = cursor.lastrowid
        cursor.execute(
            """
            SELECT staff_id, email, full_name, first_name, last_name, staff_role, is_active,
                   must_change_password, created_at
              FROM staff_users WHERE staff_id = %s
            """,
            (new_staff_id,),
        )
        created_account = cursor.fetchone()
        connection.commit()
        return jsonify({"account": public_staff_account(created_account)}), 201
    except pymysql.err.IntegrityError:
        if connection is not None:
            connection.rollback()
        return jsonify({"error": "An account already uses that email address."}), 409
    except Exception:
        if connection is not None:
            connection.rollback()
        app.logger.exception("Could not create staff account")
        return jsonify({"error": "Staff account could not be created."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.get("/api/staff/customers")
@staff_required
@roles_required("manager", "owner")
def list_customers():
    query = request.args.get("q", "").strip()
    if len(query) > 100:
        return jsonify({"error": "Customer search must be 100 characters or fewer."}), 400
    connection = None
    try:
        connection = database_connection()
        cursor = connection.cursor()
        where_clause = ""
        parameters = []
        if query:
            pattern = "%" + query + "%"
            phone_digits = re.sub(r"\D", "", query)
            where_clause = """
             WHERE a.first_name LIKE %s OR a.last_name LIKE %s
                OR a.full_name LIKE %s OR a.phone LIKE %s OR LOWER(a.email) LIKE %s
            """
            parameters.extend([pattern] * 4 + [pattern.lower()])
            if phone_digits:
                if len(phone_digits) == 11 and phone_digits.startswith("1"):
                    phone_digits = phone_digits[1:]
                where_clause += " OR a.phone LIKE %s"
                parameters.append("%" + phone_digits + "%")
        cursor.execute(
            """
            SELECT a.email AS id, a.email AS email, a.first_name AS firstName,
                   a.last_name AS lastName, a.full_name AS fullName, a.phone AS phone
              FROM customer_accounts AS a
            """ + where_clause + " ORDER BY a.last_name, a.first_name, a.email",
            tuple(parameters),
        )
        customers = []
        for row in cursor.fetchall():
            customers.append({
                "id": row["id"],
                "firstName": row["firstName"],
                "lastName": row["lastName"],
                "fullName": row["fullName"],
                "phone": row["phone"],
                "email": row["email"],
            })
        return jsonify({"customers": customers})
    except Exception:
        app.logger.exception("Could not load customer directory")
        return jsonify({"error": "Customer list could not be loaded."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.get("/api/staff/customer-account-orders")
@staff_required
@roles_required("manager", "owner")
def get_customer_order_history():
    account_email = request.args.get("email", "").strip().lower()
    if len(account_email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", account_email):
        return jsonify({"error": "Choose a valid registered customer account."}), 400
    connection = None
    try:
        connection = database_connection()
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT a.email AS id, a.email AS email, a.first_name AS firstName,
                   a.last_name AS lastName, a.full_name AS fullName, a.phone AS phone
              FROM customer_accounts AS a
             WHERE a.email = %s
            """,
            (account_email,),
        )
        row = cursor.fetchone()
        if row is None:
            return jsonify({"error": "Registered customer account not found."}), 404
        customer = {
            "id": row["id"],
            "firstName": row["firstName"],
            "lastName": row["lastName"],
            "fullName": row["fullName"],
            "phone": row["phone"],
            "email": row["email"],
        }
        connection.close()
        connection = None
        orders = load_orders(None, account_email=account_email)
        return jsonify({"customer": customer, "orders": orders})
    except Exception:
        app.logger.exception("Could not load customer order history")
        return jsonify({"error": "Customer order history could not be loaded."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.patch("/api/staff/accounts/<int:staff_id>")
@staff_required
@roles_required("manager", "owner")
@csrf_required
def update_staff_account(staff_id):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Send staff account updates as JSON."}), 400
    if staff_id == int(g.staff_user["staff_id"]):
        return jsonify({"error": "You cannot change your own account from this screen."}), 400
    connection = None
    try:
        connection = database_connection()
        connection.begin()
        cursor = connection.cursor()
        cursor.execute(
            "SELECT staff_id, staff_role, is_active FROM staff_users WHERE staff_id = %s FOR UPDATE",
            (staff_id,),
        )
        target = cursor.fetchone()
        if target is None:
            connection.rollback()
            return jsonify({"error": "Staff account not found."}), 404
        if target["staff_role"] == "owner":
            connection.rollback()
            return jsonify({"error": "Owner accounts cannot be changed from this screen."}), 403
        if g.staff_user["staff_role"] == "manager" and target["staff_role"] != "employee":
            connection.rollback()
            return jsonify({"error": "Managers can only manage employee accounts."}), 403
        if "isActive" in body:
            if not isinstance(body["isActive"], bool):
                connection.rollback()
                return jsonify({"error": "Choose whether this account should be active."}), 400
            if bool(target["is_active"]) != body["isActive"]:
                cursor.execute(
                    "UPDATE staff_users SET is_active = %s, auth_version = auth_version + 1 WHERE staff_id = %s",
                    (int(body["isActive"]), staff_id),
                )
            connection.commit()
            return jsonify({"success": True, "isActive": body["isActive"]})

        try:
            first_name, last_name, full_name = person_name_parts(
                body, "firstName", "lastName", "fullName", "Staff"
            )
        except ApiError as exc:
            connection.rollback()
            return jsonify({"error": str(exc)}), exc.status_code
        email = body.get("email")
        email = email.strip().lower() if isinstance(email, str) else ""
        if not valid_staff_email(email):
            connection.rollback()
            return jsonify({"error": "Enter a valid work email address."}), 400
        role = body.get("role", target["staff_role"])
        if not isinstance(role, str) or role not in {"employee", "manager"}:
            connection.rollback()
            return jsonify({"error": "Choose an employee or manager role."}), 400
        if role == "manager" and g.staff_user["staff_role"] != "owner":
            connection.rollback()
            return jsonify({"error": "Only the owner can assign manager roles."}), 403
        auth_version_increment = int(target["staff_role"] != role)
        cursor.execute(
            """
            UPDATE staff_users
               SET email = %s,
                   full_name = %s,
                   first_name = %s,
                   last_name = %s,
                   staff_role = %s,
                   auth_version = auth_version + %s
             WHERE staff_id = %s
            """,
            (email, full_name, first_name, last_name, role, auth_version_increment, staff_id),
        )
        cursor.execute(
            """
            SELECT staff_id, email, full_name, first_name, last_name, staff_role, is_active,
                   must_change_password, created_at
              FROM staff_users WHERE staff_id = %s
            """,
            (staff_id,),
        )
        updated_account = cursor.fetchone()
        connection.commit()
        return jsonify({"success": True, "account": public_staff_account(updated_account)})
    except pymysql.err.IntegrityError:
        if connection is not None:
            connection.rollback()
        return jsonify({"error": "An account already uses that email address."}), 409
    except Exception:
        if connection is not None:
            connection.rollback()
        app.logger.exception("Could not update staff account")
        return jsonify({"error": "Staff account could not be updated."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.delete("/api/staff/accounts/<int:staff_id>")
@staff_required
@roles_required("manager", "owner")
@csrf_required
def delete_staff_account(staff_id):
    if staff_id == int(g.staff_user["staff_id"]):
        return jsonify({"error": "You cannot delete your own account."}), 400
    connection = None
    try:
        connection = database_connection()
        connection.begin()
        cursor = connection.cursor()
        cursor.execute(
            "SELECT staff_id, staff_role, is_active FROM staff_users WHERE staff_id = %s FOR UPDATE",
            (staff_id,),
        )
        target = cursor.fetchone()
        if target is None:
            connection.rollback()
            return jsonify({"error": "Staff account not found."}), 404
        if target["staff_role"] == "owner":
            connection.rollback()
            return jsonify({"error": "Owner accounts cannot be deleted from this screen."}), 403
        if g.staff_user["staff_role"] == "manager" and target["staff_role"] != "employee":
            connection.rollback()
            return jsonify({"error": "Managers can only manage employee accounts."}), 403
        if bool(target["is_active"]):
            connection.rollback()
            return jsonify({"error": "Deactivate this account before deleting it."}), 409
        cursor.execute("DELETE FROM staff_users WHERE staff_id = %s", (staff_id,))
        connection.commit()
        return jsonify({"success": True, "deletedStaffId": staff_id})
    except Exception:
        if connection is not None:
            connection.rollback()
        app.logger.exception("Could not delete staff account")
        return jsonify({"error": "Staff account could not be deleted."}), 503
    finally:
        if connection is not None:
            connection.close()

@app.get("/")

def landing_page():
    return render_template("landingpage.html")

@app.get("/signup")
@app.get("/signup.html")
def signup_page():
    return render_template("signup.html")

@app.get("/staff-signin")
@app.get("/staff-signin.html")
def staff_signin_page():
    try:
        staff = current_staff_user()
    except Exception:
        app.logger.exception("Could not check the staff session")
        return "Staff sign-in is temporarily unavailable.", 503
    if staff is not None:
        if staff["must_change_password"]:
            return redirect("/staff-change-password.html?focus=password")
        return redirect("/employee-dashboard.html?focus=dashboard")
    return render_template("staff-signin.html", csrf_token=ensure_csrf_token())

@app.get("/employee-dashboard.html")
@app.get("/employee")

def dashboard():
    try:
        staff = current_staff_user()
    except Exception:
        app.logger.exception("Could not check the staff session")
        return "Staff dashboard is temporarily unavailable.", 503
    if staff is None:
        return redirect(url_for("staff_signin_page", next=request.path))
    if staff["must_change_password"]:
        return redirect("/staff-change-password.html?focus=password")
    return render_template(
        "employee-dashboard.html",
        staff=staff,
        csrf_token=ensure_csrf_token(),
    )

@app.get("/staff-change-password")
@app.get("/staff-change-password.html")
def staff_change_password_page():
    try:
        staff = current_staff_user()
    except Exception:
        app.logger.exception("Could not check the staff session")
        return "Staff password update is temporarily unavailable.", 503
    if staff is None:
        return redirect(url_for("staff_signin_page", next="/employee-dashboard.html"))
    return render_template(
        "staff-change-password.html",
        staff=staff,
        csrf_token=ensure_csrf_token(),
    )

@app.get("/customer")

def customer_dashboard():
    return render_template("customer-portal.html")

@app.get("/order-tracker")
@app.get("/order-tracker.html")
def order_tracker_page():
    return render_template("order-tracker.html")

@app.after_request

def private_api_response(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

    if request.path.startswith(("/api/", "/employee", "/staff-signin", "/staff-change-password", "/order-tracker")):

        response.headers["Cache-Control"] = "no-store"

    return response

def guest_checkout():
    key = session.get('checkout_key')
    if not key:
        return {}
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute('SELECT content FROM guest_checkouts WHERE checkout_key = %s', (key,))
        row = cursor.fetchone()
        return json.loads(row['content']) if row else {}
    finally:
        connection.close()

@app.before_request
def validate_customer_payload():
    if not request.path.startswith('/api/customer/') or request.method not in {'POST', 'PUT', 'PATCH', 'DELETE'}:
        return None
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error='Send a JSON object.'), 400
    forbidden = {'cardnumber', 'pan', 'cvv', 'cvc', 'cardexpiry', 'carddetails', 'securitycode'}
    def contains_card_data(value, depth=0):
        if depth > 12:
            return True
        if isinstance(value, dict):
            return any(re.sub(r'[^a-z]', '', key.lower()) in forbidden or contains_card_data(item, depth + 1) for key, item in value.items())
        if isinstance(value, list):
            return any(contains_card_data(item, depth + 1) for item in value)
        return False
    if contains_card_data(body):
        return jsonify(error='Do not send card numbers, security codes, or full card details to this server.'), 400
    return None

@app.get('/api/customer/signup-details')
def signup_details():
    return jsonify(guest_checkout().get('profile', {}))

@app.get('/api/customer/draft')
def get_customer_draft():
    account = current_customer_account()
    if not account:
        return jsonify(items=[])
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute('SELECT content FROM customer_drafts WHERE account_email = %s', (account['email'],))
        row = cursor.fetchone()
        return jsonify(items=json.loads(row['content']) if row else [])
    finally:
        connection.close()

@app.put('/api/customer/draft')
def save_customer_draft():
    if request.headers.get('X-Luigi-Request') != '1':
        return jsonify(error='Use the customer website.'), 403
    account = current_customer_account()
    if not account:
        return jsonify(error='Sign in to save a draft across devices.'), 401
    body = request.get_json(silent=True) or {}
    items = body.get('items')
    if not isinstance(items, list):
        return jsonify(error='Send a list of items.'), 400
    try:
        if items:
            prepared, _, _, _ = prepare_items(items, MAX_CUSTOMER_ORDER_ITEMS)
            items = [{**item, 'unitPrice': float(item['unitPrice']), 'toppingUnitPrice': float(item['toppingUnitPrice']) if item['toppingUnitPrice'] else None} for item in prepared]
    except ApiError as exc:
        return jsonify(error=str(exc)), 400
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute('INSERT INTO customer_drafts (account_email, content) VALUES (%s, %s) ON DUPLICATE KEY UPDATE content = VALUES(content)', (account['email'], json.dumps(items)))
        connection.commit()
        return jsonify(saved=True)
    finally:
        connection.close()

@app.get('/api/customer/receipts')
def customer_receipts():
    account = current_customer_account()
    if not account:
        receipts = guest_checkout().get('receipts', [])
        return jsonify(receipts=[
            {
                'orderCode': receipt.get('orderCode') or ('PZ-LEGACY-' + str(receipt.get('id', ''))),
                'token': receipt.get('token', ''),
            }
            for receipt in receipts
            if receipt.get('orderCode') or re.fullmatch(r"[0-9]{1,20}", str(receipt.get('id', '')))
        ])
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute('''SELECT o.public_order_code AS orderCode, receipt.tracking_token AS token
            FROM customer_order_receipts AS receipt
            JOIN orders AS o ON o.order_id = receipt.order_id
            WHERE receipt.account_email = %s
            ORDER BY receipt.order_id DESC LIMIT 50''', (account['email'],))
        return jsonify(receipts=cursor.fetchall())
    finally:
        connection.close()

# Reuse the existing database-backed account module.
from backend.customer_accounts import install_accounts
current_customer_account = install_accounts(app, database_connection, guest_checkout)

DEFAULT_SPECIALS = [
    {"name": "Luigi's Supreme", "description": "Pepperoni, sausage, peppers and onion.", "size": "Medium", "toppings": [{"name": "Pepperoni", "quantity": 1}, {"name": "Italian sausage", "quantity": 1}, {"name": "Green peppers", "quantity": 1}, {"name": "Onion", "quantity": 1}]},
    {"name": "Garden Special", "description": "Peppers, onion, olives and tomatoes.", "size": "Medium", "toppings": [{"name": "Green peppers", "quantity": 1}, {"name": "Onion", "quantity": 1}, {"name": "Black olives", "quantity": 1}, {"name": "Diced tomatoes", "quantity": 1}]},
]

def normalize_specials(specials):
    """Read legacy saved specials and expose exactly two configurable pizza slots."""
    normalized = []
    for item in (specials or [])[:2]:
        if not isinstance(item, dict):
            continue
        toppings = []
        for topping in item.get("toppings", []) if isinstance(item.get("toppings", []), list) else []:
            if isinstance(topping, str):
                topping = {"name": topping, "quantity": 1}
            if (isinstance(topping, dict) and topping.get("name") in ALLOWED_TOPPINGS
                and type(topping.get("quantity", 1)) is int and 1 <= topping.get("quantity", 1) <= 3):
                toppings.append({"name": topping["name"], "quantity": topping.get("quantity", 1)})
        size = item.get("size", "Medium")
        normalized.append({"name": str(item.get("name", "Pizza special"))[:80],
                           "description": str(item.get("description", ""))[:300],
                           "size": size if size in PIZZA_PRICES else "Medium", "toppings": toppings})
    while len(normalized) < 2:
        normalized.append(dict(DEFAULT_SPECIALS[len(normalized)]))
    return normalized

def load_specials():
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("SELECT content FROM menu_settings WHERE setting_key = 'specials'")
        row = cursor.fetchone()
        return normalize_specials(json.loads(row["content"])) if row else normalize_specials(DEFAULT_SPECIALS)
    finally:
        connection.close()

def rank_favorite_pizzas(items):
    """Count pizzas by size and exact topping servings; use current menu prices."""
    favorites = {}
    for item in items:
        toppings = sorted(item['toppings'], key=lambda topping: topping['name'])
        key = (item['pizzaSize'], tuple((t['name'], t['quantity']) for t in toppings))
        try:
            prepared, _, _, _ = prepare_items([dict(type='Pizza', pizzaSize=item['pizzaSize'], quantity=1, toppings=toppings)], 20)
        except ApiError:
            continue  # Do not offer a recipe that is no longer on the menu.
        if key not in favorites:
            pizza = prepared[0]
            favorites[key] = dict(type='Pizza', name=pizza['name'], pizzaSize=pizza['pizzaSize'],
                                  toppings=toppings, quantity=1, unitPrice=float(pizza['unitPrice']),
                                  orderedCount=0, lastOrdered=0)
        favorites[key]['orderedCount'] += item['quantity']
        favorites[key]['lastOrdered'] = max(favorites[key]['lastOrdered'], item['lastOrdered'])
    return sorted(favorites.values(), key=lambda pizza: (-pizza['lastOrdered'], -pizza['orderedCount'], pizza['name']))[:4]

@app.get('/api/customer/favorites')
def customer_favorites():
    account = current_customer_account()
    if not account:
        return jsonify(favorites=[], signedIn=False)
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("""SELECT oi.order_item_id AS itemId, oi.order_id AS orderId,
                oi.pizza_size AS pizzaSize, oi.quantity,
                t.topping_name AS toppingName, oit.quantity AS toppingQuantity
            FROM order_items AS oi
            LEFT JOIN customer_order_receipts AS receipt ON receipt.order_id = oi.order_id
            LEFT JOIN order_item_toppings AS oit ON oit.order_item_id = oi.order_item_id
            LEFT JOIN toppings AS t ON t.topping_id = oit.topping_id
            WHERE oi.item_type = 'Pizza' AND (receipt.account_email = %s OR oi.order_id IN (
                SELECT o.order_id FROM orders AS o
                JOIN customers AS c ON c.customer_id = o.customer_id
                WHERE c.phone = %s
            ))
            ORDER BY oi.order_id DESC, oi.order_item_id, t.topping_name""", (account['email'], account.get('phone', '')))
        items = {}
        for row in cursor.fetchall():
            item = items.setdefault(row['itemId'], dict(pizzaSize=row['pizzaSize'], quantity=int(row['quantity']),
                                                       lastOrdered=int(row['orderId']), toppings=[]))
            if row['toppingName']:
                item['toppings'].append(dict(name=row['toppingName'], quantity=int(row['toppingQuantity'])))
        return jsonify(favorites=rank_favorite_pizzas(items.values()), signedIn=True)
    finally:
        connection.close()

@app.get('/api/customer/specials')
def customer_specials():
    return jsonify(specials=load_specials())

@app.put('/api/staff/specials')
@staff_required
@roles_required('manager', 'owner')
@csrf_required
def update_specials():
    body = request.get_json(silent=True) or {}
    specials = body.get('specials')
    if not isinstance(specials, list) or len(specials) != 2:
        return jsonify(error='Exactly two specials are required.'), 400
    for item in specials:
        if (not isinstance(item, dict) or not isinstance(item.get('name'), str)
            or not item['name'].strip() or len(item['name']) > 80
            or not isinstance(item.get('description', ''), str) or len(item.get('description', '')) > 300
            or item.get('size') not in PIZZA_PRICES
            or not isinstance(item.get('toppings'), list)
            or any(not isinstance(t, dict) or t.get('name') not in ALLOWED_TOPPINGS
                   or type(t.get('quantity')) is not int or not 1 <= t['quantity'] <= 3 for t in item['toppings'])
            or len({t['name'] for t in item['toppings'] if isinstance(t, dict) and isinstance(t.get('name'), str)}) != len(item['toppings'])):
            return jsonify(error='Check special names, pizza sizes and topping servings (maximum 3 each).'), 400
        try:
            prepare_items([dict(type='Pizza', pizzaSize=item['size'], quantity=1, toppings=item['toppings'])], 20)
        except ApiError as error:
            return jsonify(error=str(error)), 400
        item['name'] = item['name'].strip()
        item['description'] = item.get('description', '').strip()
    connection = database_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("INSERT INTO menu_settings (setting_key, content) VALUES ('specials', %s) ON DUPLICATE KEY UPDATE content = VALUES(content)", (json.dumps(specials),))
        connection.commit()
        return jsonify(specials=specials)
    finally:
        connection.close()

@app.get("/api/customer/menu")

def customer_menu():

    return jsonify({

        "pizzas": {name: {"base": float(price["base"]), "topping": float(price["topping"]), "inches": price["inches"]} for name, price in PIZZA_PRICES.items()},

        "drinks": sorted(DRINKS), "drinkPrices": {name: float(price) for name, price in DRINK_PRICES.items()},

        "toppings": sorted(ALLOWED_TOPPINGS), "taxRate": float(TAX_RATE),

    })

@app.get("/api/customer/orders/<order_code>")

def track_customer_order(order_code):

    # A random receipt token protects authenticated tracking requests.

    token = request.headers.get("X-Order-Token", "")

    if len(token) != 43:

        return jsonify({"error": "Order not found. Open the tracker in the browser used to place your order."}), 404

    order_code = order_code.strip().upper()
    code_pattern = r"PZ-(?:[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}|LEGACY-[0-9]{1,20})"
    if not re.fullmatch(code_pattern, order_code):
        return jsonify({"error": "Order not found. Check your saved receipt."}), 404

    try:

        orders = load_orders(
            None,
            tracking_hash=hashlib.sha256(token.encode()).hexdigest(),
            public_order_code=order_code,
        )

        if not orders:

            return jsonify({"error": "Order not found. Check your saved receipt."}), 404

        return jsonify(orders[0])

    except Exception:

        app.logger.exception("Could not track customer order")

        return jsonify({"error": "We could not check your order. Your last confirmed status is still shown. Please try again."}), 503

@app.post("/api/customer/track")
def track_guest_order():
    """Look up an order by its unpredictable public code, phone, or both."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="Enter an order code or phone number."), 400
    order_code = str(body.get("orderNumber", "")).strip().upper()
    code_pattern = r"PZ-(?:[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}|LEGACY-[0-9]{1,20})"
    phone = re.sub(r"\D", "", str(body.get("phone", "")))
    if phone.startswith("1") and len(phone) == 11:
        phone = phone[1:]
    if not order_code and not phone:
        return jsonify(error="Enter either an order code or phone number."), 400
    if order_code and not re.fullmatch(code_pattern, order_code):
        return jsonify(error="Check the order code format and try again."), 400
    if phone and len(phone) != 10:
        return jsonify(error="Enter a complete 10-digit phone number."), 400
    connection = database_connection()
    try:
        cursor = connection.cursor()
        if order_code:
            cursor.execute("""SELECT o.public_order_code, o.tracking_token_hash, c.phone
            FROM orders AS o JOIN customers AS c ON c.customer_id = o.customer_id
            WHERE o.public_order_code = %s""", (order_code,))
            row = cursor.fetchone()
            if not row:
                return jsonify(error="We could not find that order. Check the code and try again."), 404
            stored_phone = re.sub(r"\D", "", str(row["phone"] or ""))
            if stored_phone.startswith("1") and len(stored_phone) == 11:
                stored_phone = stored_phone[1:]
            # Legacy codes contain the old sequential database ID, so keep phone
            # verification mandatory for those predictable codes.
            is_legacy = order_code.startswith("PZ-LEGACY-")
            if (phone or is_legacy) and stored_phone != phone:
                return jsonify(error="We could not find that order. Check the code and phone number and try again."), 404
            # Public order codes are generated with Python secrets for both POS
            # and customer orders; use the code as the lookup credential.
            orders = load_orders(None, tracking_hash=row["tracking_token_hash"], public_order_code=order_code)
            if not orders:
                return jsonify(error="We could not find that order. Check the code and try again."), 404
            return jsonify(orders[0])

        cursor.execute("""SELECT o.public_order_code, o.tracking_token_hash
            FROM orders AS o JOIN customers AS c ON c.customer_id = o.customer_id
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', ''), '+', '') IN (%s, %s)
            ORDER BY o.created_at DESC LIMIT 20""", (phone, "1" + phone))
        receipt_rows = cursor.fetchall()
        matches = []
        for receipt in receipt_rows:
            order = load_orders(None, tracking_hash=receipt["tracking_token_hash"], public_order_code=receipt["public_order_code"])
            if order:
                matches.append(order[0])
        if not matches:
            return jsonify(error="We could not find an order for that phone number. Check it and try again."), 404
        return jsonify({"orders": matches})
    except Exception:
        app.logger.exception("Could not verify guest order tracking request")
        return jsonify(error="Order tracking is temporarily unavailable. Please try again."), 503
    finally:
        connection.close()

@app.get("/api/employee/orders")
@staff_required

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
@staff_required

def get_order_history():

    try:
        try:
            page = max(0, int(request.args.get("page", "0")))
        except (TypeError, ValueError):
            return jsonify({"error": "Page must be a non-negative integer."}), 400
        if page > 100000:
            return jsonify({"error": "Requested history page is too large."}), 400
        search = request.args.get("q", "").strip()[:100]
        page_size = 20
        orders, total = load_orders(
            completed=True,
            limit=page_size + 1,
            offset=page * page_size,
            search=search or None,
        )
        has_more = len(orders) > page_size
        return jsonify({
            "orders": orders[:page_size],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "hasMore": has_more,
        })

    except RuntimeError as exc:

        app.logger.error("MariaDB configuration error: %s", exc)

        return jsonify({"error": "MariaDB is not configured: " + str(exc)}), 503

    except Exception:

        app.logger.exception("Could not fetch order history")

        return jsonify({"error": "MariaDB is unavailable or the schema is missing. Check the server log and database settings."}), 503

@app.post("/api/employee/orders")

@app.post("/api/customer/orders")

def create_order():

    body = request.get_json(silent=True)

    if not isinstance(body, dict):

        return jsonify({"error": "Send order details as JSON."}), 400

    try:

        is_customer = request.path == "/api/customer/orders"
        maximum_order_items = MAX_CUSTOMER_ORDER_ITEMS if is_customer else MAX_EMPLOYEE_ORDER_ITEMS
        items, subtotal, tax_amount, total = prepare_items(body.get("items"), maximum_order_items)
        if is_customer and not any(item["type"] == "Pizza" for item in items):
            raise ApiError("Add at least one pizza before continuing to payment.")

        if not is_customer:
            try:

                staff = current_staff_user()

            except Exception:

                app.logger.exception("Could not verify the employee session for order creation")

                return jsonify({"error": "Staff authentication is temporarily unavailable."}), 503

            if staff is None:

                return api_authentication_required()

            if staff["must_change_password"]:

                return jsonify({"error": "Change your temporary password before continuing.", "code": "password_change_required"}), 403

            if not valid_csrf_request():

                return jsonify({"error": "The request security token is missing or expired.", "code": "csrf_failed"}), 400

        if is_customer:
            account = current_customer_account()
            if account:
                body.update(customerFirstName=account["firstName"], customerLastName=account["lastName"],
                            customerPhone=account["phone"], customerEmail=account["email"])
        source = "Customer portal" if is_customer else "Employee POS"

        tracking_token = secrets.token_urlsafe(32) if is_customer else None

        tracking_hash = hashlib.sha256(tracking_token.encode()).hexdigest() if tracking_token else None

        customer_email = ""

        payment_method = "Pay at pickup"

        payment_last_four = None

        if is_customer:

            customer_email = required_text(body.get("customerEmail"), "Email address", 254)

            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", customer_email):

                raise ApiError("Enter a valid email address.")

            payment_method = 'Demo card'
            payment_last_four = validate_demo_payment(body)

        customer_first_name, customer_last_name, customer_name = person_name_parts(
            body, "customerFirstName", "customerLastName", "customerName", "Customer"
        )

        customer_phone = normalize_phone_number(required_text(body.get("customerPhone"), "Customer phone", 30))

        channel = "Online pickup" if is_customer else body.get("channel")

        if not is_customer and (not isinstance(channel, str) or channel not in ALLOWED_CHANNELS):

            raise ApiError("Choose a valid order channel.")

        pickup_date, pickup_time = pickup_schedule_values(
            body.get("pickupDate"), body.get("pickupTime"),
            minimum_buffer_minutes=20,
        )

        notes = body.get("notes", "")

        if not isinstance(notes, str) or len(notes) > 4000:

            raise ApiError("Order notes must be text no longer than 4000 characters.")



        connection = database_connection()

        try:

            connection.begin()

            cursor = connection.cursor()

            customer_id = get_or_create_customer(
                cursor, customer_name, customer_first_name, customer_last_name, customer_phone
            )

            public_order_code = None
            for _attempt in range(5):
                candidate_code = generate_public_order_code()
                try:
                    cursor.execute(
                        """
                        INSERT INTO orders
                            (customer_id, public_order_code, source, channel, pickup_date, pickup_time, status, notes,
                             subtotal, tax_rate_bps, tax_amount, total,
                             tracking_token_hash, customer_email, payment_method, payment_last_four)
                        VALUES (%s, %s, %s, %s, %s, %s, 'Confirmed', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (customer_id, candidate_code, source, channel, pickup_date, pickup_time, notes, subtotal,
                         TAX_RATE_BPS, tax_amount, total, tracking_hash, customer_email, payment_method, payment_last_four),
                    )
                    public_order_code = candidate_code
                    break
                except pymysql.err.IntegrityError:
                    cursor.execute("SELECT 1 FROM orders WHERE public_order_code = %s", (candidate_code,))
                    if cursor.fetchone():
                        continue
                    raise
            if public_order_code is None:
                raise RuntimeError("Could not allocate a unique public order code after five attempts.")

            order_id = cursor.lastrowid

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

                            (order_item_id, topping_id, quantity, `portion`, unit_price)

                        VALUES (%s, %s, %s, %s, %s)

                        """,

                        (item_id, topping_ids[topping["name"]], topping["quantity"], item["portion"], item["toppingUnitPrice"]),

                    )

            if is_customer:
                profile = dict(firstName=customer_first_name, lastName=customer_last_name, phone=customer_phone, email=customer_email)
                checkout_key = session.setdefault('checkout_key', secrets.token_urlsafe(32))
                cursor.execute('SELECT content FROM guest_checkouts WHERE checkout_key = %s', (checkout_key,))
                previous = cursor.fetchone()
                receipts = json.loads(previous['content']).get('receipts', []) if previous else []
                content = dict(profile=profile, receipts=[dict(id=int(order_id), orderCode=public_order_code, token=tracking_token)] + receipts[:9])
                cursor.execute('INSERT INTO guest_checkouts (checkout_key, content) VALUES (%s, %s) ON DUPLICATE KEY UPDATE content = VALUES(content)', (checkout_key, json.dumps(content)))
                account = current_customer_account()
                if account:
                    cursor.execute('INSERT INTO customer_order_receipts (order_id, account_email, tracking_token) VALUES (%s, %s, %s)', (order_id, account['email'], tracking_token))
                    cursor.execute('DELETE FROM customer_drafts WHERE account_email = %s', (account['email'],))
            connection.commit()

        except Exception:

            connection.rollback()

            raise

        finally:

            connection.close()

        created_at = datetime.now().astimezone().replace(tzinfo=None)

        response_order = {

            "publicOrderCode": public_order_code,

            "source": source,

            "channel": channel,

            "customerName": customer_name,

            "customerFirstName": customer_first_name,

            "customerLastName": customer_last_name,

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

            "pickupTime": pickup_time.strftime("%H:%M") if pickup_time else "",
            "pickupDate": pickup_date.isoformat(),

            "status": "Confirmed",

            "createdAt": iso_timestamp(created_at),

            "completedAt": None,

        }

        response_order["paymentMethod"] = payment_method

        response_order["paymentLastFour"] = payment_last_four

        response_order["customerEmail"] = customer_email

        if is_customer:

            response_order["trackingToken"] = tracking_token

        else:

            response_order["id"] = int(order_id)

        return jsonify(response_order), 201

    except ApiError as exc:

        return jsonify({"error": str(exc)}), exc.status_code

    except RuntimeError as exc:

        app.logger.error("MariaDB configuration error: %s", exc)

        return jsonify({"error": "MariaDB is not configured: " + str(exc)}), 503

    except Exception:

        app.logger.exception("Could not create order")

        return jsonify({"error": "Order could not be saved. Check that MariaDB is running, the connection settings are correct, and database/customer_portal.sql has been applied."}), 503

@app.patch("/api/employee/orders/<int:order_id>")
@staff_required
@csrf_required

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

