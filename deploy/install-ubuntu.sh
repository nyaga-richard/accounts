#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: sudo ./deploy/install-ubuntu.sh" >&2
  exit 1
fi
if [[ ! -f /etc/os-release ]]; then echo "Cannot identify this operating system." >&2; exit 1; fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ ${ID:-} != ubuntu ]]; then echo "This installer supports Ubuntu only (detected: ${ID:-unknown})." >&2; exit 1; fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ -e .env ]]; then echo "Refusing to overwrite existing .env. Use deploy/update-ubuntu.sh for an existing install." >&2; exit 1; fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    systemctl enable --now docker
    return
  fi
  echo "Installing Docker Engine and the Compose plugin from Docker's Ubuntu repository..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}
install_docker
command -v openssl >/dev/null 2>&1 || { apt-get update && apt-get install -y openssl; }

cat <<'BANNER'
Ledgerway first-deploy setup
Before continuing, create a remotely-managed Cloudflare Tunnel and configure its
Public Hostname service to http://web:3000. Copy the tunnel token below. Do not
publish PostgreSQL, API, or web ports directly to the internet.
BANNER
read -r -p "Public HTTPS URL (for example https://accounts.example.com): " PUBLIC_URL
PUBLIC_URL=${PUBLIC_URL%/}
if [[ ! $PUBLIC_URL =~ ^https://[A-Za-z0-9.-]+$ ]]; then echo "Enter an HTTPS origin with a hostname only; do not include a path or port." >&2; exit 2; fi
read -r -s -p "Cloudflare Tunnel token: " CLOUDFLARE_TUNNEL_TOKEN; echo
if [[ -z $CLOUDFLARE_TUNNEL_TOKEN || $CLOUDFLARE_TUNNEL_TOKEN =~ [[:space:]] || $CLOUDFLARE_TUNNEL_TOKEN == *'#'* ]]; then echo "The tunnel token must be non-empty and contain no whitespace or # characters." >&2; exit 2; fi
read -r -p "Initial administrator email: " ADMIN_EMAIL
read -r -p "Initial administrator display name [System Administrator]: " ADMIN_NAME
ADMIN_NAME=${ADMIN_NAME:-System Administrator}
if [[ ! $ADMIN_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then echo "Enter a valid administrator email address." >&2; exit 2; fi
read -r -s -p "Initial administrator password (minimum 12 characters): " ADMIN_PASSWORD; echo
read -r -s -p "Confirm administrator password: " ADMIN_PASSWORD_CONFIRM; echo
if [[ ${#ADMIN_PASSWORD} -lt 12 || $ADMIN_PASSWORD != "$ADMIN_PASSWORD_CONFIRM" ]]; then echo "Passwords must match and be at least 12 characters long." >&2; exit 2; fi

POSTGRES_PASSWORD="$(openssl rand -hex 32)"
BETTER_AUTH_SECRET="$(openssl rand -hex 48)"
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
BETTER_AUTH_URL=$PUBLIC_URL
WEB_ORIGIN=$PUBLIC_URL
CLOUDFLARE_TUNNEL_TOKEN=$CLOUDFLARE_TUNNEL_TOKEN
EOF
chmod 600 .env
if [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then chown "$SUDO_USER":"$(id -gn "$SUDO_USER")" .env; fi

compose() { docker compose --profile tunnel "$@"; }
compose config -q
echo "Building Ledgerway containers..."
compose build api web
echo "Starting PostgreSQL..."
compose up -d db
for attempt in $(seq 1 60); do
  if compose exec -T db pg_isready -U ledgerway -d ledgerway >/dev/null 2>&1; then break; fi
  if [[ $attempt -eq 60 ]]; then echo "PostgreSQL did not become ready. Inspect: docker compose logs db" >&2; exit 1; fi
  sleep 2
done
echo "Applying database migrations..."
compose run --rm --no-deps api npm run migrate -w @ledgerway/api
echo "Creating the initial administrator and baseline accounting configuration..."
export ADMIN_EMAIL ADMIN_PASSWORD ADMIN_NAME
compose run --rm --no-deps -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_NAME api npm run seed -w @ledgerway/api
unset ADMIN_PASSWORD ADMIN_PASSWORD_CONFIRM CLOUDFLARE_TUNNEL_TOKEN

echo "Starting Ledgerway and the Cloudflare Tunnel connector..."
compose up -d api web cloudflared
for service in api web; do
  for attempt in $(seq 1 40); do
    if [[ $service == api ]]; then path=/health; port=4000; else path=/; port=3000; fi
    if compose exec -T "$service" node -e "fetch('http://127.0.0.1:${port}${path}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
    if [[ $attempt -eq 40 ]]; then echo "$service did not pass its health check. Inspect: docker compose logs $service" >&2; exit 1; fi
    sleep 3
  done
done
compose ps
cat <<EOF

Ledgerway is running. Public URL: $PUBLIC_URL
Tunnel status: docker compose --profile tunnel logs -f cloudflared
Local status:  docker compose ps
Keep .env private (mode 600) and store the initial administrator password securely.
EOF
