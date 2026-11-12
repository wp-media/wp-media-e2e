#!/usr/bin/env bash
# Shared by start.sh, site.sh and check.sh (sourced, never run): the twin's paths, its variants and
# its services. Everything here runs as root inside a twin container.
#
# Image environment (set by the Dockerfile):
#   TWIN_STACK      apache | nginx
#   TWIN_PHP        the PHP minor (8.3 | 8.5)
# Container environment (optional; validated by validate_env):
#   TWIN_HTTP_PORT  port the site answers on inside the container, besides 80 (default 80). Publish
#                   it on the same host port, so the site URL works from the host and from inside
#                   (WordPress's loopback requests, the system cron).
#   TWIN_SITE_URL   WordPress's URL (default http://localhost:$TWIN_HTTP_PORT)
#   TWIN_ADMIN_USER / TWIN_ADMIN_PASSWORD   the WordPress login (default admin / twin-admin-password)

# The constants and V_* are read by the scripts that source this file.
# shellcheck disable=SC2034
true

: "${TWIN_STACK:?TWIN_STACK is not set: run inside a twin image}"
: "${TWIN_PHP:?TWIN_PHP is not set: run inside a twin image}"

readonly TWIN_HOME=/opt/twin
readonly TWIN_SITE_DIR=/var/www/site
readonly TWIN_ROOT=/var/www/site/public
readonly TWIN_SUDOERS=/etc/sudoers.d/90-ubuntu
# The image's own sudoers files; a reset removes any other.
readonly TWIN_SUDOERS_KEEP="README 00-twin-log 90-ubuntu"
# Every sudo call is logged here (sudoers.d/00-twin-log), so `!log_allowed` can be observed: a
# container has no syslog, where the cells' sudo writes.
readonly TWIN_SUDO_LOG=/var/log/sudo-twin.log
# Run-time state, emptied at every boot (/run survives `docker restart`).
readonly TWIN_RUN=/run/twin
readonly TWIN_READY=/run/twin/ready
readonly TWIN_START_PID=/run/twin/start.pid
readonly TWIN_LOCK=/run/twin/site.lock
# The variant the site was last made as, written only once check.sh proved it: a reset cut short
# leaves none, and the next boot makes the site again.
readonly TWIN_VERIFIED=/opt/twin/verified
readonly TWIN_VARIANTS="legacy-777 site site-775 no-sudo owner-mismatch no-wp wpconfig-root"
readonly TWIN_DB_NAME=wp TWIN_DB_USER=wp TWIN_DB_PASSWORD=wp
# Databases a reset keeps; every other one is a run's leftover.
readonly TWIN_SYSTEM_DBS="information_schema mysql performance_schema sys"
TWIN_HTTP_PORT="${TWIN_HTTP_PORT:-80}"
TWIN_SITE_URL="${TWIN_SITE_URL:-http://localhost:${TWIN_HTTP_PORT}}"
TWIN_ADMIN_USER="${TWIN_ADMIN_USER:-admin}"
TWIN_ADMIN_PASSWORD="${TWIN_ADMIN_PASSWORD:-twin-admin-password}"

# Prints a step. Usage: say <text>
say() { printf '→ %s\n' "$*"; }

# Prints an error and exits 1. Usage: die <text>
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# Refuses container settings that would break a reset late or land unquoted in a crontab, a
# config file or a URL: a port, a plain http(s) origin, a login and password of safe characters.
validate_env() {
  if ! [[ "$TWIN_HTTP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || ((TWIN_HTTP_PORT > 65535)); then
    die "TWIN_HTTP_PORT must be a port number, got '${TWIN_HTTP_PORT}'"
  fi
  [[ "$TWIN_SITE_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
    || die "TWIN_SITE_URL must be http(s)://host[:port] with no path, got '${TWIN_SITE_URL}'"
  [[ "$TWIN_ADMIN_USER" =~ ^[A-Za-z0-9._-]{1,60}$ ]] \
    || die "TWIN_ADMIN_USER may hold only letters, digits, '.', '_' and '-'"
  [[ "$TWIN_ADMIN_PASSWORD" =~ ^[A-Za-z0-9._@%+=-]{8,128}$ ]] \
    || die "TWIN_ADMIN_PASSWORD must be 8-128 of letters, digits and ._@%+=-"
}

# WP-CLI as root, for site.sh only, and only while the site is the pristine copy it just made and
# nobody else can write it: root runs the site's PHP (wp-config.php, plugins, mu-plugins).
# Usage: wp_root <args…>
wp_root() { php "$TWIN_HOME/wp-cli.phar" --allow-root --path="$TWIN_ROOT" "$@"; }

# WP-CLI as the web server's user, for anything after the site is handed over: whatever a run
# wrote into the docroot then runs with no more rights than the web server already gives it.
# Usage: wp_web <args…>
wp_web() {
  runuser -u www-data -- env HOME=/var/www php "$TWIN_HOME/wp-cli.phar" --path="$TWIN_ROOT" "$@"
}

# Sets the V_* description of a variant, or dies naming the valid ones.
#   V_OWNER          docroot owner:group
#   V_DIR_MODE/V_FILE_MODE   octal modes of every directory/file under the site
#   V_IN_GROUP       1 when `ubuntu` is in www-data
#   V_SUDO           1 when `ubuntu` has passwordless sudo `(ALL)`
#   V_LOG_ALLOWED    1 when sudo logs `ubuntu`'s allowed commands (no `!log_allowed`). Only
#                    owner-mismatch: every other variant isolates one condition.
#   V_WP_HOME        1 when `wp` is only in ~ubuntu/bin (off sudo's secure_path)
#   V_WPCONFIG_ROOT  1 when wp-config.php is root:www-data 644
#   V_FS_DIRECT      1 when wp-config.php defines FS_METHOD 'direct': derived, set whenever the
#                    docroot is not the web server's. WordPress's own check then answers `ftpext`
#                    (the ftp extension is loaded), and every web-side write through WP_Filesystem
#                    dies on an unconnected FTP handle (BackWPup's background start among them). A
#                    real site deployed by another account needs it too (a QA site defines it).
# Usage: variant_spec <name>
variant_spec() {
  V_OWNER=www-data:www-data V_DIR_MODE=755 V_FILE_MODE=644 V_IN_GROUP=0 V_SUDO=1 V_LOG_ALLOWED=0
  V_WP_HOME=0 V_WPCONFIG_ROOT=0
  case "${1:-}" in
    legacy-777) V_OWNER=sftp_twin:www-data V_DIR_MODE=777 V_FILE_MODE=777 V_IN_GROUP=1 ;;
    site) ;;
    site-775) V_DIR_MODE=775 V_FILE_MODE=664 V_IN_GROUP=1 ;;
    no-sudo) V_DIR_MODE=777 V_FILE_MODE=777 V_IN_GROUP=1 V_SUDO=0 ;;
    owner-mismatch) V_OWNER=sftp_twin:www-data V_DIR_MODE=775 V_FILE_MODE=664 V_IN_GROUP=1 V_LOG_ALLOWED=1 ;;
    no-wp) V_WP_HOME=1 ;;
    wpconfig-root) V_WPCONFIG_ROOT=1 ;;
    *) die "Unknown variant '${1:-}'. One of: ${TWIN_VARIANTS}" ;;
  esac
  V_FS_DIRECT=0
  [[ "${V_OWNER%%:*}" == www-data ]] || V_FS_DIRECT=1
}

# Polls a command until it succeeds, or dies after <secs>. Usage: wait_for <what> <secs> <cmd…>
wait_for() {
  local what="$1" deadline=$((SECONDS + $2))
  shift 2
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || die "Timed out waiting for ${what}"
    sleep 1
  done
}

# Waits for a process to exit, then kills it if it has not after <secs>. Usage: wait_gone <pid> <secs>
wait_gone() {
  local deadline=$((SECONDS + $2))
  while kill -0 "$1" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      kill -KILL "$1" 2>/dev/null || true
      return
    fi
    sleep 0.2
  done
}

# Sends a signal to the process a pid file names, waits up to 5 s for it to exit (then kills it)
# and removes the file; a no-op without one. Stops are quick on purpose: `docker stop` allows 10 s,
# and the database must still shut down cleanly after PHP and the web server.
# Usage: stop_pidfile <pidfile> <signal>
stop_pidfile() {
  local pid
  [[ -s "$1" ]] || return 0
  pid="$(<"$1")"
  rm -f "$1"
  kill "-$2" "$pid" 2>/dev/null || return 0
  wait_gone "$pid" 5
}

# The database daemon's admin client (root over the socket). Usage: db <client args…>
db() { mysql --protocol=socket -uroot "$@"; }

# Starts the database and waits until it answers. MariaDB (apache) and MySQL (nginx) both ship
# mysqld_safe, which restarts mysqld if it dies. Its output goes to /var/log/twin-db.log (MariaDB's
# packaging would send it to a syslog the container does not run).
start_db() {
  local syslog=()
  [[ "$TWIN_STACK" == apache ]] && syslog=(--skip-syslog)
  install -d -o mysql -g mysql -m 0755 /run/mysqld
  (umask 022 && exec setsid mysqld_safe --user=mysql "${syslog[@]}" >>/var/log/twin-db.log 2>&1 &)
  wait_for "the database (see /var/log/twin-db.log)" 60 mysqladmin --protocol=socket -uroot ping
}

# Stops the database cleanly (it flushes on shutdown) and waits for mysqld_safe to end.
stop_db() {
  mysqladmin --protocol=socket -uroot shutdown 2>/dev/null || true
  local pid
  for pid in $(pgrep -x mysqld_safe); do wait_gone "$pid" 20; done
}

# PHP-FPM's pid file, passed explicitly: the PPA's php-fpm.conf names none.
fpm_pidfile() { echo "/run/php/php${TWIN_PHP}-fpm.pid"; }

# Starts PHP-FPM with umask 022, as systemd starts it on the cells (its unit sets no UMask).
start_fpm() {
  install -d -m 0755 /run/php
  (umask 022 && exec "php-fpm${TWIN_PHP}" --daemonize --pid "$(fpm_pidfile)")
  wait_for "PHP-FPM" 20 test -S "/run/php/php${TWIN_PHP}-fpm.sock"
}

# Stops PHP-FPM at once (TERM), in-flight requests included.
stop_fpm() { stop_pidfile "$(fpm_pidfile)" TERM; }

# The web server's pid file.
web_pidfile() {
  if [[ "$TWIN_STACK" == apache ]]; then echo /var/run/apache2/apache2.pid; else echo /run/nginx.pid; fi
}

# Starts the web server with umask 022 (as systemd does; nginx resets its own to 0000), listening on
# 80 and $TWIN_HTTP_PORT.
start_web() {
  if [[ "$TWIN_STACK" == apache ]]; then
    {
      echo "Listen 80"
      [[ "$TWIN_HTTP_PORT" == 80 ]] || echo "Listen ${TWIN_HTTP_PORT}"
    } >/etc/apache2/ports.conf
    (umask 022 && exec apachectl start)
  else
    if [[ "$TWIN_HTTP_PORT" == 80 ]]; then
      : >/etc/nginx/twin-listen.conf
    else
      echo "listen ${TWIN_HTTP_PORT};" >/etc/nginx/twin-listen.conf
    fi
    (umask 022 && exec nginx)
  fi
  wait_for "the web server" 20 curl -fs -o /dev/null "http://127.0.0.1:${TWIN_HTTP_PORT}/wp-includes/images/blank.gif"
}

# Stops the web server at once (TERM: both drop open connections).
stop_web() { stop_pidfile "$(web_pidfile)" TERM; }

# Starts cron and sshd: what lets anything but root in.
start_access() {
  cron
  /usr/sbin/sshd
}

# Stops sshd (its listener and, with it, new logins) and cron; open sessions are stray_pids'.
stop_access() {
  stop_pidfile /run/sshd.pid TERM
  stop_pidfile /run/crond.pid TERM
}

# Prints the pid of every process that is neither the twin's own nor a `docker exec` session's:
# whatever logins, cron, sudo or PHP left behind, root children of sudo and orphans included.
# Kept: pid 1 (tini), start.sh's tree, mysqld_safe's tree, the trees of <keep-pid…> (running
# services, for check.sh), and every tree rooted outside pid 1 (a `docker exec`, this script too).
# Usage: stray_pids [keep-pid…]
stray_pids() {
  local -A parent keep
  local pid ppid p
  while read -r pid ppid; do parent[$pid]=$ppid; done < <(ps -eo pid=,ppid=)
  for p in "$@" $(cat "$TWIN_START_PID" 2>/dev/null) $(pgrep -x mysqld_safe); do keep[$p]=1; done
  for pid in "${!parent[@]}"; do
    [[ "$pid" == 1 ]] && continue
    p=$pid
    # Walk up to a kept tree (keep), pid 1 (stray) or a root outside pid 1 (docker exec: keep).
    while [[ -z "${keep[$p]:-}" && "$p" != 1 && -n "${parent[$p]:-}" && "${parent[$p]}" != 0 ]]; do
      p=${parent[$p]}
    done
    if [[ "$p" == 1 ]]; then echo "$pid"; fi
  done
}
