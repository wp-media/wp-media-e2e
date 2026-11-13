#!/usr/bin/env bash
# The SSH twins from the host: `npm run env:cells:up|down|reset`. Idempotent; macOS and Linux.
#
#   up                       makes the SSH key if absent, starts both twins (building their
#                            images unless TWIN_SKIP_BUILD=1 or another checkout owns them),
#                            waits until each has verified its site, proves from the host that
#                            every published port answers, removes a killed twin spec's sudoers
#                            logging drop-in, then writes this checkout's sites overlays and
#                            proves they load
#   down [--force] [--purge-key]
#                            removes this checkout's overlays, then the containers and their
#                            volumes; --purge-key also the shared key (only one cells.sh made)
#   reset <apache|nginx> <variant>   resets one running twin to a variant (site.sh, then check.sh)
#
# One twin set per machine (fixed container names, one compose project), shared by every checkout:
# - The key is per user, not per checkout (TWIN_KEY_DIR, an absolute path; default
#   ~/.local/share/wp-media-e2e/ssh-twins, 0700, key 0600), so an `up` from a second checkout hands
#   the twins the same key and keeps them. cells.sh uses or removes only a key folder it made (its
#   marker file .wpme-ssh-twins) holding its own key (comment wpme-ssh-twins): never ~/.ssh.
# - The containers carry the checkout that created them (label wpme.ssh-twins.checkout, its physical
#   path). An `up` from another checkout builds nothing, uses them as they are, and refuses when
#   compose would create or recreate one; a `down` from another checkout removes only its own
#   overlays and refuses to remove the twins unless --force.
# - Compose recreates a twin whenever its settings (a port, TWIN_ADMIN_*, TWIN_VARIANT) or its image
#   change; a new container starts in TWIN_VARIANT, a kept one keeps its site.
#
# Settings (environment; defaults in docker-compose.yml): TWIN_APACHE_SSH_PORT (2210),
# TWIN_NGINX_SSH_PORT (2211), TWIN_APACHE_HTTP_PORT (8110), TWIN_NGINX_HTTP_PORT (8111),
# TWIN_ADMIN_USER (admin), TWIN_ADMIN_PASSWORD (twin-admin-password), TWIN_VARIANT (legacy-777),
# TWIN_SKIP_BUILD (1: use images already built, as CI does after a cached build), TWIN_WAIT_SECONDS
# (900: how long `up` waits for both twins), TWIN_KEY_DIR (above).
#
# The overlays (src/projects/<product>/config/sites.twins.json, mode 0600) are git-ignored; the key
# lives outside every checkout. Neither is ever printed: the password and key are throw-away test
# values, still kept out of logs.
set -euo pipefail

# Physical paths (-P): a checkout reached through a symlink is the same checkout, the same owner.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")
KEY_DIR="${TWIN_KEY_DIR:-$HOME/.local/share/wp-media-e2e/ssh-twins}"
KEY="$KEY_DIR/id_ed25519"
# The file cells.sh writes in a key folder it makes, and the key's comment: together, proof that the
# folder and key are the twins', so a TWIN_KEY_DIR naming a folder of the user's is never touched.
KEY_MARKER="$KEY_DIR/.wpme-ssh-twins"
KEY_COMMENT=wpme-ssh-twins
# Where the overlays go: each product's config folder, next to its sites.json.
BACKWPUP_OVERLAY="$REPO/src/projects/backwpup/config/sites.twins.json"
WP_ROCKET_OVERLAY="$REPO/src/projects/wp-rocket/config/sites.twins.json"
# The docroot every variant uses (lib.sh's TWIN_ROOT) and the login every twin accepts.
TWIN_ROOT_DIR=/var/www/site/public
TWIN_SSH_USER=ubuntu
# The container label naming the checkout that created the twins (docker-compose.yml sets it).
OWNER_LABEL=wpme.ssh-twins.checkout
# How many times, one second apart, `up` asks each published port before giving up.
PORT_ATTEMPTS=15
# The sudoers drop-in the housekeeping twin spec adds while it runs (it logs ubuntu's command lines);
# a runner killed mid-test leaves it. The twin specs' lock folder (ssh-twins.ts's TWIN_LOCK_DIR).
TWIN_LOG_DROP_IN=/etc/sudoers.d/99-e2e-log-allowed
TWIN_LOCK_DIR=/tmp/wpme-ssh-twins

export TWIN_APACHE_SSH_PORT="${TWIN_APACHE_SSH_PORT:-2210}"
export TWIN_NGINX_SSH_PORT="${TWIN_NGINX_SSH_PORT:-2211}"
export TWIN_APACHE_HTTP_PORT="${TWIN_APACHE_HTTP_PORT:-8110}"
export TWIN_NGINX_HTTP_PORT="${TWIN_NGINX_HTTP_PORT:-8111}"
export TWIN_ADMIN_USER="${TWIN_ADMIN_USER:-admin}"
export TWIN_ADMIN_PASSWORD="${TWIN_ADMIN_PASSWORD:-twin-admin-password}"
export TWIN_VARIANT="${TWIN_VARIANT:-legacy-777}"

# Prints a step. Usage: say <text>
say() { printf '→ %s\n' "$*"; }

# Prints an error and exits 1. Usage: die <text>
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# Prints the usage on stderr and exits 2.
usage() {
  cat >&2 <<EOF
Usage: npm run env:cells:up
       npm run env:cells:down [-- [--force] [--purge-key]]
       npm run env:cells:reset -- <apache|nginx> <variant>
Variants: $(variants)
EOF
  exit 2
}

# Prints the variants the twins know, read from lib.sh so the two lists cannot drift.
variants() {
  sed -n 's/^readonly TWIN_VARIANTS="\(.*\)"$/\1/p' "$HERE/lib.sh"
}

# Succeeds when <word> is one of the space-separated <list>; an empty word, or one holding whitespace
# ("a b" is inside " a b "), never is. Usage: one_of <word> <list>
one_of() { [[ -n "$1" && "$1" != *[[:space:]]* && " $2 " == *" $1 "* ]]; }

# Refuses anything a twin would refuse late (lib.sh's validate_env) or that would collide: ports,
# the login and the variant, checked on the host so the error names the setting at once.
validate_settings() {
  local name value
  for name in TWIN_APACHE_SSH_PORT TWIN_NGINX_SSH_PORT TWIN_APACHE_HTTP_PORT TWIN_NGINX_HTTP_PORT; do
    value="${!name}"
    if ! [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] || ((value > 65535)); then
      die "$name must be a port number from 1 to 65535, got '$value'"
    fi
  done
  local ports="$TWIN_APACHE_SSH_PORT $TWIN_NGINX_SSH_PORT $TWIN_APACHE_HTTP_PORT $TWIN_NGINX_HTTP_PORT"
  [[ "$(tr ' ' '\n' <<<"$ports" | sort -u | wc -l | tr -d ' ')" == 4 ]] \
    || die "The four TWIN_*_PORT settings must differ, got: $ports"
  [[ "$TWIN_ADMIN_USER" =~ ^[A-Za-z0-9._-]{1,60}$ ]] \
    || die "TWIN_ADMIN_USER may hold only letters, digits, '.', '_' and '-'"
  # A ' breaks a web login with a password WP-CLI set at install (measured): safe characters only.
  [[ "$TWIN_ADMIN_PASSWORD" =~ ^[A-Za-z0-9._@%+=-]{8,128}$ ]] \
    || die "TWIN_ADMIN_PASSWORD must be 8-128 of letters, digits and ._@%+=-"
  one_of "$TWIN_VARIANT" "$(variants)" || die "Unknown TWIN_VARIANT '$TWIN_VARIANT'. One of: $(variants)"
}

# Refuses a relative TWIN_KEY_DIR: the overlays name the key by path, read from wherever a run starts.
validate_key_dir() {
  [[ "$KEY_DIR" == /* ]] || die "TWIN_KEY_DIR must be an absolute path, got '$KEY_DIR'"
}

# Succeeds when the Docker daemon answers (it is never started from here).
docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# Fails unless the Docker daemon answers.
require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker_up || die "Docker is not running: start it, then retry"
}

# Succeeds when <path> exists, as anything (a dangling symlink included). Usage: exists <path>
exists() { [[ -e "$1" || -L "$1" ]]; }

# Succeeds when <path> is a regular file, not a symlink. Usage: plain_file <path>
plain_file() { [[ -f "$1" && ! -L "$1" ]]; }

# Prints the comment of public key <file>: `ssh-keygen -l` prints "<bits> <fingerprint> <comment>
# (<type>)", the comment possibly empty or spaced. Fails when ssh-keygen cannot read it.
# Usage: pub_comment <file>
pub_comment() {
  local line
  line="$(ssh-keygen -l -f "$1" </dev/null 2>/dev/null)" || return 1
  line="${line#* }"
  line="${line#* }"
  printf '%s\n' "${line% (*)}"
}

# Succeeds when KEY is the twins' own: a plain file, no passphrase, comment KEY_COMMENT, and a
# public half (when present) of the same key and comment.
own_key() {
  local derived
  plain_file "$KEY" || return 1
  # The public half the private key carries (with its comment): fails on a passphrase or a non-key.
  derived="$(ssh-keygen -y -f "$KEY" </dev/null 2>/dev/null)" || return 1
  # Its comment, after the type and base64 fields, is exactly KEY_COMMENT.
  [[ "${derived#* * }" == "$KEY_COMMENT" ]] || return 1
  exists "$KEY.pub" || return 0
  plain_file "$KEY.pub" && [[ "$(pub_comment "$KEY.pub")" == "$KEY_COMMENT" ]] || return 1
  # Same key: the type and base64 fields match the private key's.
  [[ "$(cut -d ' ' -f 1-2 "$KEY.pub")" == "$(cut -d ' ' -f 1-2 <<<"$derived")" ]]
}

# Fails unless KEY_DIR is a folder cells.sh made (its marker) whose key, if any, is the twins' own.
# <what> names the refused action. Usage: require_own_key_dir <what>
require_own_key_dir() {
  plain_file "$KEY_MARKER" || die "TWIN_KEY_DIR ($KEY_DIR) was not made by env:cells:up (no" \
    "$(basename "$KEY_MARKER") file), so $1 refused: its files may be someone's own keys." \
    "Unset TWIN_KEY_DIR, or name a folder that does not exist yet"
  if exists "$KEY" || exists "$KEY.pub"; then
    own_key || die "$KEY is not the twins' key (no passphrase, comment $KEY_COMMENT, matching" \
      "$(basename "$KEY").pub), so $1 refused. Remove it yourself, or set another TWIN_KEY_DIR"
  fi
}

# Makes the key folder (0700, with its marker) and the throw-away key pair (0600) when absent; uses
# an existing folder only when cells.sh made it and its key is the twins' own, and never changes a
# folder's mode (ssh2 refuses nothing; ssh(1) by hand wants the key 0600).
ensure_key() {
  command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is not installed (OpenSSH client)"
  if ! exists "$KEY_DIR"; then
    say "Making the twins' key folder ($KEY_DIR)"
    mkdir -p "$(dirname "$KEY_DIR")"
    mkdir -m 0700 "$KEY_DIR"
    printf 'Made by wp-media-e2e (npm run env:cells:up) for the SSH twins; removed by\n%s\n' \
      "npm run env:cells:down -- --purge-key." >"$KEY_MARKER"
  fi
  require_own_key_dir "using its key is"
  if ! exists "$KEY"; then
    say "Making the twins' throw-away SSH key ($KEY_DIR)"
    (umask 077 && ssh-keygen -q -t ed25519 -N '' -C "$KEY_COMMENT" -f "$KEY" </dev/null)
  elif ! exists "$KEY.pub"; then
    ssh-keygen -y -f "$KEY" </dev/null >"$KEY.pub"
  fi
  chmod 0600 "$KEY"
  TWIN_AUTHORIZED_KEY="$(<"$KEY.pub")"
  export TWIN_AUTHORIZED_KEY
}

# Removes the twins' key, then the marker, then the folder if that left it empty. Callers first
# prove the folder is the twins' (require_own_key_dir); an absent folder is nothing to do.
purge_key() {
  if ! exists "$KEY_DIR"; then
    say "No shared SSH key to remove ($KEY_DIR)"
    return
  fi
  say "Removing the shared SSH key ($KEY_DIR)"
  # The key first: a failed removal keeps the marker, so a later --purge-key may finish it.
  rm -f "$KEY" "$KEY.pub"
  rm -f "$KEY_MARKER"
  rmdir "$KEY_DIR" 2>/dev/null || say "Kept $KEY_DIR: it holds other files"
}

# Prints the checkout that created the twins; nothing when no twin exists or none carries the label.
twins_owner() {
  local stack owner
  for stack in apache nginx; do
    owner="$(docker inspect -f "{{index .Config.Labels \"$OWNER_LABEL\"}}" "wpme-ssh-$stack" 2>/dev/null || true)"
    if [[ -n "$owner" && "$owner" != "<no value>" ]]; then
      printf '%s\n' "$owner"
      return
    fi
  done
}

# Prints, one per line, why `compose up` would create or recreate another checkout's twins; nothing
# when it would keep both. Compose's own test: a container's config-hash label against `config
# --hash` (every setting, the key and the owner label included), and the image it runs against the
# one its tag names now. Exits through die, printing compose's error, when compose cannot answer.
recreate_reasons() {
  local hashes stack container expected actual image
  if ! hashes="$("${COMPOSE[@]}" config --hash '*' 2>&1)"; then
    printf '%s\n' "$hashes" >&2
    die "docker compose config failed (above): nothing was changed"
  fi
  for stack in apache nginx; do
    container="wpme-ssh-$stack"
    expected="$(sed -n "s/^twin-$stack \([0-9a-f]\{64\}\)\$/\1/p" <<<"$hashes")"
    if [[ -z "$expected" ]]; then
      printf '%s\n' "$hashes" >&2
      die "docker compose config printed no hash for twin-$stack (above): nothing was changed"
    fi
    if ! actual="$(docker inspect "$container" 2>/dev/null \
      -f '{{index .Config.Labels "com.docker.compose.config-hash"}} {{.Image}}')"; then
      echo "$container is missing, so compose would create it"
      continue
    fi
    [[ "${actual%% *}" == "$expected" ]] \
      || echo "$container has other settings (a port, TWIN_ADMIN_*, TWIN_VARIANT or the key)"
    image="$(docker image inspect -f '{{.Id}}' "$container:local" 2>/dev/null || true)"
    [[ "${actual#* }" == "$image" ]] \
      || echo "$container runs another image than $container:local names"
  done
}

# Refuses an `up` that would create or recreate twins another checkout created: their overlays
# would then name a password, variant, port, key or build the new twins lack.
# Usage: refuse_changing_others <owner>
refuse_changing_others() {
  local owner="$1" reasons
  reasons="$(recreate_reasons)"
  [[ -z "$reasons" ]] && return
  local reason
  while IFS= read -r reason; do printf '  %s\n' "$reason" >&2; done <<<"$reasons"
  die "The twins belong to $owner, and compose would create or recreate them (above). Use its" \
    "TWIN_* settings and key, or run npm run env:cells:down there first."
}

# Prints a twin's upper-case name, for its TWIN_<STACK>_* settings. Usage: upper <apache|nginx>
upper() { tr '[:lower:]' '[:upper:]' <<<"$1"; }

# Succeeds when something accepts a TCP connection on <address>:<port>.
# Usage: port_open <address> <port>
port_open() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }

# Refuses to start a twin whose published ports another program holds, on 127.0.0.1 or ::1:
# Docker Desktop (macOS) may publish beside a host listener, which then answers instead of the twin,
# and the overlays' http://localhost reaches ::1 first on macOS. A running twin's ports are skipped.
require_free_ports() {
  local stack name address
  for stack in apache nginx; do
    [[ "$(docker inspect -f '{{.State.Running}}' "wpme-ssh-$stack" 2>/dev/null)" == true ]] && continue
    for name in "TWIN_$(upper "$stack")_SSH_PORT" "TWIN_$(upper "$stack")_HTTP_PORT"; do
      for address in 127.0.0.1 ::1; do
        if port_open "$address" "${!name}"; then
          die "Port ${!name} ($name) is already in use on $address: free it, or set $name" \
            "to another port"
        fi
      done
    done
  done
}

# Succeeds when <port> sends an SSH identification line within 5 s. Usage: ssh_answers <port>
ssh_answers() {
  (
    exec 3<>"/dev/tcp/127.0.0.1/$1" || exit 1
    IFS= read -r -t 5 line <&3 || exit 1
    [[ "$line" == SSH-* ]]
  ) 2>/dev/null
}

# Succeeds when <port> serves WordPress's blank.gif (a GIF: not some other server's page) both at
# localhost, the overlays' name (::1 first on macOS), and at 127.0.0.1. Usage: http_answers <port>
http_answers() {
  local host
  for host in localhost 127.0.0.1; do
    [[ "$(curl -fsS --max-time 5 "http://$host:$1/wp-includes/images/blank.gif" 2>/dev/null \
      | head -c 6)" == GIF8[79]a ]] || return 1
  done
}

# Runs <check> <port> up to PORT_ATTEMPTS times, one second apart. Usage: retry <check> <port>
retry() {
  local attempt
  for ((attempt = 1; attempt <= PORT_ATTEMPTS; attempt++)); do
    "$1" "$2" && return 0
    sleep 1
  done
  return 1
}

# Proves from the host what each twin's own healthcheck cannot: every published port reaches it.
# On failure: the logs, and the port named.
prove_ports() {
  say "Checking every published port from the host"
  local stack ssh_name http_name
  for stack in apache nginx; do
    ssh_name="TWIN_$(upper "$stack")_SSH_PORT"
    http_name="TWIN_$(upper "$stack")_HTTP_PORT"
    if ! retry ssh_answers "${!ssh_name}"; then
      show_logs
      die "No SSH server answers on 127.0.0.1:${!ssh_name} ($ssh_name, the $stack twin):" \
        "is another program on it?"
    fi
    if ! retry http_answers "${!http_name}"; then
      show_logs
      die "The $stack twin's site does not answer on both http://localhost:${!http_name} and" \
        "127.0.0.1 ($http_name): is another program on it (::1 included)?"
    fi
  done
}

# Prints the logs of both twins' last lines, for a failed start. Twins never print the password.
show_logs() {
  "${COMPOSE[@]}" ps -a >&2 || true
  "${COMPOSE[@]}" logs --no-color --tail 60 >&2 || true
}

# Removes this checkout's overlays: its runs then load its sites.json, or the example, again.
remove_overlays() { rm -f "$BACKWPUP_OVERLAY" "$WP_ROCKET_OVERLAY"; }

# Writes both products' overlays (0600: they hold the WordPress password) through Node, so every
# value is JSON-escaped whatever the checkout's path holds. `runAs` is spelled out (`"auto"`, also the
# default), so a twin keeps asking for the web server's identity whatever the default becomes.
write_overlays() {
  say "Writing the sites overlays (sites.twins.json, git-ignored)"
  # shellcheck disable=SC2016 # JavaScript, expanded by Node
  TWIN_KEY="$KEY" TWIN_ROOT_DIR="$TWIN_ROOT_DIR" TWIN_SSH_USER="$TWIN_SSH_USER" \
    BACKWPUP_OVERLAY="$BACKWPUP_OVERLAY" WP_ROCKET_OVERLAY="$WP_ROCKET_OVERLAY" \
    node --input-type=module -e '
      import { chmodSync, writeFileSync } from "node:fs";
      const e = process.env;
      // One twin as a pool of one site; `edition` only where the product uses editions.
      const cell = (stack, edition) => {
        const upper = stack.toUpperCase();
        const site = {
          baseURL: `http://localhost:${e[`TWIN_${upper}_HTTP_PORT`]}`,
          username: e.TWIN_ADMIN_USER,
          password: e.TWIN_ADMIN_PASSWORD,
          transport: {
            mode: "ssh",
            host: "127.0.0.1",
            port: Number(e[`TWIN_${upper}_SSH_PORT`]),
            username: e.TWIN_SSH_USER,
            privateKeyPath: e.TWIN_KEY,
            rootDir: e.TWIN_ROOT_DIR,
            // Site commands as the docroot owner once the pre-flight verified PHP runs as it.
            runAs: "auto",
          },
        };
        return edition === undefined ? [site] : { edition, sites: [site] };
      };
      const write = (path, cells) => {
        writeFileSync(path, `${JSON.stringify(cells, null, 2)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      };
      write(e.BACKWPUP_OVERLAY, {
        "pro@twin-apache": cell("apache", "pro"),
        "pro@twin-nginx": cell("nginx", "pro"),
      });
      write(e.WP_ROCKET_OVERLAY, {
        "twin-apache": cell("apache"),
        "twin-nginx": cell("nginx"),
      });
    '
}

# Loads each product's sites files as a run would (sites.json too, when present), so an overlay that
# breaks the merge (a cell sites.json already owns, mixed editions) fails here, not in a run. On
# failure the overlays are removed (every run would crash on them) and the loader's message printed.
check_overlays_load() {
  say "Checking the overlays load beside any sites.json"
  # shellcheck disable=SC2016 # TypeScript, expanded by tsx
  if ! (cd "$REPO" && npx --no-install tsx --eval '
    import { loadSites } from "./src/common/config/sites";
    try {
      for (const product of ["backwpup", "wp-rocket"]) {
        const cells = Object.keys(loadSites(`src/projects/${product}/config`));
        const twins = cells.filter((cell) => /(^|@)twin-(apache|nginx)$/.test(cell));
        if (twins.length !== 2) throw new Error(`${product}: expected 2 twin cells, got ${twins.join(", ")}`);
        console.log(`  ✓ ${product}: ${twins.join(", ")}`);
      }
    } catch (error) {
      console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  '); then
    remove_overlays
    die "The overlays do not load (message above), so they were removed; the twins are still up"
  fi
}

# Starts both twins (or keeps them) and waits for each to be healthy (its site verified by check.sh,
# served on both ports), proves the published ports from the host, then writes and checks overlays.
cmd_up() {
  # Overlays from a failed or other-settings `up` must not outlive this one if it fails.
  remove_overlays
  validate_settings
  validate_key_dir
  require_docker
  ensure_key
  local owner
  owner="$(twins_owner)"
  # Kept as it is: a changed label would recreate the twins.
  export TWIN_CHECKOUT="${owner:-$REPO}"
  if [[ -n "$owner" && "$owner" != "$REPO" ]]; then
    # Never built here: the image tags are shared, so a build would hand the owner's next
    # TWIN_SKIP_BUILD=1 `up` this checkout's sources.
    refuse_changing_others "$owner"
    say "Using the twins $owner started, as they are (images not built)"
  elif [[ "${TWIN_SKIP_BUILD:-0}" != 1 ]]; then
    say "Building the twin images (cached after the first build)"
    "${COMPOSE[@]}" build
  fi
  require_free_ports
  local wait="${TWIN_WAIT_SECONDS:-900}"
  say "Starting both twins and waiting up to ${wait}s for them to verify their sites"
  if ! "${COMPOSE[@]}" up -d --no-build --wait --wait-timeout "$wait"; then
    show_logs
    die "The twins did not become healthy: see the logs above"
  fi
  prove_ports
  remove_stray_drop_ins
  write_overlays
  check_overlays_load
  echo "✓ Twins ready — apache: http://localhost:${TWIN_APACHE_HTTP_PORT} (ssh :${TWIN_APACHE_SSH_PORT})" \
    " ·  nginx: http://localhost:${TWIN_NGINX_HTTP_PORT} (ssh :${TWIN_NGINX_SSH_PORT})"
}

# Removes a stray TWIN_LOG_DROP_IN from each twin no spec holds (its lock's pid running): a holder's
# drop-in is its own, in use. Usage: remove_stray_drop_ins
remove_stray_drop_ins() {
  local stack pid
  for stack in apache nginx; do
    pid="$(cat "$TWIN_LOCK_DIR/wpme-ssh-twin-$stack.lock/pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && ps -p "$pid" >/dev/null 2>&1; then
      say "The $stack twin is held by a spec (pid $pid): its sudoers drop-ins left alone"
      continue
    fi
    if docker exec "wpme-ssh-$stack" test -e "$TWIN_LOG_DROP_IN"; then
      docker exec "wpme-ssh-$stack" rm -f -- "$TWIN_LOG_DROP_IN"
      say "Removed a killed twin spec's $TWIN_LOG_DROP_IN from the $stack twin"
    fi
  done
}

# Removes this checkout's overlays, then the twins (containers, volumes, network) unless another
# checkout created them and --force is absent; the shared key only with --purge-key. With Docker
# stopped, the files still go and the containers are reported as left (exit 1).
# Usage: cmd_down [--force] [--purge-key]
cmd_down() {
  local force=0 purge=0 arg owner
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      --purge-key) purge=1 ;;
      *) usage ;;
    esac
  done
  validate_key_dir
  # Before anything is removed: a refused --purge-key changes nothing.
  if ((purge)) && exists "$KEY_DIR"; then require_own_key_dir "--purge-key is"; fi
  say "Removing this checkout's sites overlays"
  remove_overlays
  if ! docker_up; then
    if ((purge)); then purge_key; fi
    die "Docker is not running: the twins' containers and volumes were not removed." \
      "Start Docker, then run npm run env:cells:down again"
  fi
  owner="$(twins_owner)"
  if [[ -n "$owner" && "$owner" != "$REPO" ]] && ((!force)); then
    die "The twins belong to $owner, whose runs use them: not removed, nor the key." \
      "Run npm run env:cells:down there, or here with -- --force"
  fi
  say "Removing the twins (containers, volumes, network)"
  "${COMPOSE[@]}" down -v --remove-orphans
  if ((purge)); then
    purge_key
  else
    say "Key kept for every checkout ($KEY_DIR): -- --purge-key removes it"
  fi
  echo "✓ Twins removed (images kept: docker image rm wpme-ssh-apache:local wpme-ssh-nginx:local)"
}

# Resets one running twin to a variant; site.sh ends with check.sh, so success means proved.
# Usage: cmd_reset <apache|nginx> <variant>
cmd_reset() {
  (($# == 2)) || usage
  local stack="$1" variant="$2"
  one_of "$stack" "apache nginx" || { echo "✗ Unknown twin '$stack': apache or nginx" >&2; usage; }
  one_of "$variant" "$(variants)" || { echo "✗ Unknown variant '$variant'" >&2; usage; }
  require_docker
  local container="wpme-ssh-$stack"
  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == true ]] \
    || die "$container is not running: npm run env:cells:up first"
  say "Resetting $container to '$variant'"
  docker exec "$container" /opt/twin/site.sh "$variant"
}

case "${1:-}" in
  up) shift; (($# == 0)) || usage; cmd_up ;;
  down) shift; cmd_down "$@" ;;
  reset) shift; cmd_reset "$@" ;;
  *) usage ;;
esac
