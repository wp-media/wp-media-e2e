import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { boolEnv, env, intEnv } from "../../../common/config/env";
import { loadSites } from "../../../common/config/sites";
import { BACKWPUP_LOG_OPTIONS } from "../support/debug-log";
import { BACKWPUP_SITE_DB_RESIDUE } from "../support/db-residue";
import { BACKWPUP_SITE_RESIDUE } from "../support/residue";
import { stopRunningJobs } from "../support/job-runs";
import { assertNoContentCopyLeft } from "../support/content-copy-leftover";
import { resolveRestoreWorkingDirs } from "../support/restore-dir";
import type {
  ProductArtifacts,
  ProductConfig,
  ServiceConfig,
} from "../../../common/config/types";

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * Global BackWPup storage credentials, read from the environment (tolerant: blank
 * when unset). Presence is asserted at the point of use by the service layer (a
 * later phase). A site may override any of these via its `overrides` block in
 * sites.json. This config is product-private — WP Rocket never sees it.
 */
const services: ServiceConfig = {
  storage: {
    ftp: {
      host: env("BWP_FTP_HOST"),
      username: env("BWP_FTP_USERNAME"),
      password: env("BWP_FTP_PASSWORD"),
      port: intEnv("BWP_FTP_PORT", 21),
      secure: boolEnv("BWP_FTP_SECURE", true),
    },
    s3: {
      accessKeyId: env("BWP_S3_ACCESS_KEY_ID"),
      secretAccessKey: env("BWP_S3_SECRET_ACCESS_KEY"),
      bucket: env("BWP_S3_BUCKET"),
      region: env("BWP_S3_REGION", "us-east-1"),
    },
  },
};

/**
 * BackWPup's artifact manifest. BackWPup is edition-ful (Free/Pro are separate
 * packages) and its builder **requires** a version, so each role carries a default version;
 * the edition (from the cell) selects the APVM variant and the identity to expect. The
 * identity blocks are verified from `wp-media/backwpup-pro` `gulpfile.ts` — the `free` task
 * rewrites the header to `BackWPup` and packages under `backwpup/`, `pro-en` keeps
 * `BackWPup Pro` under `backwpup-pro/`.
 *
 * MUST: there is deliberately **no `previous` role yet** — BackWPup has no
 * comparison tests, so `defaultRef`/`defaultVersion` declare `plugin` only, and any
 * `E2E_PREVIOUS_*` var is warned-and-ignored. When comparison tests arrive, add a
 * `previous` default ref (e.g. `"release:latest-stable"`) AND a `previous` default version
 * here. Because resolution and the identity preflight are manifest-driven, doing so
 * automatically enables the second artifact's verification — which MUST NOT be skipped
 * (the only exemption is a test that builds its own artifact in-scenario and owns its
 * verification). Until then the consuming fixture hard-errors, so no comparison test can
 * silently run against an unverified zip.
 */
const artifacts: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop" },
  version: { kind: "required", defaultVersion: { plugin: "9.99.99" } },
  edition: {
    kind: "editionful",
    byEdition: {
      free: {
        variant: "free",
        identity: {
          slug: "backwpup",
          mainFile: "backwpup.php",
          pluginName: "BackWPup",
        },
      },
      pro: {
        // Edition `pro` → APVM variant `pro-en` (English); `pro-de` is a separate APVM
        // variant we don't test. Edition and variant are distinct namespaces.
        variant: "pro-en",
        identity: {
          slug: "backwpup-pro",
          mainFile: "backwpup.php",
          pluginName: "BackWPup Pro",
        },
      },
    },
  },
};

export const backwpup: ProductConfig = {
  name: "backwpup",
  features: "src/projects/backwpup/features/**/*.feature",
  steps: [
    "src/common/fixtures.ts",
    // This product's test instance: the shared one extended with BackWPup's page-object fixtures.
    // It MUST be listed — playwright-bdd discovers the `test` a generated spec imports from the
    // files in this array, and picks the most-extended instance among those the scenario's steps
    // use. Omit this and generation fails with "Can't guess test instance".
    "src/projects/backwpup/fixtures.ts",
    // Shared scenario hooks (e.g. the plugin lifecycle). Hooks only register when their file is
    // imported, and this glob is the only thing that imports them — omit it and the hooks are
    // silently absent rather than failing.
    "src/common/hooks/**/*.hooks.ts",
    "src/common/steps/**/*.ts",
    "src/projects/backwpup/steps/**/*.ts",
  ],
  sites: loadSites(configDir),
  artifacts,
  debugLog: BACKWPUP_LOG_OPTIONS,
  siteResidue: BACKWPUP_SITE_RESIDUE,
  // The restore working directory, named per install: prepared once the plugin has named it, so the
  // web server can write there whoever creates it first.
  resolveSiteDataDirs: resolveRestoreWorkingDirs,
  siteDbResidue: BACKWPUP_SITE_DB_RESIDUE,
  // A backup job runs in a web request of its own, so one a scenario left running would otherwise
  // outlive the plugin's removal.
  stopRunningWork: stopRunningJobs,
  // A restore's copy of wp-content a reboot orphaned, settled before the preflight's gates: the
  // damage it may undo can stop WordPress booting.
  settleLeftovers: assertNoContentCopyLeft,
  services,
};
