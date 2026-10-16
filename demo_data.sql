USE luigis_pizzeria;

-- Demo customers use reserved 555-01xx numbers and can be safely inserted again.
INSERT IGNORE INTO customers (full_name, phone) VALUES
  ('Demo Joe Rivera', '555-0101'),
  ('Demo Avery Kim', '555-0102'),
  ('Demo Sam Patel', '555-0103'),
  ('Demo Taylor Morgan', '555-0104'),
  ('Demo Casey Brooks', '555-0105'),
  ('Demo Jordan Lee', '555-0106');

SELECT customer_id INTO @demo_joe FROM customers WHERE phone = '555-0101';
SELECT customer_id INTO @demo_avery FROM customers WHERE phone = '555-0102';
SELECT customer_id INTO @demo_sam FROM customers WHERE phone = '555-0103';
SELECT customer_id INTO @demo_taylor FROM customers WHERE phone = '555-0104';
SELECT customer_id INTO @demo_casey FROM customers WHERE phone = '555-0105';
SELECT customer_id INTO @demo_jordan FROM customers WHERE phone = '555-0106';

START TRANSACTION;

-- Active: Confirmed. Large pizza has 2 sausage and 3 green pepper servings.
INSERT INTO orders
  (customer_id, source, channel, pickup_time, status, notes, subtotal,
   tax_rate_bps, tax_amount, total)
SELECT @demo_joe, 'Employee POS', 'Phone pickup',
       IF(TIME_TO_SEC(CURRENT_TIME()) < 82800, ADDTIME(CURRENT_TIME(), '01:00:00'), NULL),
       'Confirmed', 'DEMO DATA: D-001 — Large pizza with 2 sausage and 3 green pepper servings.',
       28.00, 975, 2.73, 30.73
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE notes = 'DEMO DATA: D-001 — Large pizza with 2 sausage and 3 green pepper servings.');
SELECT order_id INTO @demo_order_1 FROM orders WHERE notes = 'DEMO DATA: D-001 — Large pizza with 2 sausage and 3 green pepper servings.' LIMIT 1;

INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_1, 1, 'Pizza', 'Large (18-inch) pizza', 'Large', NULL, NULL, 1, 24.00,
       'Toppings: 2× Italian sausage, 3× Green peppers'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_1 AND line_number = 1);
INSERT INTO order_item_toppings (order_item_id, topping_id, quantity, portion, unit_price)
SELECT oi.order_item_id, t.topping_id, 2, '1 cup', 3.00
  FROM order_items AS oi JOIN toppings AS t ON t.topping_name = 'Italian sausage'
 WHERE oi.order_id = @demo_order_1 AND oi.line_number = 1
   AND NOT EXISTS (SELECT 1 FROM order_item_toppings AS x WHERE x.order_item_id = oi.order_item_id AND x.topping_id = t.topping_id);
INSERT INTO order_item_toppings (order_item_id, topping_id, quantity, portion, unit_price)
SELECT oi.order_item_id, t.topping_id, 3, '1 cup', 3.00
  FROM order_items AS oi JOIN toppings AS t ON t.topping_name = 'Green peppers'
 WHERE oi.order_id = @demo_order_1 AND oi.line_number = 1
   AND NOT EXISTS (SELECT 1 FROM order_item_toppings AS x WHERE x.order_item_id = oi.order_item_id AND x.topping_id = t.topping_id);
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_1, 2, 'Drink', 'Medium Iced tea', NULL, 'Iced tea', 'Medium', 2, 2.00, ''
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_1 AND line_number = 2);

-- Active: In progress. Small beef pizza and a medium cola.
INSERT INTO orders
  (customer_id, source, channel, pickup_time, status, notes, subtotal,
   tax_rate_bps, tax_amount, total)
SELECT @demo_avery, 'Employee POS', 'In-store', NULL, 'In-Progress',
       'DEMO DATA: D-002 — Kitchen has started this order.', 8.00, 975, 0.78, 8.78
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE notes = 'DEMO DATA: D-002 — Kitchen has started this order.');
SELECT order_id INTO @demo_order_2 FROM orders WHERE notes = 'DEMO DATA: D-002 — Kitchen has started this order.' LIMIT 1;
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_2, 1, 'Pizza', 'Small (12-inch) pizza', 'Small', NULL, NULL, 1, 6.00, 'Toppings: 1× Beef'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_2 AND line_number = 1);
INSERT INTO order_item_toppings (order_item_id, topping_id, quantity, portion, unit_price)
SELECT oi.order_item_id, t.topping_id, 1, '¼ cup', 1.00
  FROM order_items AS oi JOIN toppings AS t ON t.topping_name = 'Beef'
 WHERE oi.order_id = @demo_order_2 AND oi.line_number = 1
   AND NOT EXISTS (SELECT 1 FROM order_item_toppings AS x WHERE x.order_item_id = oi.order_item_id AND x.topping_id = t.topping_id);
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_2, 2, 'Drink', 'Medium Cola', NULL, 'Cola', 'Medium', 1, 2.00, ''
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_2 AND line_number = 2);

-- Active: Ready for pickup.
INSERT INTO orders
  (customer_id, source, channel, pickup_time, status, notes, subtotal,
   tax_rate_bps, tax_amount, total)
SELECT @demo_sam, 'Employee POS', 'Phone pickup', NULL, 'Ready',
       'DEMO DATA: D-003 — Ready for pickup.', 12.00, 975, 1.17, 13.17
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE notes = 'DEMO DATA: D-003 — Ready for pickup.');
SELECT order_id INTO @demo_order_3 FROM orders WHERE notes = 'DEMO DATA: D-003 — Ready for pickup.' LIMIT 1;
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_3, 1, 'Pizza', 'Large (18-inch) pizza', 'Large', NULL, NULL, 1, 12.00, 'Toppings: 1× Pepperoni'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_3 AND line_number = 1);
INSERT INTO order_item_toppings (order_item_id, topping_id, quantity, portion, unit_price)
SELECT oi.order_item_id, t.topping_id, 1, '1 cup', 3.00
  FROM order_items AS oi JOIN toppings AS t ON t.topping_name = 'Pepperoni'
 WHERE oi.order_id = @demo_order_3 AND oi.line_number = 1
   AND NOT EXISTS (SELECT 1 FROM order_item_toppings AS x WHERE x.order_item_id = oi.order_item_id AND x.topping_id = t.topping_id);

-- Active: Overdue, with an older creation time for the queue.
INSERT INTO orders
  (customer_id, source, channel, pickup_time, status, notes, subtotal,
   tax_rate_bps, tax_amount, total, created_at)
SELECT @demo_taylor, 'Employee POS', 'In-store', NULL, 'Overdue',
       'DEMO DATA: D-004 — Overdue order for the kitchen queue.', 7.00, 975, 0.68, 7.68,
       CURRENT_TIMESTAMP(3) - INTERVAL 2 HOUR
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE notes = 'DEMO DATA: D-004 — Overdue order for the kitchen queue.');
SELECT order_id INTO @demo_order_4 FROM orders WHERE notes = 'DEMO DATA: D-004 — Overdue order for the kitchen queue.' LIMIT 1;
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_4, 1, 'Pizza', 'Medium (14-inch) pizza', 'Medium', NULL, NULL, 1, 7.00, ''
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_4 AND line_number = 1);

-- Completed orders appear in the history tab.
INSERT INTO orders
  (customer_id, source, channel, pickup_time, status, notes, subtotal,
   tax_rate_bps, tax_amount, total, created_at, completed_at)
SELECT @demo_casey, 'Employee POS', 'Phone pickup', NULL, 'Completed',
       'DEMO DATA: D-005 — Completed pizza order.', 8.00, 975, 0.78, 8.78,
       CURRENT_TIMESTAMP(3) - INTERVAL 2 HOUR,
       CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE notes = 'DEMO DATA: D-005 — Completed pizza order.');
SELECT order_id INTO @demo_order_5 FROM orders WHERE notes = 'DEMO DATA: D-005 — Completed pizza order.' LIMIT 1;
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_5, 1, 'Pizza', 'Small (12-inch) pizza', 'Small', NULL, NULL, 1, 8.00, 'Toppings: 3× Onion'
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_5 AND line_number = 1);
INSERT INTO order_item_toppings (order_item_id, topping_id, quantity, portion, unit_price)
SELECT oi.order_item_id, t.topping_id, 3, '¼ cup', 1.00
  FROM order_items AS oi JOIN toppings AS t ON t.topping_name = 'Onion'
 WHERE oi.order_id = @demo_order_5 AND oi.line_number = 1
   AND NOT EXISTS (SELECT 1 FROM order_item_toppings AS x WHERE x.order_item_id = oi.order_item_id AND x.topping_id = t.topping_id);

INSERT INTO orders
  (customer_id, source, channel, pickup_time, status, notes, subtotal,
   tax_rate_bps, tax_amount, total, created_at, completed_at)
SELECT @demo_jordan, 'Employee POS', 'In-store', NULL, 'Completed',
       'DEMO DATA: D-006 — Completed drink order.', 2.00, 975, 0.20, 2.20,
       CURRENT_TIMESTAMP(3) - INTERVAL 90 MINUTE,
       CURRENT_TIMESTAMP(3) - INTERVAL 60 MINUTE
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE notes = 'DEMO DATA: D-006 — Completed drink order.');
SELECT order_id INTO @demo_order_6 FROM orders WHERE notes = 'DEMO DATA: D-006 — Completed drink order.' LIMIT 1;
INSERT INTO order_items
  (order_id, line_number, item_type, item_name, pizza_size, drink_name, drink_size, quantity, unit_price, description)
SELECT @demo_order_6, 1, 'Drink', 'Small Dr. Pepper', NULL, 'Dr. Pepper', 'Small', 2, 1.00, ''
  FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = @demo_order_6 AND line_number = 1);

COMMIT;

-- Seed rows are marked with "DEMO DATA:" in order notes. Delete those orders
-- manually when finished; their item rows are removed by the foreign-key cascade.
