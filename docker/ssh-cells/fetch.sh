#!/usr/bin/env bash
# Build step: downloads the pinned WP-CLI phar and WordPress release (pins.env) into /opt/twin and
# refuses either one whose hash differs. Run before the scripts are copied, so editing a script does
# not download them again.
set -euo pipefail

# shellcheck source=pins.env
. /opt/twin/pins.env

# Downloads a URL to a path, failing with the URL named (curl alone prints only its exit code).
# Usage: fetch <url> <path>
fetch() {
  curl -fsSL --retry 3 --retry-connrefused -o "$2" "$1" \
    || { echo "✗ Download failed: $1" >&2; exit 1; }
}

# Checks a file against a pinned hash. Usage: verify <sha256|sha512> <hash> <path>
verify() {
  echo "$2  $3" | "${1}sum" --check --quiet - \
    || { echo "✗ $3 does not match its pinned ${1} in pins.env" >&2; exit 1; }
}

# The suite's root-only copy: site.sh runs it as root. /usr/local/bin/wp is installed per variant.
fetch "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" \
  /opt/twin/wp-cli.phar
verify sha512 "$WP_CLI_SHA512" /opt/twin/wp-cli.phar
chmod 0644 /opt/twin/wp-cli.phar

fetch "https://wordpress.org/wordpress-${WP_VERSION}.tar.gz" /tmp/wordpress.tar.gz
verify sha256 "$WP_SHA256" /tmp/wordpress.tar.gz
# The tarball's top folder is `wordpress/`: /opt/twin/wordpress is the pristine copy each reset clones.
tar -xzf /tmp/wordpress.tar.gz -C /opt/twin --no-same-owner
rm /tmp/wordpress.tar.gz
