#!/usr/bin/env bash
# First-time hardening of a fresh Ubuntu/Debian VPS. Run as root AFTER you can log in with an SSH key from a second terminal.
#  - firewall: only SSH (22) and web (80/443) are open
#  - fail2ban: bans IPs that keep guessing SSH passwords
#  - SSH: password login OFF, root login with key only
#  - unattended security updates
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -s /root/.ssh/authorized_keys ] || { echo "No SSH key in /root/.ssh/authorized_keys. Add your key first, or you will lock yourself out."; exit 1; }
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ufw fail2ban unattended-upgrades
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'CONF'
PasswordAuthentication no
PermitRootLogin prohibit-password
CONF
systemctl reload ssh || systemctl reload sshd
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades
echo "Hardening done. Keep this terminal open and test a NEW ssh login before closing it."
