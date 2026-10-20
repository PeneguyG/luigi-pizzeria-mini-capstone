USE luigis_pizzeria;

ALTER TABLE customers
  MODIFY COLUMN full_name VARCHAR(200) NOT NULL,
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(80) NOT NULL DEFAULT '' AFTER full_name,
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(80) NOT NULL DEFAULT '' AFTER first_name;

UPDATE customers
   SET first_name = CASE
         WHEN first_name = '' THEN SUBSTRING_INDEX(TRIM(full_name), ' ', 1)
         ELSE first_name
       END,
       last_name = CASE
         WHEN last_name = '' AND LOCATE(' ', TRIM(full_name)) > 0
           THEN TRIM(SUBSTRING(TRIM(full_name), LOCATE(' ', TRIM(full_name)) + 1))
         ELSE last_name
       END
 WHERE first_name = '' OR last_name = '';

ALTER TABLE staff_users
  MODIFY COLUMN full_name VARCHAR(200) NOT NULL,
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(80) NOT NULL DEFAULT '' AFTER full_name,
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(80) NOT NULL DEFAULT '' AFTER first_name;

UPDATE staff_users
   SET first_name = CASE
         WHEN first_name = '' THEN SUBSTRING_INDEX(TRIM(full_name), ' ', 1)
         ELSE first_name
       END,
       last_name = CASE
         WHEN last_name = '' AND LOCATE(' ', TRIM(full_name)) > 0
           THEN TRIM(SUBSTRING(TRIM(full_name), LOCATE(' ', TRIM(full_name)) + 1))
         ELSE last_name
       END
 WHERE first_name = '' OR last_name = '';
