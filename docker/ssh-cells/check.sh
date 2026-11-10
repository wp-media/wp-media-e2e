#!/usr/bin/env bash
# Proves the twin is in a variant: owners, modes, group membership, sudo's rule and logging, where
# `wp` is, the cells' cron and PHP limits, and a working WordPress login. Checks behaviour (sudo
# run as ubuntu, an HTTP login), not just files. Prints one line per check; exits 1 if any fails.
# Usage (as root in a running twin): check.sh <variant>
set -euo pipefail
# shellcheck source=lib.sh
. /opt/twin/lib.sh

variant="${1:-}"
variant_spec "$variant"
failures=0

# Records one check. Usage: check <description> <cmd…>   (passes when the command succeeds)
check() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  ✓ %s\n' "$what"
  else
    printf '  ✗ %s\n' "$what"
    failures=$((failures + 1))
  fi
}

# Succeeds when a command prints nothing. Usage: prints_nothing <cmd…>
prints_nothing() { [[ -z "$("$@")" ]]; }

# Succeeds when a command's output is exactly <expected>. Usage: prints <expected> <cmd…>
prints() {
  local expected="$1"
  shift
  [[ "$("$@" 2>&1)" == "$expected" ]]
}

# Runs a command as ubuntu through a fresh PAM session (current groups, pam_umask), as SSH does.
as_ubuntu() { su -s /bin/sh ubuntu -c "$1"; }

# Paths under the site whose owner:group differs from <owner:group>, wp-config.php left out when
# the variant gives it to root. Usage: wrong_owner <owner:group>
wrong_owner() {
  local skip=()
  ((V_WPCONFIG_ROOT)) && skip=(! -path "$TWIN_ROOT/wp-config.php")
  find "$TWIN_SITE_DIR" "${skip[@]}" \( ! -user "${1%%:*}" -o ! -group "${1##*:}" \) -print
}

# Paths of a type whose mode differs from <mode>. Usage: wrong_mode <d|f> <mode>
wrong_mode() {
  local skip=()
  ((V_WPCONFIG_ROOT)) && skip=(! -path "$TWIN_ROOT/wp-config.php")
  find "$TWIN_SITE_DIR" "${skip[@]}" -type "$1" ! -perm "$2" -print
}

# Succeeds when <user> is a member of <group>, as a new login would see it. Usage: in_group <user> <group>
in_group() { [[ " $(id -nG "$1") " == *" $2 "* ]]; }

# Succeeds when ubuntu's sudo, run as www-data, logs (or not, per V_LOG_ALLOWED) its command line.
# Unique marker arguments tell these calls' entries from others. A refused call (a group www-data
# is not in) is logged whatever `log_allowed` says: the control proving the log is written at all.
sudo_logging_as_expected() {
  local marker="twin-log-probe-$RANDOM$RANDOM" control="twin-log-control-$RANDOM$RANDOM"
  as_ubuntu "sudo -n -u www-data -g root -- /bin/echo $control" >/dev/null 2>&1 && return 1
  grep -q "$control" "$TWIN_SUDO_LOG" || return 1
  as_ubuntu "sudo -n -u www-data -g www-data -- /bin/echo $marker" >/dev/null || return 1
  if ((V_LOG_ALLOWED)); then
    grep -q "$marker" "$TWIN_SUDO_LOG"
  else
    if grep -q "$marker" "$TWIN_SUDO_LOG"; then return 1; fi
  fi
}

# Succeeds when the umask of every process of a command is <mask>. Usage: umask_of <comm> <mask>
umask_of() {
  local pid found=0
  for pid in $(pgrep -x "$1"); do
    found=1
    grep -qx "Umask:[[:space:]]*$2" "/proc/$pid/status" || return 1
  done
  ((found))
}

# Logs in through wp-login.php with curl and loads the dashboard: WordPress, PHP-FPM, the web
# server, the database and the login all work together.
wordpress_login_works() {
  local jar body
  jar="$(mktemp)"
  curl -fsS -o /dev/null -c "$jar" -b 'wordpress_test_cookie=WP%20Cookie%20check' \
    --data-urlencode "log=${TWIN_ADMIN_USER}" --data-urlencode "pwd=${TWIN_ADMIN_PASSWORD}" \
    -d testcookie=1 "${TWIN_SITE_URL}/wp-login.php" || { rm -f "$jar"; return 1; }
  body="$(curl -fsS -b "$jar" "${TWIN_SITE_URL}/wp-admin/")" || { rm -f "$jar"; return 1; }
  rm -f "$jar"
  [[ "$body" == *'id="wpadminbar"'* ]]
}

# Succeeds when every line is in a command's output. Output is captured first: with pipefail, a
# `grep -q` closing the pipe early would fail the producer. Usage: output_has <cmd> -- <line…>
output_has() {
  local cmd=() out line
  while [[ "$1" != -- ]]; do cmd+=("$1"); shift; done
  shift
  out="$("${cmd[@]}" 2>&1)" || return 1
  for line in "$@"; do
    grep -qxF -- "$line" <<<"$out" || return 1
  done
}

# Succeeds when PHP-FPM's own configuration allows 64M uploads.
fpm_allows_64m_uploads() {
  output_has "php-fpm${TWIN_PHP}" -i -- 'upload_max_filesize => 64M => 64M' 'post_max_size => 64M => 64M'
}

# Succeeds when sshd's effective configuration takes keys only, from ubuntu only.
sshd_key_only() {
  output_has sshd -T -- 'passwordauthentication no' 'kbdinteractiveauthentication no' \
    'pubkeyauthentication yes' 'permitrootlogin no' 'allowusers ubuntu'
}

# Succeeds when nginx's effective configuration allows 64M request bodies.
nginx_allows_64m_bodies() {
  local out
  out="$(nginx -T 2>&1)" || return 1
  grep -Eq '^[[:space:]]*client_max_body_size 64m;' <<<"$out"
}

# Succeeds when no process runs outside the twin's own and its services' (logins, cron jobs and
# PHP work running now are under those): nothing from before the last reset survived.
no_stray_processes() {
  local roots=() file
  for file in "$(fpm_pidfile)" "$(web_pidfile)" /run/sshd.pid /run/crond.pid; do
    [[ -s "$file" ]] && roots+=("$(<"$file")")
  done
  [[ -z "$(stray_pids "${roots[@]}")" ]]
}

# Succeeds when ubuntu's crontab requests the site's wp-cron.php every minute.
cron_requests_wp_cron() {
  output_has crontab -u ubuntu -l -- \
    "* * * * * curl -fsS -o /dev/null --max-time 50 '${TWIN_SITE_URL}/wp-cron.php?doing_wp_cron'"
}

# Succeeds when wp-config.php defines <constant> with exactly <value>. Usage: wp_constant <name> <value>
wp_constant() { [[ "$(wp_web config get "$1")" == "$2" ]]; }

# Succeeds when wp-config.php does not define <constant>. Usage: wp_constant_absent <name>
wp_constant_absent() { ! wp_web config has "$1"; }

echo "Checking variant ${variant} (${TWIN_STACK})"

check "every path under ${TWIN_SITE_DIR} is ${V_OWNER}" prints_nothing wrong_owner "$V_OWNER"
check "every directory is ${V_DIR_MODE}" prints_nothing wrong_mode d "$V_DIR_MODE"
check "every file is ${V_FILE_MODE}" prints_nothing wrong_mode f "$V_FILE_MODE"
if ((V_WPCONFIG_ROOT)); then
  check "wp-config.php is root:www-data 644" prints "root:www-data 644" stat -c '%U:%G %a' "$TWIN_ROOT/wp-config.php"
fi

if ((V_IN_GROUP)); then
  check "ubuntu is in www-data" in_group ubuntu www-data
else
  check "ubuntu is outside www-data" eval '! in_group ubuntu www-data'
fi
check "sftp_twin is in www-data" in_group sftp_twin www-data

check "sudoers parse" visudo -cq
# The sudo checks compare whole outputs, so they also prove sudo adds no "unable to resolve host" line.
if ((V_SUDO)); then
  # shellcheck disable=SC2016 # expanded by the shell sudo runs
  check "ubuntu: sudo -n -u www-data -g www-data runs as 33:33" \
    prints "33:33" as_ubuntu 'sudo -n -u www-data -g www-data -- sh -c "echo \$(id -u):\$(id -g)"'
  # F3: pam_umask gives sudo's www-data 0002, whatever the caller's; the suite's wrapper resets it.
  check "sudo's umask for www-data is 0002" prints "0002" as_ubuntu 'umask 077; sudo -n -u www-data -g www-data -- sh -c umask'
  if ((V_LOG_ALLOWED)); then
    check "sudo logs ubuntu's command lines (no !log_allowed)" sudo_logging_as_expected
  else
    check "sudo keeps ubuntu's command lines out of its log (!log_allowed)" sudo_logging_as_expected
  fi
else
  check "ubuntu's sudo -n is refused: a password is required" \
    prints "sudo: a password is required" as_ubuntu 'sudo -n -u www-data -g www-data -- true'
fi

if ((V_WP_HOME)); then
  check "wp is in ~ubuntu/bin only" eval '[ -x /home/ubuntu/bin/wp ] && [ ! -e /usr/local/bin/wp ]'
  if ((V_SUDO)); then
    check "wp is off sudo's secure_path" eval "! as_ubuntu 'sudo -n -u www-data -g www-data -- sh -c \"command -v wp\"'"
  fi
else
  check "wp is /usr/local/bin/wp only" eval '[ -x /usr/local/bin/wp ] && [ ! -e /home/ubuntu/bin ]'
fi

check "WordPress is installed at ${TWIN_SITE_URL}" prints "$TWIN_SITE_URL" wp_web option get siteurl
check "WP_DEBUG and WP_DEBUG_LOG on, WP_DEBUG_DISPLAY off" \
  eval 'wp_constant WP_DEBUG 1 && wp_constant WP_DEBUG_LOG 1 && wp_constant WP_DEBUG_DISPLAY ""'
check "WP_MAX_MEMORY_LIMIT is 512M" wp_constant WP_MAX_MEMORY_LIMIT 512M
if [[ "$TWIN_STACK" == nginx ]]; then
  check "DISABLE_WP_CRON is on" wp_constant DISABLE_WP_CRON 1
  check "ubuntu's crontab requests wp-cron.php every minute" cron_requests_wp_cron
  check "PHP CLI memory_limit is -1" prints "-1" php -r 'echo ini_get("memory_limit");'
  check "no .htaccess" test ! -e "$TWIN_ROOT/.htaccess"
  check "nginx allows 64M request bodies" nginx_allows_64m_bodies
else
  check "DISABLE_WP_CRON is not defined" wp_constant_absent DISABLE_WP_CRON
  check "ubuntu has no crontab" eval '! crontab -u ubuntu -l'
  check "PHP CLI memory_limit is 256M" prints "256M" php -r 'echo ini_get("memory_limit");'
  check ".htaccess holds WordPress's rewrite rules" grep -q '^# BEGIN WordPress' "$TWIN_ROOT/.htaccess"
fi
check "PHP-FPM allows 64M uploads" fpm_allows_64m_uploads
# PHP writes the site's files, so its umask is the one that counts (nginx resets its own to 0000).
check "PHP-FPM runs with umask 0022" umask_of "php-fpm${TWIN_PHP}" 0022
check "no process from before the reset survived" no_stray_processes
check "sshd: key-only, ubuntu only" sshd_key_only
check "a WordPress login reaches the dashboard" wordpress_login_works

if ((failures)); then
  die "${failures} check(s) failed for variant ${variant}"
fi
echo "✓ Variant ${variant} (${TWIN_STACK})"
