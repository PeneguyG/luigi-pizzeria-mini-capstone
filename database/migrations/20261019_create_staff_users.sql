USE luigis_pizzeria;

CREATE TABLE IF NOT EXISTS staff_users (
  staff_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  full_name VARCHAR(80) NOT NULL,
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
