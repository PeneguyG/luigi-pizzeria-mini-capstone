"""Database-backed customer identity. Email is the unique public account ID."""
from datetime import datetime, timedelta, timezone
import hashlib
import os
import re
import secrets

from flask import g, jsonify, request
import pymysql
from werkzeug.security import check_password_hash, generate_password_hash

COOKIE = 'luigi_customer_session'
DUMMY_HASH = generate_password_hash(secrets.token_urlsafe(32))


def install_accounts(app, connect):
    def current_account():
        if hasattr(g, 'customer_account'):
            return g.customer_account
        g.customer_account = None
        token = request.cookies.get(COOKIE, '')
        if len(token) != 43:
            return None
        connection = connect()
        try:
            cursor = connection.cursor()
            cursor.execute('''SELECT a.email, a.full_name AS name, a.first_name AS firstName, a.last_name AS lastName, a.phone
                FROM customer_sessions s JOIN customer_accounts a ON a.email = s.account_email
                WHERE s.token_hash = %s AND s.expires_at > UTC_TIMESTAMP()''',
                (hashlib.sha256(token.encode()).hexdigest(),))
            g.customer_account = cursor.fetchone()
            return g.customer_account
        finally:
            connection.close()

    @app.before_request
    def protect_customer_requests():
        if request.path.startswith('/api/customer/') and request.method in {'POST', 'PATCH', 'DELETE'}:
            # Cross-origin forms cannot set this header; cross-origin fetches require
            # CORS permission, which this application does not grant.
            if request.headers.get('X-Luigi-Request') != '1' or not request.is_json:
                return jsonify(error='Use the customer website to submit this request.'), 403

    def start_session(connection, email):
        token = secrets.token_urlsafe(32)
        cursor = connection.cursor()
        old = request.cookies.get(COOKIE, '')
        cursor.execute('DELETE FROM customer_sessions WHERE token_hash = %s OR expires_at <= UTC_TIMESTAMP()',
                       (hashlib.sha256(old.encode()).hexdigest(),))
        cursor.execute('INSERT INTO customer_sessions (token_hash, account_email, expires_at) VALUES (%s, %s, %s)',
                       (hashlib.sha256(token.encode()).hexdigest(), email,
                        datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=7)))
        return token

    def session_response(account, token, status=200):
        response = jsonify(account)
        response.status_code = status
        response.set_cookie(COOKIE, token, max_age=604800, httponly=True,
                            secure=os.environ.get('CUSTOMER_COOKIE_SECURE', '1') != '0',
                            samesite='Lax', path='/')
        return response

    @app.get('/api/customer/account')
    def account():
        return jsonify(customer=current_account())

    @app.post('/api/customer/signup')
    def signup():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify(error='Send account details as JSON.'), 400
        email = body.get('email', '')
        first_name, last_name, phone, password = (body.get(key, '') for key in ('firstName', 'lastName', 'phone', 'password'))
        name = first_name.strip() + ' ' + last_name.strip() if isinstance(first_name, str) and isinstance(last_name, str) else ''
        if not all(isinstance(value, str) for value in (email, first_name, last_name, phone, password)):
            return jsonify(error='Account fields must be text.'), 400
        email, name, phone = email.strip().lower(), name.strip(), phone.strip()
        first_name, last_name = first_name.strip(), last_name.strip()
        if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            return jsonify(error='Enter a valid email address.'), 400
        if not first_name or not last_name or len(first_name) > 80 or len(last_name) > 80 or len(phone) > 30 or len(re.sub(r'\D', '', phone)) < 10:
            return jsonify(error='Enter your first and last name and a phone number with at least 10 digits.'), 400
        if not 8 <= len(password) <= 128:
            return jsonify(error='Use a password between 8 and 128 characters.'), 400
        password_hash = generate_password_hash(password)
        connection = connect()
        try:
            cursor = connection.cursor()
            cursor.execute('INSERT INTO customer_accounts (email, full_name, first_name, last_name, phone, password_hash) VALUES (%s, %s, %s, %s, %s, %s)',
                           (email, name, first_name, last_name, phone, password_hash))
            token = start_session(connection, email)
            connection.commit()
            return session_response(dict(email=email, name=name, firstName=first_name, lastName=last_name, phone=phone), token, 201)
        except pymysql.err.IntegrityError as exc:
            connection.rollback()
            if exc.args[0] == 1062:
                return jsonify(error='An account with this email already exists. Please sign in.'), 409
            raise
        finally:
            connection.close()

    @app.post('/api/customer/signin')
    def signin():
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get('email'), str) or not isinstance(body.get('password'), str):
            return jsonify(error='Enter your email and password.'), 400
        email, password = body['email'].strip().lower(), body['password']
        if len(email) > 254 or len(password) > 128:
            return jsonify(error='Email or password is incorrect.'), 401
        connection = connect()
        try:
            cursor = connection.cursor()
            # Database windows work across workers and server restarts.
            key = hashlib.sha256(email.encode()).hexdigest()
            cursor.execute('''INSERT INTO customer_login_limits (email_hash, attempts, window_start)
                VALUES (%s, 1, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE
                attempts = IF(window_start < UTC_TIMESTAMP() - INTERVAL 15 MINUTE, 1, attempts + 1),
                window_start = IF(window_start < UTC_TIMESTAMP() - INTERVAL 15 MINUTE, UTC_TIMESTAMP(), window_start)''', (key,))
            cursor.execute('SELECT attempts FROM customer_login_limits WHERE email_hash = %s', (key,))
            attempts = cursor.fetchone()['attempts']
            connection.commit()
            if attempts > 20:
                return jsonify(error='Too many sign-in attempts. Try again in 15 minutes.'), 429
            cursor.execute('SELECT email, full_name AS name, first_name AS firstName, last_name AS lastName, phone, password_hash FROM customer_accounts WHERE email = %s', (email,))
            customer = cursor.fetchone()
            valid = check_password_hash(customer['password_hash'] if customer else DUMMY_HASH, password)
            if not customer or not valid:
                return jsonify(error='Email or password is incorrect.'), 401
            customer.pop('password_hash')
            token = start_session(connection, customer['email'])
            connection.commit()
            return session_response(customer, token)
        finally:
            connection.close()

    @app.post('/api/customer/signout')
    def signout():
        connection = connect()
        try:
            cursor = connection.cursor()
            cursor.execute('DELETE FROM customer_sessions WHERE token_hash = %s',
                           (hashlib.sha256(request.cookies.get(COOKIE, '').encode()).hexdigest(),))
            connection.commit()
        finally:
            connection.close()
        response = jsonify(message='Signed out.')
        response.delete_cookie(COOKIE, path='/')
        return response

    return current_account
