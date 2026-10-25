CREATE DATABASE IF NOT EXISTS luigis_pizzeria

  CHARACTER SET utf8mb4

  COLLATE utf8mb4_unicode_ci;

USE luigis_pizzeria;

CREATE TABLE IF NOT EXISTS customers (

  customer_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  full_name VARCHAR(200) NOT NULL,
  first_name VARCHAR(80) NOT NULL DEFAULT '',
  last_name VARCHAR(80) NOT NULL DEFAULT '',

  phone VARCHAR(30) NOT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)

    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (customer_id),

  UNIQUE KEY uq_customers_phone (phone),

  CONSTRAINT chk_customers_name CHECK (CHAR_LENGTH(TRIM(full_name)) > 0)

) ENGINE=InnoDB;

-- Email is the unique account ID; phone numbers may be shared by households.
CREATE TABLE IF NOT EXISTS customer_accounts (
  email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  full_name VARCHAR(200) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  account_email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY idx_session_expiry (expires_at),
  FOREIGN KEY (account_email) REFERENCES customer_accounts(email) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customer_login_limits (
  email_hash CHAR(64) NOT NULL PRIMARY KEY,
  attempts INT UNSIGNED NOT NULL,
  window_start DATETIME NOT NULL
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS orders (

  order_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  public_order_code VARCHAR(40) NOT NULL,

  customer_id BIGINT UNSIGNED NOT NULL,
  account_email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  KEY idx_orders_account (account_email, created_at),
  CONSTRAINT fk_orders_account FOREIGN KEY (account_email) REFERENCES customer_accounts(email),

  source ENUM('Employee POS', 'Customer portal') NOT NULL DEFAULT 'Employee POS',

  channel VARCHAR(40) NOT NULL,

  pickup_date DATE NULL,

  pickup_time TIME NULL,

  tracking_token_hash CHAR(64) NULL,

  customer_email VARCHAR(254) NOT NULL DEFAULT '',

  payment_method VARCHAR(40) NOT NULL DEFAULT 'Pay at pickup',

  payment_last_four CHAR(4) NULL,

  status ENUM('Confirmed', 'In-Progress', 'Ready', 'Overdue', 'Completed')

    NOT NULL DEFAULT 'Confirmed',

  notes TEXT NOT NULL,

  subtotal DECIMAL(10, 2) UNSIGNED NOT NULL,

  tax_rate_bps SMALLINT UNSIGNED NOT NULL DEFAULT 975,

  tax_amount DECIMAL(10, 2) UNSIGNED NOT NULL,

  total DECIMAL(10, 2) UNSIGNED NOT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)

    ON UPDATE CURRENT_TIMESTAMP(3),

  completed_at DATETIME(3) NULL,

  PRIMARY KEY (order_id),

  UNIQUE KEY uq_orders_public_order_code (public_order_code),

  UNIQUE KEY uq_orders_tracking_token (tracking_token_hash),

  KEY idx_orders_status_created (status, created_at),

  KEY idx_orders_customer_created (customer_id, created_at),

  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id)

    REFERENCES customers (customer_id),

  CONSTRAINT chk_orders_tax CHECK (

    tax_amount = ROUND(subtotal * tax_rate_bps / 10000, 2)

  ),

  CONSTRAINT chk_orders_total CHECK (total = subtotal + tax_amount),

  CONSTRAINT chk_orders_completed_at CHECK (

    (status = 'Completed' AND completed_at IS NOT NULL)

    OR (status <> 'Completed' AND completed_at IS NULL)

  )

) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (

  order_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  order_id BIGINT UNSIGNED NOT NULL,

  line_number SMALLINT UNSIGNED NOT NULL,

  item_type ENUM('Pizza', 'Drink') NOT NULL,

  item_name VARCHAR(120) NOT NULL,

  pizza_size ENUM('Small', 'Medium', 'Large') NULL,

  drink_name VARCHAR(40) NULL,

  drink_size ENUM('Small', 'Medium', 'Large') NULL,

  quantity SMALLINT UNSIGNED NOT NULL,

  unit_price DECIMAL(10, 2) UNSIGNED NOT NULL,

  description VARCHAR(500) NOT NULL DEFAULT '',

  PRIMARY KEY (order_item_id),

  UNIQUE KEY uq_order_items_line (order_id, line_number),

  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id)

    REFERENCES orders (order_id) ON DELETE CASCADE,

  CONSTRAINT chk_order_items_quantity CHECK (quantity > 0),

  CONSTRAINT chk_order_items_kind CHECK (

    (item_type = 'Pizza' AND pizza_size IS NOT NULL AND drink_name IS NULL AND drink_size IS NULL)

    OR (item_type = 'Drink' AND pizza_size IS NULL AND drink_name IS NOT NULL AND drink_size IS NOT NULL)

  )

) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS toppings (

  topping_id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,

  topping_name VARCHAR(40) NOT NULL,

  PRIMARY KEY (topping_id),

  UNIQUE KEY uq_toppings_name (topping_name)

) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_item_toppings (

  order_item_id BIGINT UNSIGNED NOT NULL,

  topping_id SMALLINT UNSIGNED NOT NULL,

  quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  `portion` VARCHAR(20) NOT NULL,

  unit_price DECIMAL(10, 2) UNSIGNED NOT NULL,

  PRIMARY KEY (order_item_id, topping_id),

  CONSTRAINT chk_item_toppings_quantity CHECK (quantity BETWEEN 1 AND 3),

  CONSTRAINT chk_item_toppings_max_three CHECK (quantity <= 3),

  CONSTRAINT fk_item_toppings_item FOREIGN KEY (order_item_id)

    REFERENCES order_items (order_item_id) ON DELETE CASCADE,

  CONSTRAINT fk_item_toppings_topping FOREIGN KEY (topping_id)

    REFERENCES toppings (topping_id)

) ENGINE=InnoDB;

INSERT IGNORE INTO toppings (topping_name) VALUES

  ('Pepperoni'),

  ('Italian sausage'),

  ('Beef'),

  ('Green peppers'),

  ('Jalapenos'),

  ('Pineapple'),

  ('Onion'),

  ('Black olives'),

  ('Diced tomatoes');

CREATE TABLE IF NOT EXISTS staff_users (
  staff_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  first_name VARCHAR(80) NOT NULL DEFAULT '',
  last_name VARCHAR(80) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  staff_role ENUM('owner', 'manager', 'employee') NOT NULL DEFAULT 'employee',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  auth_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (staff_id),
  UNIQUE KEY uq_staff_users_email (email),
  KEY idx_staff_users_role_active (staff_role, is_active),
  CONSTRAINT fk_staff_users_created_by FOREIGN KEY (created_by)
    REFERENCES staff_users (staff_id) ON DELETE SET NULL,
  CONSTRAINT chk_staff_users_name CHECK (CHAR_LENGTH(TRIM(full_name)) > 0)
) ENGINE=InnoDB;


-- Menu specialties and cross-device customer orders.
CREATE TABLE IF NOT EXISTS menu_settings (
 setting_key VARCHAR(40) PRIMARY KEY,
 content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_drafts (
 account_email VARCHAR(254) PRIMARY KEY,
 content TEXT NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customer_order_receipts (
 order_id BIGINT UNSIGNED PRIMARY KEY,
 account_email VARCHAR(254) NOT NULL,
 tracking_token VARCHAR(43) NOT NULL,
 INDEX (account_email)
);

CREATE TABLE IF NOT EXISTS guest_checkouts (checkout_key VARCHAR(43) PRIMARY KEY, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

