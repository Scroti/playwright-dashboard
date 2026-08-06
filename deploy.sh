#!/bin/bash
set -e

echo "=== Playwright Dashboard Deploy ==="

if [ "$EUID" -ne 0 ]; then
  echo "✖ Run as root"
  exit 1
fi

APP_DIR="/opt/playwright"
cd "$APP_DIR"

echo "→ Updating apt..."
apt-get update -qq

if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  echo "→ Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs
else
  echo "✓ Node.js $(node -v) already installed"
fi

if ! command -v pm2 &> /dev/null; then
  echo "→ Installing PM2..."
  npm install -g pm2
else
  echo "✓ PM2 already installed"
fi

echo "→ Installing app dependencies..."
npm install --omit=dev

echo "→ Installing Chromium + system deps (this takes a few minutes)..."
npx playwright install chromium
npx playwright install-deps chromium

echo "→ Starting with PM2..."
pm2 delete playwright-dashboard 2>/dev/null || true
pm2 start server.js --name playwright-dashboard
pm2 save

echo "→ Configuring PM2 to start on boot..."
pm2 startup systemd -u root --hp /root | tail -n 1 | bash || true

echo ""
echo "✓ Deploy complete!"
echo "  Dashboard: http://13.140.142.62:3000  (if firewall allows)"
echo "  Local: http://127.0.0.1:3000"
echo ""
echo "  Commands:"
echo "    pm2 status"
echo "    pm2 logs playwright-dashboard"
echo "    pm2 restart playwright-dashboard"
echo ""
echo "Next → set up Cloudflare Tunnel:"
echo "    bash setup-tunnel.sh app.yourdomain.com"
