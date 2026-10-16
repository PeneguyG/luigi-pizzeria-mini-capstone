CREATE DATABASE IF NOT EXISTS luigis_pizzeria

  CHARACTER SET utf8mb4

  COLLATE utf8mb4_unicode_ci;

USE luigis_pizzeria;

CREATE TABLE IF NOT EXISTS customers (

  customer_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  full_name VARCHAR(80) NOT NULL,

  phone VARCHAR(30) NOT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)

    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (customer_id),

  UNIQUE KEY uq_customers_phone (phone),

  CONSTRAINT chk_customers_name CHECK (CHAR_LENGTH(TRIM(full_name)) > 0)

) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (

  order_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  customer_id BIGINT UNSIGNED NOT NULL,

  source ENUM('Employee POS', 'Customer portal') NOT NULL DEFAULT 'Employee POS',

  channel VARCHAR(40) NOT NULL,

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

  portion VARCHAR(20) NOT NULL,

  unit_price DECIMAL(10, 2) UNSIGNED NOT NULL,

  PRIMARY KEY (order_item_id, topping_id),

  CONSTRAINT chk_item_toppings_quantity CHECK (quantity BETWEEN 1 AND 3),

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

