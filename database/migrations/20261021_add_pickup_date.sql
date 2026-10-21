-- Run once against an existing Luigi's Pizzeria database.
ALTER TABLE orders
  ADD COLUMN pickup_date DATE NULL AFTER channel;

-- Existing orders without a pickup date continue to be treated as same-day orders.
