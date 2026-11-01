/**
 * The variables the live block's end-to-end spec sets for its run, read by its steps (in the
 * workers) and by `foreign.ts` (in the runner). Nothing else here: the steps import it.
 */
export const LIVE_PROBE_ENV = {
  /** How long each step waits, in milliseconds. */
  stepMs: "LIVE_PROBE_STEP_MS",
  /** The folder the runner process watches for a request to write to its own output. */
  requests: "LIVE_PROBE_REQUESTS",
} as const;
