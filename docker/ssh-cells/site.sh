#!/usr/bin/env bash
# Resets the twin to a variant, then proves it with check.sh. Usage (as root in a running twin):
#   site.sh <variant>   — variants: lib.sh's variant_spec.
#
# Nothing a previous run left survives: logins and cron stop first (so no session keeps the old
# groups), every process outside the twin's own is killed (root children of sudo included), and the
# database, the docroot, crontabs, extra sudoers files and databases, /tmp, /var/tmp, ubuntu's home
# and the sudo log are emptied. Only `docker exec` sessions are spared (this one, an operator's).
# One reset at a time; a reset cut short leaves no verified marker, so the next boot redoes it.
set -euo pipefail
# shellcheck source=lib.sh
. /opt/twin/lib.sh

variant="${1:-}"
variant_spec "$variant"
validate_env
install -d -m 0755 "$TWIN_RUN"
exec 9>"$TWIN_LOCK"
flock -n 9 || die "Another reset is running"
rm -f "$TWIN_VERIFIED" "$TWIN_READY"

say "Stopping logins, cron, PHP and ${TWIN_STACK}; killing what runs outside the twin"
stop_access
stop_web
stop_fpm
# Twice: a process forking while the first pass runs is caught by the second.
for _ in 1 2; do
  # shellcheck disable=SC2119 # no extra trees to keep: every service is stopped
  mapfile -t strays < <(stray_pids)
  ((${#strays[@]} == 0)) || kill -KILL "${strays[@]}" 2>/dev/null || true
done

say "Clearing what runs leave outside the docroot"
find /var/spool/cron/crontabs -mindepth 1 -delete
for name in /etc/sudoers.d/*; do
  [[ " ${TWIN_SUDOERS_KEEP} " == *" ${name##*/} "* ]] || rm -f -- "$name"
done
find /tmp /var/tmp /var/lib/php/sessions -mindepth 1 -delete 2>/dev/null || true
find /home/ubuntu -mindepth 1 -maxdepth 1 \
  ! -name .ssh ! -name .bashrc ! -name .profile ! -name .bash_logout -exec rm -rf -- {} +
find /var/www -mindepth 1 -maxdepth 1 ! -name html -exec rm -rf -- {} +
: >"$TWIN_SUDO_LOG"
for name in $(db -N -e 'SHOW DATABASES'); do
  [[ " ${TWIN_SYSTEM_DBS} " == *" ${name} "* ]] || db -e "DROP DATABASE \`${name}\`"
done

say "Fresh WordPress (${TWIN_STACK})"
db -e "CREATE DATABASE \`${TWIN_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
install -d -m 0755 "$TWIN_ROOT"
cp -a "$TWIN_HOME/wordpress/." "$TWIN_ROOT/"
wp_root config create --dbname="$TWIN_DB_NAME" --dbuser="$TWIN_DB_USER" \
  --dbpass="$TWIN_DB_PASSWORD" --dbhost=localhost --skip-check --quiet
wp_root config set WP_DEBUG true --raw --quiet
wp_root config set WP_DEBUG_LOG true --raw --quiet
wp_root config set WP_DEBUG_DISPLAY false --raw --quiet
# Without a finite limit every foreground `wp backwpup run` dies of the one it sets itself.
wp_root config set WP_MAX_MEMORY_LIMIT 512M --quiet
# A docroot another account owns: without it WordPress picks FTP for every web-side write.
if ((V_FS_DIRECT)); then wp_root config set FS_METHOD direct --quiet; fi
wp_root core install --url="$TWIN_SITE_URL" --title=twin --admin_user="$TWIN_ADMIN_USER" \
  --admin_password="$TWIN_ADMIN_PASSWORD" --admin_email=qa@example.test --skip-email --quiet

# Cron as on the cells: nginx sets DISABLE_WP_CRON and a system cron requests wp-cron.php every
# minute; apache spawns WP-Cron from page loads.
if [[ "$TWIN_STACK" == nginx ]]; then
  wp_root config set DISABLE_WP_CRON true --raw --quiet
  echo "* * * * * curl -fsS -o /dev/null --max-time 50 '${TWIN_SITE_URL}/wp-cron.php?doing_wp_cron'" \
    | crontab -u ubuntu -
  wp_root rewrite structure '/%postname%/' --quiet
  rm -f "$TWIN_ROOT/.htaccess"
else
  WP_CLI_CONFIG_PATH="$TWIN_HOME/wp-cli.yml" wp_root rewrite structure '/%postname%/' --hard --quiet
fi

say "WP-CLI for ubuntu: $(if ((V_WP_HOME)); then echo "only \$HOME/bin"; else echo /usr/local/bin; fi)"
rm -rf /home/ubuntu/bin /usr/local/bin/wp
if ((V_WP_HOME)); then
  install -d -o ubuntu -g ubuntu -m 0755 /home/ubuntu/bin
  install -o ubuntu -g ubuntu -m 0755 "$TWIN_HOME/wp-cli.phar" /home/ubuntu/bin/wp
else
  install -m 0755 "$TWIN_HOME/wp-cli.phar" /usr/local/bin/wp
fi

say "Ownership ${V_OWNER}, modes ${V_DIR_MODE}/${V_FILE_MODE}"
chown -R "$V_OWNER" "$TWIN_SITE_DIR"
find "$TWIN_SITE_DIR" -type d -exec chmod "$V_DIR_MODE" {} +
find "$TWIN_SITE_DIR" -type f -exec chmod "$V_FILE_MODE" {} +
if ((V_WPCONFIG_ROOT)); then
  chown root:www-data "$TWIN_ROOT/wp-config.php"
  chmod 0644 "$TWIN_ROOT/wp-config.php"
fi

say "ubuntu $(if ((V_IN_GROUP)); then echo in; else echo outside; fi) www-data"
if ((V_IN_GROUP)); then
  usermod -aG www-data ubuntu
else
  gpasswd -d ubuntu www-data >/dev/null 2>&1 || true
fi

if ((!V_SUDO)); then sudo_rule=none; elif ((V_LOG_ALLOWED)); then sudo_rule='(ALL)'; else sudo_rule='(ALL) + !log_allowed'; fi
say "sudoers for ubuntu: ${sudo_rule}"
if ((V_SUDO)); then
  tmp="$(mktemp)"
  echo 'ubuntu ALL=(ALL) NOPASSWD: ALL' >"$tmp"
  ((V_LOG_ALLOWED)) || echo 'Defaults:ubuntu !log_allowed' >>"$tmp"
  visudo -cqf "$tmp" || die "Generated sudoers rejected by visudo"
  install -o root -g root -m 0440 "$tmp" "$TWIN_SUDOERS"
  rm -f "$tmp"
else
  rm -f "$TWIN_SUDOERS"
fi
visudo -cq || die "sudoers rejected by visudo"

say "Starting PHP, ${TWIN_STACK}, cron and logins"
# 9>&-: the daemons must not inherit the reset lock and hold it for ever.
start_fpm 9>&-
start_web 9>&-
start_access 9>&-
"$TWIN_HOME/check.sh" "$variant"
echo "$variant" >"$TWIN_VERIFIED"
touch "$TWIN_READY"
