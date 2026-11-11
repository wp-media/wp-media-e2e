/**
 * For specs: what every fake `sudo` shares — reading `sudo`'s own options the way the suite sends
 * them, so one stub serves root (`sudo -n -- <cmd>`), the capability probe (`sudo -n true`) and the
 * site's identity (`sudo -n -u <user> -g <group> -- /bin/sh -c <wrapper> …`) alike.
 */

/**
 * POSIX `sh` lines consuming `sudo`'s options from `"$@"`: `-n`; `-u <user>` and `-g <group>`,
 * exported as `$E2E_FAKE_SUDO_USER`/`$E2E_FAKE_SUDO_GROUP` (so a fake `id` can answer as the identity
 * asked for); up to `--` or the first word that is no option. Any other option fails as an unknown
 * one would (exit 1): a stub must never run a command whose `sudo` line it did not understand.
 * Leaves the command and its arguments in `"$@"`.
 */
export const SKIP_SUDO_OPTIONS = `while [ "$#" -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    -n) shift ;;
    -u) E2E_FAKE_SUDO_USER=$2; export E2E_FAKE_SUDO_USER; shift 2 ;;
    -g) E2E_FAKE_SUDO_GROUP=$2; export E2E_FAKE_SUDO_GROUP; shift 2 ;;
    -*) echo "sudo (fake): unsupported option $1" >&2; exit 1 ;;
    *) break ;;
  esac
done`;
