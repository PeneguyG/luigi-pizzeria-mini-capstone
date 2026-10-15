-- Apply once to an existing database after the topping quantity migration.
-- The additional check tightens the earlier 1-10 limit to 1-3.
USE luigis_pizzeria;

ALTER TABLE order_item_toppings
  ADD CONSTRAINT chk_item_toppings_max_three CHECK (quantity <= 3);
