# Pool Heat Pi Bridge

A small Node/Express server that runs on a Raspberry Pi at your house and lets the Lovable cloud app control your **Pentair ScreenLogic** pool heaters. Pentair's dispatcher silently rejects requests from datacenter IPs (Railway, AWS, Supabase, etc.), so we route through the Pi to get a residential IP.

The Pi does **not** need to be on the same network as any pool — it just needs internet access from a residential connection.

---

## Overview

```
Browser -> Lovable app -> screenlogic-control edge function
                                  |
                                  |  HTTPS + Bearer token
                                  v
                         Cloudflare Tunnel
                                  |
                                  v
                     Raspberry Pi (this server)
                                  |
                                  v
              Pentair dispatcher -> remote pool adapters
```

The Pi exposes:

| Method | Path                | Purpose                                           |
|--------|---------------------|---------------------------------------------------|
| `GET`  | `/healthz`          | Tunnel/uptime check (no auth)                     |
| `POST` | `/api/pool/status`  | Read current temps + heater state for one system  |
| `POST` | `/api/pool/heater`  | Set the heater set-point and verify it stuck      |

All `/api/*` routes require `Authorization: Bearer <PI_AUTH_TOKEN>`.

---

## 1. Hardware

- Raspberry Pi Zero 2 W (or any Pi with internet)
- microSD card (8 GB+)
- USB power adapter
- Residential internet connection (the whole reason this exists)

---

## 2. Flash Raspberry Pi OS Lite

1. Install **Raspberry Pi Imager** on your computer: https://www.raspberrypi.com/software/
2. Insert the microSD card.
3. Choose:
   - **Device**: Raspberry Pi Zero 2 W
   - **OS**: Raspberry Pi OS Lite (64-bit)
   - **Storage**: your SD card
4. Click the gear icon and pre-configure:
   - Hostname: `poolpi`
   - Enable SSH (use password auth or your public key)
   - Set username + password (e.g. `pi` / a strong password)
   - Configure your Wi-Fi SSID + password
5. Write, then boot the Pi. After ~1 minute SSH in:

       ssh pi@poolpi.local

---

## 3. Install Node.js (LTS)

    sudo apt update && sudo apt upgrade -y
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs git
    node -v   # should be v20.x

---

## 4. Deploy the server

Either clone the whole repo and run from `pi-server/`, or copy just the `pi-server/` folder onto the Pi.

    cd ~
    git clone <your-repo-url> poolheat
    cd poolheat/pi-server
    npm install

Generate a strong shared token (you'll paste this same value into the Lovable secret `SCREENLOGIC_PI_AUTH_TOKEN` later):

    openssl rand -hex 32

Create `/etc/poolheat.env` (root-owned, locked down):

    sudo tee /etc/poolheat.env >/dev/null <<EOF
    PI_AUTH_TOKEN=<paste-the-hex-token-from-above>
    PORT=8787
    EOF
    sudo chmod 600 /etc/poolheat.env

Quick smoke test:

    set -a; source /etc/poolheat.env; set +a
    node server.js
    # in another shell:
    curl http://localhost:8787/healthz

You should see `{"ok":true,...}`. Stop with Ctrl+C.

---

## 5. Run as a service with systemd

    sudo tee /etc/systemd/system/poolheat.service >/dev/null <<'EOF'
    [Unit]
    Description=Pool Heat Pi Bridge
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=pi
    WorkingDirectory=/home/pi/poolheat/pi-server
    EnvironmentFile=/etc/poolheat.env
    ExecStart=/usr/bin/node server.js
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF

    sudo systemctl daemon-reload
    sudo systemctl enable --now poolheat
    sudo systemctl status poolheat

Logs:

    journalctl -u poolheat -f

---

## 6. Expose to the internet via Cloudflare Tunnel

You need a domain in Cloudflare (e.g. `ocadventurehomes.com`). The tunnel gives you a public HTTPS URL like `https://poolpi.ocadventurehomes.com` with no port forwarding.

### 6a. Install cloudflared

    ARCH=$(dpkg --print-architecture)   # arm64 or armhf
    curl -L --output cloudflared.deb \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb
    sudo dpkg -i cloudflared.deb
    cloudflared --version

### 6b. Authenticate + create the tunnel

    cloudflared tunnel login        # opens a URL — paste in browser, pick your domain
    cloudflared tunnel create poolpi
    # note the Tunnel UUID it prints

### 6c. Route DNS to the tunnel

    cloudflared tunnel route dns poolpi poolpi.ocadventurehomes.com

### 6d. Configure ingress

    sudo mkdir -p /etc/cloudflared
    sudo tee /etc/cloudflared/config.yml >/dev/null <<EOF
    tunnel: poolpi
    credentials-file: /home/pi/.cloudflared/<TUNNEL-UUID>.json

    ingress:
      - hostname: poolpi.ocadventurehomes.com
        service: http://localhost:8787
      - service: http_status:404
    EOF

(Replace `<TUNNEL-UUID>` with the value from `tunnel create`.)

### 6e. Run it as a service

    sudo cloudflared service install
    sudo systemctl enable --now cloudflared
    sudo systemctl status cloudflared

Verify from anywhere:

    curl https://poolpi.ocadventurehomes.com/healthz

---

## 7. Hook it up to Lovable

In the Lovable app, add (or update) these secrets:

| Secret                          | Value                                          |
|---------------------------------|------------------------------------------------|
| `SCREENLOGIC_PI_URL`            | `https://poolpi.ocadventurehomes.com`          |
| `SCREENLOGIC_PI_AUTH_TOKEN`     | the same hex token from step 4                 |

Then in **Admin → Pool Control**, set each ScreenLogic home's controller type to *ScreenLogic*, paste the system name (e.g. `Pentair: 12-AB-CD`) and the ScreenLogic password, and click **Test pool**.

---

## Troubleshooting

- **`gatewayFound: false`** — your Pi is on a datacenter/VPN IP, or the system name is wrong. Check `curl ifconfig.me` from the Pi; it should be a residential ISP IP, not Cloudflare/AWS.
- **`401 unauthorized` from the Pi** — the Lovable secret `SCREENLOGIC_PI_AUTH_TOKEN` doesn't match `/etc/poolheat.env` on the Pi.
- **Tunnel returns 502** — `poolheat` service isn't running on port 8787. Check `sudo systemctl status poolheat`.
- **Set-point doesn't stick** — some Pentair systems require the heater mode to be on (not "Off") for the set-point to apply. Toggle the heater on once in the official ScreenLogic app, then retry.

## Updating

    cd ~/poolheat
    git pull
    cd pi-server
    npm install
    sudo systemctl restart poolheat
