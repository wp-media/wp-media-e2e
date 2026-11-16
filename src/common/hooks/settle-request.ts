import { errorMessage } from "../guards";
import { plain, redactSecrets } from "../text";
import type { SettleAfterInstall } from "../config/types";
import type { ScenarioReport } from "./plugin-lifecycle";

/**
 * The settling request a `@plugin` install makes once the plugin is active, for a product that asks
 * for one (`ProductConfig.settleAfterInstall`): what a plugin writes only on a web request — WP
 * Rocket's config file, and on Apache its `.htaccess` block — is then on the site before the first
 * step, written by the web server rather than by whichever step happens to load a page first.
 *
 * `"admin-request"`: a GET of `/wp-admin/` with the scenario's session, whose final URL must be in
 * wp-admin — the login page means the scenario has no logged-in session (`@noauth`, or a saved login
 * that expired) and the plugin's admin code never ran — then one GET of the front page. Each request
 * is bounded ({@link SETTLE_REQUEST_TIMEOUT_MS}); whatever goes wrong is a warning, never a failure:
 * the scenario's own steps are the judge of whether the plugin works.
 *
 * Pure policy over a narrow client ({@link SettleClient}), so it is unit-testable with a fake;
 * Playwright's `APIRequestContext` satisfies the interface.
 */

/** One request's bound. Generous: the first admin request after activation does the plugin's setup. */
export const SETTLE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Room for what surrounds the two requests: opening the client (reading the saved login), and with
 * tracing on, starting its trace and writing it out on disposal. Usually milliseconds; a slow disk or
 * a large trace must not eat into the install's own budget.
 */
export const SETTLE_CLIENT_MARGIN_MS = 10_000;

/** What the settle may add to the Before hook: its two requests at their bound, plus the margin. */
export const SETTLE_ALLOWANCE_MS =
  2 * SETTLE_REQUEST_TIMEOUT_MS + SETTLE_CLIENT_MARGIN_MS;

/** Where the admin request is sent: the dashboard, relative to the site's `baseURL`. */
export const ADMIN_PATH = "/wp-admin/";

/** Where the front-page request is sent. */
export const FRONT_PATH = "/";

/** The part of a response the settle reads. */
export interface SettleResponse {
  /** The final URL, after redirects. */
  url(): string;
  /** The final status. */
  status(): number;
}

/** An HTTP client bound to the site (its `baseURL`) and the scenario's session. */
export interface SettleClient {
  /** Sends a GET, following redirects; rejects on a network failure or past `timeout`. */
  get(
    url: string,
    options: { readonly timeout: number },
  ): Promise<SettleResponse>;
  /** Releases the client. */
  dispose(): Promise<void>;
}

/** Opens a {@link SettleClient}; only called when the product asks for a settle. */
export type OpenSettleClient = () => Promise<SettleClient>;

/** Where the admin request ended: in wp-admin, on the login page, or anywhere else. */
export type AdminLanding = "admin" | "login" | "elsewhere";

/**
 * Classifies the admin request's final URL. Pure.
 *
 * @param finalUrl - the response's URL after redirects.
 * @returns `"login"` for `wp-login.php`, `"admin"` for a path under `/wp-admin/`, else `"elsewhere"`
 * (an unparsable URL included).
 */
export function adminLanding(finalUrl: string): AdminLanding {
  if (!URL.canParse(finalUrl)) return "elsewhere";
  const { pathname } = new URL(finalUrl);
  if (pathname.endsWith("/wp-login.php")) return "login";
  return pathname.includes("/wp-admin/") ? "admin" : "elsewhere";
}

/**
 * The warnings one admin response earns, empty when it landed in wp-admin with a non-error status.
 * Pure.
 *
 * @param response - the admin request's response.
 */
export function adminResponseWarnings(response: SettleResponse): string[] {
  const landing = adminLanding(response.url());
  if (landing === "login") {
    return [
      `${ADMIN_PATH} answered with the login page (wp-login.php): the scenario has no logged-in ` +
        "session — a @noauth scenario, or a saved login that expired — so the plugin's admin code " +
        "never ran",
    ];
  }
  const warnings: string[] = [];
  if (landing === "elsewhere") {
    warnings.push(
      `${ADMIN_PATH} ended outside wp-admin, at ${pathOf(response.url())}`,
    );
  }
  warnings.push(...statusWarnings(ADMIN_PATH, response.status()));
  return warnings;
}

/**
 * A warning for an error status (4xx/5xx), else none. Pure.
 *
 * @param path - the path requested.
 * @param status - the final status.
 */
export function statusWarnings(path: string, status: number): string[] {
  return status >= 400 ? [`${path} answered HTTP ${String(status)}`] : [];
}

/**
 * Makes the product's settling request(s) after an install, and reports what went wrong. Never
 * throws: a failure is a warning (printed, and attached to the scenario as `settle-request`).
 *
 * @param settle - the product's `settleAfterInstall`; `undefined` makes no request and opens nothing.
 * @param open - opens the client; `undefined` when the caller has none to give (a reinstall from a
 * step without one), which an opted-in product is warned about.
 * @param report - the scenario to name and attach to; without it, the warning is only printed.
 */
export async function settleAfterInstall(
  settle: SettleAfterInstall | undefined,
  open: OpenSettleClient | undefined,
  report?: Pick<ScenarioReport, "title" | "attach">,
): Promise<void> {
  if (settle === undefined) return;
  const warnings = await adminRequestWarnings(open);
  if (warnings.length === 0) return;
  const moment =
    report === undefined ? "after installing" : `before "${report.title}"`;
  const message =
    `[hooks] ${moment}, the settling request after install: ${warnings.join("; ")}. ` +
    "Continuing: the scenario's own steps judge the plugin.";
  console.warn(message);
  await report
    ?.attach("settle-request", message)
    .catch((attachError: unknown) => {
      console.warn(
        `[hooks] could not attach the settle-request report: ${errorMessage(attachError)}`,
      );
    });
}

/**
 * The `"admin-request"` settle: wp-admin, its landing checked, then the front page — the front page
 * asked even when wp-admin failed, since each request is independent. The client is disposed
 * whatever happens.
 *
 * @param open - opens the client, or `undefined`.
 * @returns the warnings, in the order they arose.
 */
async function adminRequestWarnings(
  open: OpenSettleClient | undefined,
): Promise<string[]> {
  if (open === undefined) {
    return ["no HTTP client was given to this install, so none was made"];
  }
  let client: SettleClient;
  try {
    client = await open();
  } catch (error) {
    return [`the HTTP client could not be opened (${failureOf(error)})`];
  }
  const warnings: string[] = [];
  try {
    try {
      const admin = await client.get(ADMIN_PATH, {
        timeout: SETTLE_REQUEST_TIMEOUT_MS,
      });
      warnings.push(...adminResponseWarnings(admin));
    } catch (error) {
      warnings.push(`${ADMIN_PATH} failed (${failureOf(error)})`);
    }
    try {
      const front = await client.get(FRONT_PATH, {
        timeout: SETTLE_REQUEST_TIMEOUT_MS,
      });
      warnings.push(...statusWarnings(FRONT_PATH, front.status()));
    } catch (error) {
      warnings.push(`${FRONT_PATH} failed (${failureOf(error)})`);
    }
  } finally {
    await client.dispose().catch(() => {
      // Nothing to report: the requests are done, and the client goes with the hook anyway.
    });
  }
  return warnings;
}

/**
 * A request failure in one line: Playwright's message opens with the cause and follows with a call
 * log naming the URL, which may carry credentials — only the first line, made plain, then
 * credentials masked (in that order: a format character inside a credential would hide it from the
 * mask).
 *
 * @param error - what the client threw.
 */
function failureOf(error: unknown): string {
  const [first = ""] = errorMessage(error).split("\n", 1);
  return redactSecrets(plain(first));
}

/**
 * A URL's path alone — never its host, query or credentials — for a message; `"(unparsable)"` when it
 * is not a URL.
 *
 * @param url - the URL.
 */
function pathOf(url: string): string {
  return URL.canParse(url) ? plain(new URL(url).pathname) : "(unparsable)";
}
