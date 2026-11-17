import { readFootprint, type PageFootprint } from "./footprint";
import type { APIRequestContext } from "@playwright/test";

/** One page an {@link AnonymousVisitor} asked for. */
export interface PageVisit {
  /** The path asked for, relative to the site's base URL. */
  readonly path: string;
  /** The HTTP status of the final response (redirects followed). */
  readonly status: number;
  /** WP Rocket's footprint on the page, read from its body. */
  readonly footprint: PageFootprint;
  /** The body's last {@link ENDING_CHARS} characters, where the footprint goes: for messages. */
  readonly ending: string;
}

/** How much of a page's end a {@link PageVisit} keeps for messages. */
export const ENDING_CHARS = 300;

/** Opens an HTTP client on the site, with no session and no cookies. */
export type OpenVisitorClient = () => Promise<APIRequestContext>;

/**
 * A visitor who is not logged in, asking the site for pages over HTTP — no browser, so nothing but
 * the page itself is requested.
 *
 * Each visit opens a fresh client: no cookie a response sets (WP Rocket rejects a request carrying
 * a logged-in or a commenter's cookie from its cache) can follow into the next visit, so every visit
 * is a first-time visitor's. Logged out on purpose: WP Rocket does not cache logged-in users unless
 * its "cache for logged-in users" option is on, which a fresh install leaves off.
 */
export class AnonymousVisitor {
  /** Every visit so far, in order. */
  private readonly made: PageVisit[] = [];

  /**
   * @param openClient - opens a client on the site with no session; disposed after each visit.
   */
  constructor(private readonly openClient: OpenVisitorClient) {}

  /** Every visit so far, in order. */
  get visits(): readonly PageVisit[] {
    return this.made;
  }

  /**
   * Asks for a page and reads WP Rocket's footprint from it, recording the visit.
   *
   * @param path - the page, relative to the site's base URL (e.g. `/`).
   * @returns the visit, also recorded in {@link AnonymousVisitor.visits}.
   * @throws whatever the request throws (an unreachable site, a timeout).
   */
  async open(path: string): Promise<PageVisit> {
    const visit = await this.peek(path);
    this.made.push(visit);
    return visit;
  }

  /**
   * {@link AnonymousVisitor.open} without recording the visit: for a look that is not one of the
   * scenario's visits (waiting for the site to be ready, say).
   *
   * @param path - the page, relative to the site's base URL.
   * @returns the visit.
   * @throws whatever the request throws.
   */
  async peek(path: string): Promise<PageVisit> {
    const client = await this.openClient();
    try {
      const response = await client.get(path);
      const body = await response.text();
      return {
        path,
        status: response.status(),
        footprint: readFootprint(body),
        ending: body.slice(-ENDING_CHARS),
      };
    } finally {
      await client.dispose();
    }
  }
}
