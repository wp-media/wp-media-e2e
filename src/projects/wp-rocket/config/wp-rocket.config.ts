import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSites } from "../../../common/config/sites";
import { WP_ROCKET_LOG_OPTIONS } from "../support/debug-log";
import { WP_ROCKET_SITE_DB_RESIDUE } from "../support/db-residue";
import { writeLicencePlugin } from "../support/licence";
import {
  WP_ROCKET_INSTALL_OUTPUTS,
  WP_ROCKET_SITE_RESIDUE,
} from "../support/residue";
import type {
  ProductArtifacts,
  ProductConfig,
} from "../../../common/config/types";

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * WP Rocket's artifact manifest. WP Rocket is a single-output, editionless
 * plugin whose version is embedded in `wp-rocket.php`, so it declares no variants and no
 * default version — an `E2E_PLUGIN_VERSION`/`E2E_PREVIOUS_VERSION` override, if given, is
 * still passed through and APVM rewrites the source version. The `previous` role is
 * supported from day one (update-path tests) and defaults to the latest stable tag; the
 * identity block is verified from `wp-media/wp-rocket` `wp-rocket.php`.
 */
const artifacts: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop", previous: "tag:latest-stable" },
  version: { kind: "embedded" },
  edition: {
    kind: "editionless",
    identity: {
      slug: "wp-rocket",
      mainFile: "wp-rocket.php",
      pluginName: "WP Rocket",
    },
  },
};

/**
 * WP Rocket product configuration. Globs are repo-root-relative (the Playwright
 * config entry that consumes this lives at the repo root). WP Rocket has no
 * external-service configuration: its licence is a dummy one that passes the offline check
 * (`support/licence.ts`).
 */
export const wpRocket: ProductConfig = {
  name: "wp-rocket",
  features: "src/projects/wp-rocket/features/**/*.feature",
  steps: [
    "src/common/fixtures.ts",
    // Shared scenario hooks (e.g. the plugin lifecycle). Hooks only register when their file is
    // imported, and this glob is the only thing that imports them — omit it and the hooks are
    // silently absent rather than failing.
    "src/common/hooks/**/*.hooks.ts",
    "src/common/steps/**/*.ts",
    "src/projects/wp-rocket/steps/**/*.ts",
  ],
  sites: loadSites(configDir),
  artifacts,
  debugLog: WP_ROCKET_LOG_OPTIONS,
  // Activation writes `WP_CACHE` only for a licensed copy: the dummy licence's must-use plugin goes
  // in first, and the teardown removes it with the rest of the residue.
  prepareActivation: (transport) => writeLicencePlugin(transport),
  installOutputs: WP_ROCKET_INSTALL_OUTPUTS,
  siteResidue: WP_ROCKET_SITE_RESIDUE,
  siteDbResidue: WP_ROCKET_SITE_DB_RESIDUE,
};
