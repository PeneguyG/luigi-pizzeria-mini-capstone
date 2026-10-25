-- Safe to run against an existing or already-upgraded Luigi's Pizzeria database.
USE luigis_pizzeria;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS public_order_code VARCHAR(40) NULL AFTER order_id;

-- Keep existing receipts usable while moving newly created orders to random codes.
-- New orders are assigned an unpredictable code by Python's secrets module.
UPDATE orders
   SET public_order_code = CONCAT('PZ-LEGACY-', order_id)
 WHERE public_order_code IS NULL;

ALTER TABLE orders
  MODIFY COLUMN public_order_code VARCHAR(40) NOT NULL,
  ADD UNIQUE KEY IF NOT EXISTS uq_orders_public_order_code (public_order_code);
