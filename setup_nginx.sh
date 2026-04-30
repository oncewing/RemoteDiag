#!/bin/bash
# nginx SSL proxy setup for RemoteDiag
# Run: bash setup_nginx.sh

set -e
CONF_SRC="$(dirname "$0")/nginx_remotediag.conf"
CONF_DST="/etc/nginx/sites-available/remotediag"

# Install to sites-available and enable
sudo cp "$CONF_SRC" "$CONF_DST"
sudo ln -sf "$CONF_DST" /etc/nginx/sites-enabled/remotediag

# Disable default site (removes port 80 binding that caused the conflict)
sudo rm -f /etc/nginx/sites-enabled/default

# Test config
sudo nginx -t

# Start / reload
if sudo systemctl is-active --quiet nginx; then
    sudo systemctl reload nginx
else
    sudo systemctl start nginx
fi

echo "nginx OK — listening on :8443 (SSL) -> :8000 (Flask HTTP)"
