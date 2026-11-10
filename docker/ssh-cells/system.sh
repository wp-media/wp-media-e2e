#!/usr/bin/env bash
# Build step, once per image: the host as the cells have it, minus what only exists at run time
# (services, the SSH key, ports: start.sh) and the site itself (site.sh).
set -euo pipefail
# shellcheck source=lib.sh
. /opt/twin/lib.sh

say "Users"
# ubuntu:24.04 already has `ubuntu` (uid 1000, bash, in `sudo` as on cloud images); keep it if so.
id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu
# Key-only: `*` matches no password, and unlike `!` does not lock the account for key logins.
usermod -p '*' ubuntu
# A deployment account in the web group: owns the legacy and owner-mismatch docroots.
groupadd -g 1002 sftp_twin
useradd -u 1002 -g 1002 -G www-data -s /usr/sbin/nologin -d /nonexistent -M sftp_twin
# A login shell reads ~/.profile, which puts ~/bin on PATH; a command over SSH runs non-interactive
# bash, which reads only ~/.bashrc (Debian's SSH_SOURCE_BASHRC), and that returns at once unless
# interactive. Prepend ~/bin first, so the no-wp variant's `wp` is found over SSH as on hosts
# where WP-CLI was installed per user.
bashrc=/home/ubuntu/.bashrc
# shellcheck disable=SC2016 # written literally into .bashrc
{
  echo '# Twin: ~/bin on PATH for non-interactive SSH commands too.'
  echo '[ -d "$HOME/bin" ] && case ":$PATH:" in *":$HOME/bin:"*) ;; *) PATH="$HOME/bin:$PATH" ;; esac'
  cat "$bashrc"
} >"$bashrc.new"
mv "$bashrc.new" "$bashrc"
chown ubuntu:ubuntu "$bashrc"

say "sshd: key-only, ubuntu only"
cat >/etc/ssh/sshd_config.d/10-twin.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers ubuntu
UsePAM yes
EOF
# Host keys are made per container (start.sh), never baked into a shared image.
rm -f /etc/ssh/ssh_host_*

say "sudo: log every call to a file (no syslog in a container)"
cat >/etc/sudoers.d/00-twin-log <<EOF
Defaults logfile=${TWIN_SUDO_LOG}
EOF
chmod 0440 /etc/sudoers.d/00-twin-log
visudo -cq

say "PHP ${TWIN_PHP}"
# Upload limits the suite's plugin zips and backups need.
printf 'upload_max_filesize = 64M\npost_max_size = 64M\n' >"/etc/php/${TWIN_PHP}/fpm/conf.d/99-twin.ini"
# The CLI's memory limit as on the cells: unlimited on nginx, 256M on apache. It decides whether
# BackWPup's foreground runs die of the limit they set themselves.
if [[ "$TWIN_STACK" == nginx ]]; then cli_memory=-1; else cli_memory=256M; fi
printf 'memory_limit = %s\n' "$cli_memory" >"/etc/php/${TWIN_PHP}/cli/conf.d/99-twin.ini"

say "Web server: ${TWIN_STACK}"
if [[ "$TWIN_STACK" == apache ]]; then
  a2dissite -q 000-default
  install -m 0644 /opt/twin/conf/apache-site.conf /etc/apache2/sites-available/twin.conf
  a2ensite -q twin
  a2enmod -q proxy_fcgi setenvif rewrite headers expires deflate
  a2enconf -q "php${TWIN_PHP}-fpm"
  echo 'ServerName localhost' >/etc/apache2/conf-available/twin-servername.conf
  a2enconf -q twin-servername
else
  rm -f /etc/nginx/sites-enabled/default
  install -m 0644 /opt/twin/conf/nginx-site.conf /etc/nginx/sites-available/twin
  ln -s /etc/nginx/sites-available/twin /etc/nginx/sites-enabled/twin
  : >/etc/nginx/twin-listen.conf
  nginx -t -q
fi

say "WP-CLI config for site.sh's root runs on apache: lets 'wp rewrite --hard' write .htaccess"
printf 'apache_modules:\n  - mod_rewrite\n' >"$TWIN_HOME/wp-cli.yml"

chmod 0755 "$TWIN_HOME"/*.sh
