#!/usr/bin/env bash
# Container entrypoint (under tini, which reaps the orphans killed runs leave): starts the services,
# makes the site unless a previous boot verified one (variant $TWIN_VARIANT, default legacy-777)
# and waits; on SIGTERM/SIGINT stops PHP and the web server at once so the database still shuts
# down cleanly within `docker stop`'s grace period.
#
# Container environment, besides lib.sh's:
#   TWIN_AUTHORIZED_KEY  the public key `ubuntu` logs in with (one line). Without it SSH refuses all.
#   TWIN_VARIANT         the variant made when no verified site exists
set -euo pipefail
# shellcheck source=lib.sh
. /opt/twin/lib.sh

# Stops every service, the database last so it flushes.
shutdown() {
  say "Stopping"
  rm -f "$TWIN_READY"
  stop_access
  stop_web
  stop_fpm
  stop_db
  exit 0
}

# Installs $TWIN_AUTHORIZED_KEY as ubuntu's only key, refusing anything but one public-key line;
# without one, removes any key a previous boot installed.
install_key() {
  local ssh_dir=/home/ubuntu/.ssh
  if [[ -z "${TWIN_AUTHORIZED_KEY:-}" ]]; then
    rm -f "$ssh_dir/authorized_keys"
    echo "⚠ TWIN_AUTHORIZED_KEY is not set: SSH will refuse every login." >&2
    return
  fi
  [[ "$TWIN_AUTHORIZED_KEY" != *$'\n'* ]] || die "TWIN_AUTHORIZED_KEY must be one line"
  printf '%s\n' "$TWIN_AUTHORIZED_KEY" | ssh-keygen -l -f - >/dev/null 2>&1 \
    || die "TWIN_AUTHORIZED_KEY is not a public key"
  install -d -o ubuntu -g ubuntu -m 0700 "$ssh_dir"
  printf '%s\n' "$TWIN_AUTHORIZED_KEY" >"$ssh_dir/authorized_keys"
  chown ubuntu:ubuntu "$ssh_dir/authorized_keys"
  chmod 0600 "$ssh_dir/authorized_keys"
}

# Makes the container's hostname resolve, as on the cells: an unresolvable one adds a line to the
# stderr of every sudo call. (Docker already writes it; this keeps it true under other runtimes.)
resolve_hostname() {
  getent hosts "$(hostname)" >/dev/null || echo "127.0.0.1 $(hostname)" >>/etc/hosts
}

# Creates the site's database account (idempotent; the database itself is site.sh's).
ensure_db_user() {
  db -e "CREATE USER IF NOT EXISTS '${TWIN_DB_USER}'@'localhost' IDENTIFIED BY '${TWIN_DB_PASSWORD}';
         GRANT ALL PRIVILEGES ON \`${TWIN_DB_NAME}\`.* TO '${TWIN_DB_USER}'@'localhost';"
}

# Empties what /run keeps across `docker restart`: a stale pid file would name a reused pid, a
# stale ready marker would report a site no one checked.
clear_run_state() {
  rm -rf "$TWIN_RUN"
  rm -f /run/sshd.pid /run/crond.pid /run/nginx.pid /var/run/apache2/apache2.pid /run/php/*.pid
  install -d -m 0755 "$TWIN_RUN"
  echo $$ >"$TWIN_START_PID"
}

validate_env
clear_run_state
trap shutdown TERM INT
install_key
resolve_hostname
ssh-keygen -A >/dev/null
install -d -m 0755 /run/sshd
say "Starting the database"
start_db
ensure_db_user
if [[ -s "$TWIN_VERIFIED" ]]; then
  # Runs since the last reset may have changed the site, so no check here: site.sh starts clean.
  say "Keeping the site verified as '$(<"$TWIN_VERIFIED")'"
  say "Starting PHP-FPM, ${TWIN_STACK}, cron and logins"
  start_fpm
  start_web
  start_access
  touch "$TWIN_READY"
else
  "$TWIN_HOME/site.sh" "${TWIN_VARIANT:-legacy-777}"
fi
say "Ready: ${TWIN_SITE_URL}"

# `wait` returns on a trapped signal; sleep in the background so the trap runs at once.
sleep infinity &
wait $!
