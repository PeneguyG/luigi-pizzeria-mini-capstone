#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy Luigi's Pizzeria on a fresh Debian 13 Compute Engine VM.
# Run as root after opening TCP 80 and 443 in the VM's Google Cloud VPC firewall.

APP_REPO_URL="${APP_REPO_URL:-https://github.com/PeneguyG/luigi-pizzeria-mini-capstone.git}"
APP_REPO_BRANCH="${APP_REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/luigi-pizzeria}"
DB_NAME="luigis_pizzeria"
DB_USER="${DB_USER:-luigis_app}"
SERVICE_NAME="luigi-pizzeria"

say() { printf '[luigi-deploy] %s\n' "$*"; }
die() { printf '[luigi-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

need_input() {
  local name="$1" label="$2" value
  local -n target="$name"
  value="${target-}"
  if [[ -z "$value" ]]; then
    [[ -r /dev/tty ]] || die "$name is required. Set it in the environment or run from an interactive terminal."
    read -r -p "$label: " value </dev/tty
  fi
  [[ -n "$value" ]] || die "$name cannot be empty."
  target="$value"
}

need_secret() {
  local name="$1" label="$2" minimum="$3" value confirm
  local -n target="$name"
  value="${target-}"
  if [[ -z "$value" ]]; then
    [[ -r /dev/tty ]] || die "$name is required. Set it in the environment or run from an interactive terminal."
    read -r -s -p "$label: " value </dev/tty
    printf '\n' >/dev/tty
    read -r -s -p "Confirm $label: " confirm </dev/tty
    printf '\n' >/dev/tty
    [[ "$value" == "$confirm" ]] || die "$name values did not match."
  fi
  [[ ${#value} -ge "$minimum" ]] || die "$name must be at least $minimum characters."
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name must not contain a newline."
  target="$value"
}

[[ "$EUID" -eq 0 ]] || die "Run with sudo or as root."
[[ -r /etc/os-release ]] || die "Cannot identify the operating system."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == debian && "${VERSION_ID:-}" == 13 ]] || die "This script targets Debian 13 (trixie)."

DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN:-luigispizzeriapickup}"
need_input DUCKDNS_DOMAIN "DuckDNS subdomain (or full name ending in .duckdns.org)"
if [[ "$DUCKDNS_DOMAIN" == *.duckdns.org ]]; then
  DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN%.duckdns.org}"
fi
[[ "$DUCKDNS_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || die "Use a valid DuckDNS subdomain, without URL or path."
DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN,,}"
FQDN="${DUCKDNS_DOMAIN}.duckdns.org"

need_secret DUCKDNS_TOKEN "DuckDNS token" 16
[[ "$DUCKDNS_TOKEN" =~ ^[A-Za-z0-9-]{16,128}$ ]] || die "DuckDNS token must contain only letters, numbers, or hyphens."
need_input LETSENCRYPT_EMAIL "Email for Let's Encrypt certificate notices"
[[ "$LETSENCRYPT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "Enter a valid email address."

STAFF_USER="${STAFF_USER:-luigi-staff}"
[[ "$STAFF_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "STAFF_USER may contain letters, numbers, dot, underscore, and hyphen."
need_secret STAFF_PASSWORD "Nginx staff password (minimum 14 characters)" 14
[[ ${#STAFF_PASSWORD} -le 72 ]] || die "STAFF_PASSWORD must be at most 72 characters for bcrypt authentication."

[[ "$APP_REPO_URL" == https://* || "$APP_REPO_URL" == git@* ]] || die "APP_REPO_URL must be an HTTPS or SSH Git URL."
[[ "$APP_REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "APP_REPO_BRANCH contains unsupported characters."
[[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_USER may contain letters, numbers, and underscore."

say "Installing Nginx, MariaDB, Python, Gunicorn, and certificate tools."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  apache2-utils ca-certificates certbot curl git mariadb-client mariadb-server \
  python3-certbot-nginx \
  nginx openssl python3 python3-pip python3-venv tzdata

# Give this 1 GiB VM some breathing room while keeping database memory bounded.
if ! swapon --show=NAME --noheadings | grep -Fxq /swapfile; then
  if [[ ! -e /swapfile ]]; then
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    else
      dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    fi
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -qE '^/swapfile[[:space:]]' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab

install -d -m 0755 "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
  current_branch="$(git -C "$APP_DIR" branch --show-current)"
  [[ "$current_branch" == "$APP_REPO_BRANCH" ]] || die "Existing checkout is on '$current_branch', expected '$APP_REPO_BRANCH'."
  git -C "$APP_DIR" pull --ff-only origin "$APP_REPO_BRANCH"
elif [[ -e "$APP_DIR" ]]; then
  [[ -z "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "$APP_DIR exists and is not an empty Git checkout. Set APP_DIR to another path."
  git clone --branch "$APP_REPO_BRANCH" --depth 1 "$APP_REPO_URL" "$APP_DIR"
else
  git clone --branch "$APP_REPO_BRANCH" --depth 1 "$APP_REPO_URL" "$APP_DIR"
fi
[[ -f "$APP_DIR/backend/customer_portal_app.py" && -f "$APP_DIR/database/customer_portal.sql" && -f "$APP_DIR/templates/landingpage.html" && -f "$APP_DIR/templates/customer-portal.html" && -f "$APP_DIR/templates/employee-dashboard.html" && -f "$APP_DIR/static/images/luigis-vintage-pizza-badge.png" && -f "$APP_DIR/static/js/customer-portal.js" ]] || die "The repository is missing one or more backend, template, static, or database files."

say "Configuring MariaDB for the small VM."
cat >/etc/mysql/mariadb.conf.d/60-luigi-pizzeria.cnf <<'EOF'
[mysqld]
bind-address = 127.0.0.1
innodb_buffer_pool_size = 128M
max_connections = 20
performance_schema = OFF
table_open_cache = 256
tmp_table_size = 16M
max_heap_table_size = 16M
EOF
systemctl enable --now mariadb
systemctl restart mariadb

# Apply the current schema, then add portal fields for an older local database.
mariadb --protocol=socket --user=root < "$APP_DIR/database/customer_portal.sql"
ensure_column() {
  local column="$1" definition="$2" exists
  exists="$(mariadb --protocol=socket --user=root --batch --skip-column-names \
    -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='orders' AND COLUMN_NAME='${column}'")"
  if [[ "$exists" == 0 ]]; then
    mariadb --protocol=socket --user=root --database="$DB_NAME" -e "ALTER TABLE orders ADD COLUMN ${column} ${definition}"
  fi
}
ensure_column tracking_token_hash "CHAR(64) NULL AFTER pickup_time"
ensure_column customer_email "VARCHAR(254) NOT NULL DEFAULT '' AFTER tracking_token_hash"
ensure_column payment_method "VARCHAR(40) NOT NULL DEFAULT 'Pay at pickup' AFTER customer_email"
ensure_column payment_last_four "CHAR(4) NULL AFTER payment_method"
ensure_topping_quantity="$(mariadb --protocol=socket --user=root --batch --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='order_item_toppings' AND COLUMN_NAME='quantity'")"
if [[ "$ensure_topping_quantity" == 0 ]]; then
  mariadb --protocol=socket --user=root --database="$DB_NAME" -e 'ALTER TABLE order_item_toppings ADD COLUMN quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER topping_id'
fi
base_topping_check="$(mariadb --protocol=socket --user=root --batch --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='${DB_NAME}' AND TABLE_NAME='order_item_toppings' AND CONSTRAINT_NAME='chk_item_toppings_quantity'")"
if [[ "$base_topping_check" == 0 ]]; then
  mariadb --protocol=socket --user=root --database="$DB_NAME" -e 'ALTER TABLE order_item_toppings ADD CONSTRAINT chk_item_toppings_quantity CHECK (quantity BETWEEN 1 AND 3)'
fi
max_topping_check="$(mariadb --protocol=socket --user=root --batch --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='${DB_NAME}' AND TABLE_NAME='order_item_toppings' AND CONSTRAINT_NAME='chk_item_toppings_max_three'")"
if [[ "$max_topping_check" == 0 ]]; then
  mariadb --protocol=socket --user=root --database="$DB_NAME" -e 'ALTER TABLE order_item_toppings ADD CONSTRAINT chk_item_toppings_max_three CHECK (quantity <= 3)'
fi
tracking_index="$(mariadb --protocol=socket --user=root --batch --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='orders' AND INDEX_NAME='uq_orders_tracking_token'")"
if [[ "$tracking_index" == 0 ]]; then
  mariadb --protocol=socket --user=root --database="$DB_NAME" -e 'ALTER TABLE orders ADD UNIQUE KEY uq_orders_tracking_token (tracking_token_hash)'
fi

# Reuse the generated DB password across reruns, or generate a new strong one.
if [[ -z "${DB_PASSWORD:-}" && -r /etc/luigi-pizzeria/app.env ]]; then
  DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' /etc/luigi-pizzeria/app.env | head -n 1)"
fi
if [[ -z "${DB_PASSWORD:-}" ]]; then
  DB_PASSWORD="$(openssl rand -hex 32)"
fi
[[ "$DB_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]] || die "DB_PASSWORD may use letters, numbers, dot, underscore, tilde, and hyphen only."
[[ ${#DB_PASSWORD} -ge 24 ]] || die "DB_PASSWORD must be at least 24 characters."
mariadb --protocol=socket --user=root <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

if ! id -u luigiapp >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/luigi-pizzeria --shell /usr/sbin/nologin --user-group luigiapp
fi
install -d -o luigiapp -g luigiapp -m 0750 /var/lib/luigi-pizzeria
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements-customer-portal.txt" 'gunicorn>=23,<24'

install -d -o root -g root -m 0700 /etc/luigi-pizzeria
cat >/etc/luigi-pizzeria/app.env <<EOF
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
BUSINESS_TIMEZONE=America/Chicago
LOG_LEVEL=INFO
EOF
chmod 600 /etc/luigi-pizzeria/app.env

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Luigi's Pizzeria Flask application
After=network.target mariadb.service
Requires=mariadb.service

[Service]
Type=simple
User=luigiapp
Group=luigiapp
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/luigi-pizzeria/app.env
ExecStart=${APP_DIR}/.venv/bin/gunicorn --workers 1 --threads 4 --timeout 60 --bind 127.0.0.1:8000 backend.customer_portal_app:app
Restart=on-failure
RestartSec=3
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
NoNewPrivileges=true
ReadWritePaths=/var/lib/luigi-pizzeria

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Keep employee pages and APIs private behind Nginx Basic Auth.
install -o root -g www-data -m 0640 /dev/null /etc/nginx/.htpasswd-luigi-pizzeria
printf '%s\n' "$STAFF_PASSWORD" | htpasswd -iB -c /etc/nginx/.htpasswd-luigi-pizzeria "$STAFF_USER"
cat >/etc/nginx/sites-available/luigi-pizzeria <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};
    server_tokens off;
    client_max_body_size 1m;

    location ^~ /employee {
        auth_basic "Luigi's staff";
        auth_basic_user_file /etc/nginx/.htpasswd-luigi-pizzeria;
        include proxy_params;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:8000;
    }

    location ^~ /api/employee {
        auth_basic "Luigi's staff";
        auth_basic_user_file /etc/nginx/.htpasswd-luigi-pizzeria;
        include proxy_params;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:8000;
    }

    location / {
        include proxy_params;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:8000;
    }
}
EOF
ln -sfn /etc/nginx/sites-available/luigi-pizzeria /etc/nginx/sites-enabled/luigi-pizzeria
nginx -t
systemctl enable --now nginx
systemctl reload nginx

cat >/etc/default/luigi-pizzeria-duckdns <<EOF
DUCKDNS_DOMAIN=${DUCKDNS_DOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
EOF
chmod 600 /etc/default/luigi-pizzeria-duckdns
cat >/usr/local/sbin/luigi-pizzeria-duckdns-update <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
response="$(curl --silent --show-error --fail --retry 3 --retry-delay 2 --max-time 20 \
  --get --data-urlencode "domains=${DUCKDNS_DOMAIN}" \
  --data-urlencode "token=${DUCKDNS_TOKEN}" --data-urlencode 'ip=' \
  https://www.duckdns.org/update)"
[[ "$response" == OK* ]] || { printf 'DuckDNS update failed: %s\n' "$response" >&2; exit 1; }
EOF
chmod 0750 /usr/local/sbin/luigi-pizzeria-duckdns-update
cat >/etc/systemd/system/luigi-pizzeria-duckdns.service <<'EOF'
[Unit]
Description=Update Luigi's Pizzeria DuckDNS address
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/default/luigi-pizzeria-duckdns
ExecStart=/usr/local/sbin/luigi-pizzeria-duckdns-update
EOF
cat >/etc/systemd/system/luigi-pizzeria-duckdns.timer <<'EOF'
[Unit]
Description=Refresh Luigi's Pizzeria DuckDNS address periodically

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl start luigi-pizzeria-duckdns.service
systemctl enable --now luigi-pizzeria-duckdns.timer

say "Waiting for ${FQDN} to resolve before requesting HTTPS."
external_ip="$(curl --silent --show-error --fail --max-time 5 \
  -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)"
resolved_ip=""
for attempt in $(seq 1 30); do
  resolved_ip="$(getent ahostsv4 "$FQDN" | awk 'NR == 1 { print $1; exit }' || true)"
  if [[ -n "$resolved_ip" && ( -z "$external_ip" || "$resolved_ip" == "$external_ip" ) ]]; then
    break
  fi
  sleep 2
done
[[ -n "$resolved_ip" ]] || die "${FQDN} did not resolve. Check the DuckDNS subdomain and token."
[[ -z "$external_ip" || "$resolved_ip" == "$external_ip" ]] || die "${FQDN} resolves to ${resolved_ip}, not this VM's external IP ${external_ip}."

say "Requesting a Let's Encrypt certificate for ${FQDN}."
certbot --nginx --redirect --non-interactive --agree-tos --email "$LETSENCRYPT_EMAIL" -d "$FQDN"
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

say "Deployment complete."
say "Landing page: https://${FQDN}/"
say "Customer ordering and order tracking: https://${FQDN}/customer"
say "Employee dashboard (Basic Auth): https://${FQDN}/employee"
say "Check services with: systemctl status ${SERVICE_NAME} nginx mariadb"
