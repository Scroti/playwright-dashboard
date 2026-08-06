#!/bin/bash
set -e

DOMAIN=$1
if [ -z "$DOMAIN" ]; then
  echo "Usage: bash setup-tunnel.sh app.yourdomain.com"
  echo "  (the domain must already be added to your Cloudflare account)"
  exit 1
fi

echo "=== Cloudflare Tunnel Setup ==="
echo "Target: $DOMAIN → http://localhost:3000"
echo ""

if ! command -v cloudflared &> /dev/null; then
  echo "→ Installing cloudflared..."
  curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb
fi

echo ""
echo "→ Auth: open the URL below in your browser and select the ZONE (domain) on Cloudflare."
echo ""
cloudflared tunnel login

TUNNEL_NAME="playwright-dashboard"

if ! cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "→ Creating tunnel..."
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "✓ Tunnel '$TUNNEL_NAME' already exists"
fi

TUNNEL_ID=$(cloudflared tunnel list | awk -v name="$TUNNEL_NAME" '$2==name {print $1}')
if [ -z "$TUNNEL_ID" ]; then
  echo "✖ Could not resolve tunnel ID"
  exit 1
fi
echo "  Tunnel ID: $TUNNEL_ID"

echo "→ Writing /etc/cloudflared/config.yml..."
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:3000
  - service: http_status:404
EOF

echo "→ Adding DNS route..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" || echo "  (DNS record may already exist)"

echo "→ Installing cloudflared as systemd service..."
cloudflared service install 2>/dev/null || true
systemctl enable cloudflared
systemctl restart cloudflared

echo ""
echo "✓ Tunnel is live!"
echo "  Dashboard: https://$DOMAIN"
echo ""
echo "  Check status: systemctl status cloudflared"
echo "  Logs:         journalctl -u cloudflared -f"
