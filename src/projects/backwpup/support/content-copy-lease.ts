/**
 * The lease a copy of `wp-content` (`./content-copy.ts`) carries while its run may still use it, so a
 * later run can tell, within one boot of the host, a copy whose run is gone from one a live run holds.
 *
 * **Measured on the host's own clock**: `/proc/uptime`, the kernel's boot-time clock — never stepped
 * by NTP or by hand, and counting while the host is suspended — read only within the boot whose id
 * the lease names. The runner's clock never counts: it may sleep, or be another machine's.
 *
 * **Renewed by its run** ({@link LEASE_RENEW_MS}) for as long as it may use the copy, each renewal
 * granting {@link LEASE_TTL_S}: a runner that stops renewing — killed, asleep, cut off — lets it lapse.
 * A run giving up on its copy (the put-back failed, or its restore never ended) expires it at once.
 * A restore or put-back still running on the host needs no renewal: a later run refuses a copy while
 * any process uses it (`IN_USE_SCRIPT`), lease or not.
 *
 * **The lease is not what keeps a site safe** — fencing is: every root command of the owner acts only
 * inside the directory at the copy's path holding its token, and its restore starts only while that
 * directory is still the one it made (`./content-copy-fence.ts`); a recovery claims the copy by
 * renaming it first. The lease only spares a live run from having its copy settled under it.
 *
 * **A holder** names the invocation and worker slot that renewed it last ({@link holderFor}): a later
 * worker of the same invocation in the same slot proves that worker gone — Playwright never runs two
 * workers with the same `parallelIndex` at once — so its copy is settled at once instead of after the
 * lease. The invocation is a random token per runner (`INVOCATION_ID`), never `RUN_ID`, which two
 * invocations may share.
 */

/** The lease's file in a copy's directory. */
export const CONTENT_COPY_LEASE = "lease";

/** Where a renewal writes the lease before renaming it into place, so no reader sees half of one. */
export const LEASE_NEXT = "lease.next";

/** The kernel's boot-time clock: seconds since boot, suspend included, then idle time. */
export const UPTIME_PATH = "/proc/uptime";

/** How long each renewal grants, in seconds of the host's boot-time clock: fifteen renewals' worth. */
export const LEASE_TTL_S = 15 * 60;

/** How often a run renews its copy's lease. */
export const LEASE_RENEW_MS = 60_000;

/** The holder written when none is known (a settle run outside a worker, e.g. the auth setup). */
export const NO_HOLDER = "-";

/** The lease format's version, its first word. */
const LEASE_VERSION = "v1";

/** A boot id as Linux prints it: a lowercase UUID. */
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a holder may hold: one word, no space — an invocation's hex token, `#`, a slot. */
const HOLDER = /^[A-Za-z0-9._#-]{1,200}$/;

/**
 * `sh` function renewing a copy's lease, run as root inside its directory: `renew <ttl> <holder>`.
 * Stamps the boot (`boot-id`, as every use has done since before leases; `cp -f`, since `cp` gives
 * the stamp the source's read-only mode, which only root writes over), then writes
 * `v1 <boot> <now> <now + ttl> <holder>` to {@link LEASE_NEXT} and renames it over
 * {@link CONTENT_COPY_LEASE}. A ttl of `0` expires it. Returns non-zero — nothing renewed — when the
 * boot id or the clock cannot be read.
 */
export const RENEW_FUNCTION = [
  "renew() {",
  "  cp -f -- /proc/sys/kernel/random/boot_id boot-id || return 1",
  "  b=$(cat boot-id) && u=$(cat " + UPTIME_PATH + ") || return 1",
  "  u=${u%%[!0-9]*}",
  '  case $u in "") return 1 ;; esac',
  `  printf '${LEASE_VERSION} %s %s %s %s\\n' "$b" "$u" "$((u + $1))" "$2" > ${LEASE_NEXT} || return 1`,
  `  mv -f -- ${LEASE_NEXT} ${CONTENT_COPY_LEASE}`,
  "}",
].join("\n");

/** `sh` program renewing the lease: `$1` the ttl in seconds, `$2` the holder. Exit 94 when it could not. */
export const RENEW_SCRIPT = [RENEW_FUNCTION, 'renew "$1" "$2" || exit 94'].join(
  "\n",
);

/** A lease as read back. Times are whole seconds of the host's boot-time clock. */
export interface Lease {
  readonly bootId: string;
  readonly renewedS: number;
  readonly expiresS: number;
  readonly holder: string;
}

/**
 * Reads a lease file.
 *
 * @param text - its contents.
 * @returns `undefined` unless it is exactly one well-formed lease, its expiry not before its renewal.
 */
export function parseLease(text: string | undefined): Lease | undefined {
  const words = text?.trim().split(" ") ?? [];
  if (words.length !== 5 || words[0] !== LEASE_VERSION) return undefined;
  const [, bootId = "", renewed = "", expires = "", holder = ""] = words;
  if (!BOOT_ID.test(bootId) || !HOLDER.test(holder)) return undefined;
  if (!/^\d{1,12}$/.test(renewed) || !/^\d{1,12}$/.test(expires))
    return undefined;
  const lease = {
    bootId,
    renewedS: Number(renewed),
    expiresS: Number(expires),
    holder,
  };
  return lease.expiresS >= lease.renewedS ? lease : undefined;
}

/**
 * Reads `/proc/uptime`'s first field: whole seconds since boot.
 *
 * @param text - the file's contents.
 * @returns `undefined` unless it starts with a non-negative number.
 */
export function parseUptime(text: string | undefined): number | undefined {
  const first = text?.trim().split(/\s+/)[0] ?? "";
  return /^\d{1,12}(\.\d+)?$/.test(first)
    ? Math.floor(Number(first))
    : undefined;
}

/**
 * The holder a worker writes into its leases: its invocation and its slot.
 *
 * @param invocation - the runner invocation's token (`INVOCATION_ID`: 32 hex digits).
 * @param slot - the worker's `parallelIndex`.
 * @throws {@link Error} if either cannot be written as one word.
 */
export function holderFor(invocation: string, slot: number): string {
  const holder = `${invocation}#${String(slot)}`;
  if (!Number.isInteger(slot) || slot < 0 || !HOLDER.test(holder)) {
    throw new Error(
      `[backwpup/content-copy] cannot name a lease's holder from invocation ${JSON.stringify(invocation)} and slot ${String(slot)}.`,
    );
  }
  return holder;
}

/**
 * The arguments renewing a lease: a ttl that is a whole number of seconds, a holder that is one word.
 *
 * @param ttlS - seconds granted; `0` expires it.
 * @param holder - who renews it ({@link holderFor}, or {@link NO_HOLDER}).
 * @throws {@link Error} if either would not survive the script.
 */
export function renewArgs(ttlS: number, holder: string): string[] {
  if (!Number.isInteger(ttlS) || ttlS < 0 || ttlS > 86_400) {
    throw new Error(
      `[backwpup/content-copy] a lease lasts 0 to 86400 s, got ${String(ttlS)}.`,
    );
  }
  if (holder !== NO_HOLDER && !HOLDER.test(holder)) {
    throw new Error(
      `[backwpup/content-copy] a lease's holder must be one word, got ${JSON.stringify(holder)}.`,
    );
  }
  return [String(ttlS), holder];
}

/** What a lease says about whether a copy's run may still use it. */
export type LeaseState =
  /** Expired, its holder provably gone, or the clock it was measured on reset: a later run may act. */
  | { readonly state: "lapsed"; readonly why: string }
  /** A run renewed it and it has not expired: leave the copy to it. */
  | { readonly state: "held"; readonly why: string }
  /** It says nothing either way: missing (an older suite's copy), unreadable, or another boot's. */
  | { readonly state: "unknown"; readonly why: string };

/**
 * Judges a copy's lease, within the current boot only — a copy another boot stamped is judged by its
 * stamp alone, never here.
 *
 * Lapsed: the holder is the asking worker's own slot (that worker is gone; {@link NO_HOLDER} is
 * nobody's); the clock is past the expiry; or the clock reads before the renewal — the boot-time
 * clock never goes back within a boot, so the host restarted without a new boot id — a container
 * given a clock of its own (lxcfs) but the host's boot id —, which ended every process it ran. Any
 * other host never reads so; its lapse is told by the expiry alone.
 *
 * @param lease - the lease file's contents, or `undefined` when there is none.
 * @param bootId - the host's current boot id, parsed.
 * @param uptime - `/proc/uptime` as read after the lease, or `undefined` when it could not be.
 * @param self - the asking worker's holder ({@link holderFor}), if it is one.
 * @returns `lapsed` or `held`, each with why; `unknown` when the lease cannot tell.
 */
export function judgeLease(
  lease: string | undefined,
  bootId: string,
  uptime: string | undefined,
  self?: string,
): LeaseState {
  if (lease === undefined) {
    return {
      state: "unknown",
      why: "it carries no lease (an older version of the suite took it), so whether its run is gone cannot be told before the host reboots",
    };
  }
  const parsed = parseLease(lease);
  if (parsed === undefined) {
    return { state: "unknown", why: "its lease is unreadable" };
  }
  if (parsed.bootId !== bootId) {
    return {
      state: "unknown",
      why: "it was used since the host last booted, but its lease is another boot's",
    };
  }
  if (self !== undefined && self !== NO_HOLDER && parsed.holder === self) {
    return {
      state: "lapsed",
      why: "this run's worker that held it is gone",
    };
  }
  const now = parseUptime(uptime);
  if (now === undefined) {
    return {
      state: "unknown",
      why: "the host's clock (/proc/uptime) could not be read",
    };
  }
  if (now < parsed.renewedS) {
    return {
      state: "lapsed",
      why: "the host's clock reads before the lease's last renewal, so the host restarted since — with every process the lease's run had on it",
    };
  }
  if (now >= parsed.expiresS) {
    return {
      state: "lapsed",
      why: `its lease expired ${String(now - parsed.expiresS)} s ago`,
    };
  }
  return {
    state: "held",
    why: `a run renewed its lease ${String(now - parsed.renewedS)} s ago (${parsed.holder}); it lapses in ${String(parsed.expiresS - now)} s unless renewed`,
  };
}

/** What one renewal came to: `gone` when the copy holds another run's token, never to be its run's again. */
export type RenewOutcome = "renewed" | "gone" | { readonly failed: string };

/** Runs a callback every so often; returns how to stop it. A spec's stand-in replaces `setInterval`. */
export type Every = (ms: number, tick: () => void) => () => void;

/** {@link Every} on Node's timers, never keeping the process alive by itself. */
export const realEvery: Every = (ms, tick) => {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};

/**
 * Renews a lease on a timer until stopped, one renewal at a time. Stops by itself once the copy is
 * another run's (`gone`); reports the first failure only, and keeps trying — a dropped connection is
 * expected to come back, and a copy a settling run claimed away to be handed back.
 */
export class LeaseHeartbeat {
  /** Stops the timer; `undefined` when not running. */
  private cancel: (() => void) | undefined;

  /** The renewal in flight, if any: never two at once. */
  private inFlight: Promise<void> | undefined;

  /** Whether a failure was already reported. */
  private reported = false;

  /**
   * Makes a heartbeat, stopped until {@link LeaseHeartbeat.start}.
   *
   * @param renew - one renewal.
   * @param report - says a renewal failed.
   * @param everyMs - how often to renew.
   * @param every - the timer.
   */
  constructor(
    private readonly renew: () => Promise<RenewOutcome>,
    private readonly report: (problem: string) => void,
    private readonly everyMs: number = LEASE_RENEW_MS,
    private readonly every: Every = realEvery,
  ) {}

  /** Starts renewing; does nothing if already running. */
  start(): void {
    if (this.cancel !== undefined) return;
    this.cancel = this.every(this.everyMs, () => {
      this.tick();
    });
  }

  /** Stops renewing, then waits for a renewal in flight, so nothing renews after it returns. */
  async stop(): Promise<void> {
    this.cancel?.();
    this.cancel = undefined;
    await this.inFlight;
  }

  /** One timer tick: a renewal unless one is still in flight. */
  private tick(): void {
    if (this.inFlight !== undefined) return;
    this.inFlight = this.once().finally(() => {
      this.inFlight = undefined;
    });
  }

  /** One renewal, its outcome acted on; never rejects. */
  private async once(): Promise<void> {
    let outcome: RenewOutcome;
    try {
      outcome = await this.renew();
    } catch (error) {
      outcome = {
        failed: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome === "gone") {
      this.cancel?.();
      this.cancel = undefined;
      return;
    }
    if (outcome !== "renewed" && !this.reported) {
      this.reported = true;
      this.report(outcome.failed);
    }
  }
}
