-- Apply once to databases created from the earlier schema.sql.
-- New databases already have this column and constraint in schema.sql.
USE luigis_pizzeria;

ALTER TABLE order_item_toppings
  ADD COLUMN quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER topping_id,
  ADD CONSTRAINT chk_item_toppings_quantity CHECK (quantity BETWEEN 1 AND 10);
