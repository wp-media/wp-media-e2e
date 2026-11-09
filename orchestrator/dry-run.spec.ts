import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadSites } from "../src/common/config/sites";
import { NOT_A_SITE_URL } from "../src/common/text";
import type { ProductArtifacts } from "../src/common/artifacts/types";
import type { ProductConfig, SiteInput } from "../src/common/config/types";
import type { CheckedTask } from "./config/check";
import { ConfigError } from "./config/errors";
import type { ProductList } from "./config/product-list";
import { allSecretValues } from "./config/secrets";
import {
  builtRef,
  checkoutWarnings,
  dryRunReport,
  pluginText,
  type DryRunOptions,
} from "./dry-run";
import { prepareStart, type PreparedStart } from "./start";

/**
 * The dry run's report over the committed example config, loaded through `prepareStart` and the real
 * loader, against a product list whose sites the suite's own `loadSites` read from a temporary
 * `sites.json` — the example's cells are not every checkout's real cells.
 */

/** The committed example config. */
const EXAMPLE = resolve(import.meta.dirname, "config.example.json");

/** BackWPup's artifact manifest, as its config declares it: `develop`, a required `9.99.99`. */
const BACKWPUP_ARTIFACTS: ProductArtifacts = {
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

/** A manifest whose source names its version (WP Rocket's kind). */
const EMBEDDED_ARTIFACTS: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop" },
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

/** A site as a sites file declares it. */
type Site = SiteInput;

/**
 * An SSH site on `host`.
 *
 * @param baseURL - its address.
 * @param host - its server, as written.
 * @param extra - fields to override.
 * @returns the site.
 */
function sshSite(
  baseURL: string,
  host: string,
  extra: Partial<Site> = {},
): Site {
  return {
    baseURL,
    username: "admin",
    password: "site-password-0001",
    transport: {
      mode: "ssh",
      host,
      username: "ubuntu",
      privateKeyPath: "/k",
      rootDir: "/var/www",
    },
    ...extra,
  };
}

/** The example's two cells, each with real sites. */
const EXAMPLE_SITES: Readonly<Record<string, readonly Site[]>> = {
  "pro@nginx": [
    sshSite("https://bwu2.qa.test", "QA-LNMP"),
    sshSite("https://bwu3.qa.test", "qa-lnmp"),
  ],
  "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
};

/** This spec's folder of its own: the checkout the paths are shown from. */
let checkout: string;

test.beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), "e2e-dry-run-"));
});

test.afterEach(async () => {
  await rm(checkout, { recursive: true, force: true });
});

/**
 * A product list of BackWPup alone, its cells read by the suite's `loadSites` from a `sites.json`
 * written in this spec's folder.
 *
 * @param sites - each cell's sites; the example's by default.
 * @param artifacts - the product's manifest; BackWPup's by default.
 * @returns the list.
 */
async function productList(
  sites: Readonly<Record<string, readonly Site[]>> = EXAMPLE_SITES,
  artifacts: ProductArtifacts = BACKWPUP_ARTIFACTS,
): Promise<ProductList> {
  const dir = await mkdtemp(join(checkout, "sites-"));
  await writeFile(
    join(dir, "sites.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(sites).map(([cell, pool]) => [
          cell,
          { edition: cell.startsWith("pro") ? "pro" : "free", sites: pool },
        ]),
      ),
    ),
  );
  const product: ProductConfig = {
    name: "backwpup",
    features: "features/*.feature",
    steps: [],
    sites: loadSites(dir),
    artifacts,
  };
  const PRODUCTS = [product];
  return {
    PRODUCTS,
    productByName: (name) => {
      if (name !== product.name) throw new Error(`no product ${name}`);
      return product;
    },
    playwrightConfigFor: ({ name }) => `playwright.${name}.config.ts`,
  };
}

/**
 * The example config, as data to change.
 *
 * @returns a fresh copy.
 */
function example(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
}

/**
 * The example's tasks, to change in place.
 *
 * @param config - a config from {@link example}.
 * @returns its tasks.
 */
function tasksOf(config: Record<string, unknown>): Record<string, unknown>[] {
  return config.tasks as Record<string, unknown>[];
}

/**
 * Writes `config` to `<checkout>/<folder>/config.json` and runs the dry run's report over it, as the
 * command does.
 *
 * @param config - the config.
 * @param options - `--task`, the product list, the file's mode and folder, the state's warnings, and
 *   whether paths are shown from the checkout.
 * @returns the report's lines.
 */
async function report(
  config: unknown,
  options: {
    tasks?: readonly string[];
    list?: ProductList;
    mode?: number;
    folder?: string;
    stateWarnings?: readonly string[];
    absolute?: boolean;
    /** The checkout paths are shown from, in place of this spec's folder. */
    shownFrom?: string;
    /** Sites put in a selected cell's place after the check, which would refuse them. */
    pastCheck?: Readonly<Record<string, CheckedTask["cell"]["sites"]>>;
  } = {},
): Promise<string[]> {
  const dir = join(checkout, options.folder ?? ".orchestrator");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify(config));
  await chmod(file, options.mode ?? 0o600);
  const list = options.list ?? (await productList());
  const prepared = await prepareStart(
    {
      config: file,
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
    },
    { loadProductList: () => Promise.resolve(list) },
  );
  const pastCheck = options.pastCheck ?? {};
  const shown: PreparedStart = {
    ...prepared,
    selected: prepared.selected.map((checked) => {
      const sites = pastCheck[checked.task.cell];
      return sites === undefined
        ? checked
        : { ...checked, cell: { ...checked.cell, sites } };
    }),
  };
  const reportOptions: DryRunOptions = {
    ...(options.absolute === true
      ? {}
      : { checkout: options.shownFrom ?? checkout }),
    ...(options.stateWarnings === undefined
      ? {}
      : { stateWarnings: options.stateWarnings }),
  };
  return dryRunReport(shown, reportOptions);
}

test.describe("dryRunReport", () => {
  test("over the example: each task, the plugin it builds, its sites and servers, the runs, the notifications by name", async () => {
    expect(await report(example())).toEqual([
      "dry run · nothing is run · config .orchestrator/config.json · state .orchestrator/",
      "2 tasks (bpng, bfap)",
      "bpng · BackWPup Pro on nginx",
      "  backwpup pro@nginx · develop · version 9.99.99 · every scenario · cooldown 5m",
      "  site https://bwu2.qa.test · QA-LNMP",
      "  site https://bwu3.qa.test · qa-lnmp",
      "bfap · BackWPup Free on Apache, smoke only",
      "  backwpup free@apache · develop (default) · version 9.99.99 (default) · grep @smoke · cooldown 5m",
      "  site https://bwu4.qa.test · qa-apache",
      "servers: QA-LNMP (bpng), qa-apache (bfap)",
      "runs: retries 2 · reports kept 20",
      "reports: bundle archive · Allure traces strip",
      'notifications: slack ("E2E Orchestrator", scp from auto-e2e) · datator',
      "secrets for the runs: GITHUB_TOKEN, BWP_S3_ACCESS_KEY_ID, BWP_S3_SECRET_ACCESS_KEY",
      "no warnings",
    ]);
  });

  test("without a checkout, the paths are absolute", async () => {
    const dir = join(checkout, ".orchestrator");
    expect((await report(example(), { absolute: true }))[0]).toBe(
      `dry run · nothing is run · config ${join(dir, "config.json")} · state ${dir}/`,
    );
  });

  test("--task: only the tasks selected, and only their servers", async () => {
    const lines = await report(example(), { tasks: ["bfap"] });
    expect(lines.slice(1, 5)).toEqual([
      "1 task (bfap)",
      "bfap · BackWPup Free on Apache, smoke only",
      "  backwpup free@apache · develop (default) · version 9.99.99 (default) · grep @smoke · cooldown 5m",
      "  site https://bwu4.qa.test · qa-apache",
    ]);
    expect(lines).toContain("servers: qa-apache (bfap)");
    expect(lines.join("\n")).not.toContain("bpng");
  });

  test("an unknown --task is the loader's ConfigError, before any report", async () => {
    await expect(report(example(), { tasks: ["zzzz"] })).rejects.toThrow(
      ConfigError,
    );
  });

  test("a task without a name is its id; a server two tasks share lists both, as first written", async () => {
    const config = example();
    delete tasksOf(config)[0]?.name;
    const lines = await report(config, {
      list: await productList({
        "pro@nginx": [sshSite("https://bwu2.qa.test", "Qa-Lnmp")],
        "free@apache": [sshSite("https://bwu4.qa.test", "qa-lnmp")],
      }),
    });
    expect(lines[2]).toBe("bpng");
    expect(lines).toContain("servers: Qa-Lnmp (bpng, bfap)");
  });

  test("warnings, each on its own line: the state directory's first, then the file's mode, an ignored version, a crowded server", async () => {
    const config = example();
    const tasks = tasksOf(config);
    tasks[0] = {
      ...tasks[0],
      plugin: { ref: "release:latest-stable", version: "1.2.3" },
    };
    config.serverWarningThreshold = 1;
    const lines = await report(config, {
      mode: 0o644,
      stateWarnings: ["a start would be refused: the state directory is open"],
    });
    const file = join(checkout, ".orchestrator", "config.json");
    expect(lines).toContain(
      "  backwpup pro@nginx · release:latest-stable · version 1.2.3 ignored: from the release · every scenario · cooldown 5m",
    );
    expect(lines.slice(-5)).toEqual([
      "warning: a start would be refused: the state directory is open",
      `warning: ${file} is mode 0644 and holds secrets: chmod 600 ${file}`,
      "warning: tasks[0].plugin.version is ignored: a release: ref builds the version its tag names",
      "warning: qa-lnmp carries 1 task at once (serverWarningThreshold 1): bpng (backwpup pro@nginx)",
      "warning: qa-apache carries 1 task at once (serverWarningThreshold 1): bfap (backwpup free@apache)",
    ]);
    expect(lines).not.toContain("no warnings");
  });

  test("the state directory's warnings alone are warnings too", async () => {
    const lines = await report(example(), { stateWarnings: ["held"] });
    expect(lines.at(-1)).toBe("warning: held");
    expect(lines).not.toContain("no warnings");
  });

  test("nothing optional configured: the product's default plugin, no notifications, no secrets, the suite's defaults", async () => {
    const lines = await report({
      tasks: [
        { id: "bpng", type: "loop", product: "backwpup", cell: "pro@nginx" },
      ],
    });
    expect(lines[3]).toBe(
      "  backwpup pro@nginx · develop (default) · version 9.99.99 (default) · every scenario · cooldown 5m",
    );
    expect(lines.slice(-5)).toEqual([
      "runs: retries the suite's default · reports kept the suite's default",
      "reports: bundle archive (default) · Allure traces strip (default)",
      "notifications: none",
      "secrets for the runs: none",
      "no warnings",
    ]);
  });

  test("names the bundle each run gets: the mode and traces chosen, or none and no Allure", async () => {
    const task = {
      id: "bpng",
      type: "loop",
      product: "backwpup",
      cell: "pro@nginx",
    };
    expect(
      await report({
        tasks: [task],
        reports: { bundle: { mode: "both" } },
      }),
    ).toContain("reports: bundle both · Allure traces strip (default)");
    expect(
      await report({
        tasks: [task],
        reports: { bundle: { traces: "keep" } },
      }),
    ).toContain("reports: bundle archive (default) · Allure traces keep");
    expect(
      await report({
        tasks: [task],
        reports: { bundle: { mode: "none", traces: "keep" } },
      }),
    ).toContain("reports: bundle none · no Allure report");
  });

  test("a task's own cooldown and version on the default ref", async () => {
    const lines = await report({
      tasks: [
        {
          id: "bpng",
          type: "loop",
          product: "backwpup",
          cell: "pro@nginx",
          cooldownMinutes: 30,
          plugin: { version: "5.99.99" },
        },
      ],
    });
    expect(lines[3]).toBe(
      "  backwpup pro@nginx · develop (default) · version 5.99.99 · every scenario · cooldown 30m",
    );
  });

  test("Slack with only the scp host; each notification alone; reports kept without a cap", async () => {
    const { notifications } = example() as {
      notifications: Record<string, unknown>;
    };
    const base = {
      tasks: [
        { id: "bpng", type: "loop", product: "backwpup", cell: "pro@nginx" },
      ],
      runs: { reportsKeep: 0 },
    };
    const slack = await report({
      ...base,
      notifications: { slack: notifications.slack },
    });
    expect(slack).toContain("notifications: slack");
    expect(slack).toContain(
      "runs: retries the suite's default · reports kept without a cap",
    );
    expect(
      await report({
        ...base,
        reports: { sshHost: "auto-e2e" },
        notifications: { slack: notifications.slack },
      }),
    ).toContain("notifications: slack (scp from auto-e2e)");
    expect(
      await report({
        ...base,
        instance: "nginx",
        notifications: { slack: notifications.slack },
      }),
    ).toContain('notifications: slack ("nginx")');
    // The instance and the scp host shape Slack's messages: said only with Slack.
    expect(
      await report({
        ...base,
        instance: "nginx",
        reports: { sshHost: "auto-e2e" },
        notifications: { datator: notifications.datator },
      }),
    ).toContain("notifications: datator");
  });

  test("never a secret: one planted in every field that holds one, and in names, paths, refs, a host and URLs", async () => {
    const S = {
      github: "ghtokenvalue0000aaaa",
      storage: "storage Password 0001",
      s3: "s3secretvalue0002bbbb",
      slack: "slacktokenvalue0003cccc",
      datator: "datatorkeyvalue0004dddd",
      site: "sitepasswordvalue0005",
      ftp: "ftppasswordvalue0006",
      s3key: "s3overridekey0007eeee",
      s3secret: "s3overridesecret0008",
    };
    const config = example();
    config.instance = `nginx ${S.datator}`;
    config.secrets = {
      GITHUB_TOKEN: S.github,
      BWP_STORAGE_PASSWORD: S.storage,
      BWP_S3_SECRET_ACCESS_KEY: S.s3,
    };
    config.notifications = {
      slack: {
        webhookUrl: `https://hooks.slack.com/services/T0/B0/${S.slack}`,
      },
      datator: { url: "https://datator.example.org/e2e/", apiKey: S.datator },
    };
    config.reports = { sshHost: S.s3key };
    const tasks = tasksOf(config);
    tasks[0] = {
      ...tasks[0],
      name: `Pro ${S.site}`,
      plugin: { ref: S.github, version: "9.99.99" },
    };
    tasks[1] = {
      ...tasks[1],
      name: `Free ${S.ftp}`,
      plugin: { ref: S.s3 },
      grep: `@smoke|${S.slack}`,
    };
    const withCredentials = sshSite(
      `https://admin:${S.ftp}@bwu2.qa.test/?token=${S.ftp}#${S.ftp}`,
      "qa-lnmp",
      {
        password: S.site,
        overrides: {
          storage: {
            ftp: { password: S.ftp },
            s3: { accessKeyId: S.s3key, secretAccessKey: S.s3secret },
          },
        },
      },
    );
    const list = await productList({
      "pro@nginx": [withCredentials],
      "free@apache": [
        sshSite(`https://bwu4.qa.test/${S.s3secret}/`, "qa-apache"),
      ],
    });
    // In the path too, and the mode warning quotes it.
    const lines = await report(config, {
      list,
      mode: 0o644,
      folder: `state-${S.storage}`,
    });
    const output = lines.join("\n");
    for (const secret of Object.values(S))
      expect(output, secret).not.toContain(secret);
    const loaded = {
      secrets: config.secrets as Record<string, string>,
      notifications: config.notifications as never,
    };
    const cells = Object.values(list.PRODUCTS[0]?.sites ?? {});
    for (const secret of allSecretValues(
      loaded,
      cells.map((cell) => ({ cell })),
    ))
      expect(output, secret).not.toContain(secret);
    // What is shown around a masked value is still there.
    expect(lines[2]).toBe("bpng · Pro ***");
    expect(lines[3]).toBe(
      "  backwpup pro@nginx · *** · version 9.99.99 · every scenario · cooldown 5m",
    );
    expect(lines[4]).toBe("  site https://***@bwu2.qa.test/ · qa-lnmp");
    expect(lines).toContain("bfap · Free ***");
    expect(lines).toContain(
      "  backwpup free@apache · *** · version 9.99.99 (default) · grep @smoke|*** · cooldown 5m",
    );
    expect(lines).toContain("  site https://bwu4.qa.test/***/ · qa-apache");
    expect(lines).toContain(
      'notifications: slack ("nginx ***", scp from ***) · datator',
    );
    expect(lines).toContain(
      "secrets for the runs: GITHUB_TOKEN, BWP_STORAGE_PASSWORD, BWP_S3_SECRET_ACCESS_KEY",
    );
    expect(lines[0]).toContain("state-***");
    expect(lines.at(-1)).toMatch(/^warning: .*state-\*\*\*.* is mode 0644/);
  });

  test("a secret pasted as a host, or into a URL a parser would encode, is masked as written and as normalised", async () => {
    const host = "Host-Secret-Value-0009";
    const spaced = "My Pass@word12";
    const config = example();
    config.serverWarningThreshold = 1;
    config.secrets = { BWP_HOST: host, BWP_SPACED: spaced };
    const lines = await report(config, {
      list: await productList({
        "pro@nginx": [sshSite(`https://bwu2.qa.test/${spaced}/`, host)],
        "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
      }),
    });
    const output = lines.join("\n");
    for (const value of [
      host,
      host.toLowerCase(),
      spaced,
      encodeURI(spaced),
      "word12",
    ])
      expect(output, value).not.toContain(value);
    expect(lines[4]).toBe("  site https://bwu2.qa.test/***/ · ***");
    expect(lines).toContain("servers: *** (bpng), qa-apache (bfap)");
    // The suite's own warning lowercases the host: that form is masked too.
    expect(lines).toContain(
      "warning: *** carries 1 task at once (serverWarningThreshold 1): bpng (backwpup pro@nginx)",
    );
  });

  test("a secret in a site's address is masked before the address is cut to what is shown: none of it shows", async () => {
    // Showing the address drops what follows `?`, and cleaning makes a tab a space: either way, the
    // secret is no longer whole in what is shown, so only masking it first hides it.
    for (const [password, shown] of [
      ["Secretpass99?part", "  site https://bwu2.qa.test/*** · qa-lnmp"],
      ["Secret\tpass99-0042", "  site https://bwu2.qa.test/*** · qa-lnmp"],
    ] as const) {
      const site = sshSite(`https://bwu2.qa.test/${password}`, "qa-lnmp", {
        password,
      });
      const lines = await report(example(), {
        pastCheck: { "pro@nginx": [site] },
        list: await productList({
          "pro@nginx": [site],
          "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
        }),
      });
      expect(lines[4], JSON.stringify(password)).toBe(shown);
      const output = lines.join("\n");
      for (const part of ["Secretpass99", "Secret pass99", "pass99"])
        expect(output, JSON.stringify(password)).not.toContain(part);
    }
  });

  test("a site password that is a word elsewhere masks only itself: the product's name stays", async () => {
    const config = example();
    config.serverWarningThreshold = 1;
    const lines = await report(config, {
      list: await productList({
        "pro@nginx": [
          sshSite("https://bwu2.qa.test", "qa-lnmp", { password: "BackWPup" }),
        ],
        "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
      }),
    });
    expect(lines[3]).toBe(
      "  backwpup pro@nginx · develop · version 9.99.99 · every scenario · cooldown 5m",
    );
    expect(lines).toContain(
      "warning: qa-lnmp carries 1 task at once (serverWarningThreshold 1): bpng (backwpup pro@nginx)",
    );
  });

  test("the orchestrator's own E2E_PLUGIN_REF and E2E_PLUGIN_VERSION never reach the report: a run is given only its task's", async () => {
    const saved = {
      ref: process.env.E2E_PLUGIN_REF,
      version: process.env.E2E_PLUGIN_VERSION,
    };
    process.env.E2E_PLUGIN_REF = "feature/from-the-shell";
    process.env.E2E_PLUGIN_VERSION = "1.0.0";
    try {
      const lines = await report(example());
      expect(lines[3]).toBe(
        "  backwpup pro@nginx · develop · version 9.99.99 · every scenario · cooldown 5m",
      );
      expect(lines[7]).toBe(
        "  backwpup free@apache · develop (default) · version 9.99.99 (default) · grep @smoke · cooldown 5m",
      );
    } finally {
      for (const [name, value] of [
        ["E2E_PLUGIN_REF", saved.ref],
        ["E2E_PLUGIN_VERSION", saved.version],
      ] as const)
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
    }
  });

  test("a field holding a secret is never printed — even a value too short to mask", async () => {
    // Under 8 characters, no value is masked: only never printing the field keeps it out.
    const S = {
      github: "~Q1~",
      storage: "~Q2~",
      slack: "~Q3~",
      datator: "~Q4~",
      site: "~Q5~",
      ftp: "~Q6~",
      s3key: "~Q7~",
      s3secret: "~Q8~",
    };
    const config = example();
    config.secrets = {
      GITHUB_TOKEN: S.github,
      BWP_S3_SECRET_ACCESS_KEY: S.storage,
    };
    config.notifications = {
      slack: {
        webhookUrl: `https://hooks.slack.com/services/T0/B0/${S.slack}`,
      },
      datator: { url: "https://datator.example.org/e2e/", apiKey: S.datator },
    };
    const site = sshSite(
      `https://admin:${S.ftp}@bwu2.qa.test/?token=${S.s3key}#${S.s3secret}`,
      "qa-lnmp",
      {
        password: S.site,
        overrides: {
          storage: {
            ftp: { password: S.ftp },
            s3: { accessKeyId: S.s3key, secretAccessKey: S.s3secret },
          },
        },
      },
    );
    const output = (
      await report(config, {
        list: await productList({
          "pro@nginx": [site],
          "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
        }),
      })
    ).join("\n");
    for (const secret of Object.values(S))
      expect(output, secret).not.toContain(secret);
    // Nor the endpoints: a notification is named, never addressed.
    expect(output).not.toContain("hooks.slack.com");
    expect(output).not.toContain("datator.example.org");
    expect(output).not.toContain("admin");
  });

  test("a task not selected still has its sites' credentials masked", async () => {
    const password = "unselected-site-password-0009";
    const config = example();
    const tasks = tasksOf(config);
    tasks[1] = { ...tasks[1], name: `Free ${password}` };
    const lines = await report(config, {
      tasks: ["bfap"],
      list: await productList({
        "pro@nginx": [sshSite("https://bwu2.qa.test", "qa-lnmp", { password })],
        "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
      }),
    });
    expect(lines[2]).toBe("bfap · Free ***");
  });

  test("a site's malformed address is masked, or a stand-in, never its text", async () => {
    // The config's check refuses a site that is no http(s) URL, without quoting it: the report itself
    // still never prints one, should one reach it.
    const malformed = {
      "pro@nginx": [
        sshSite("https://admin:pa/ss-word9@bwu2.qa.test/", "qa-lnmp"),
        sshSite("foo:admin:s3cr3tpw@host", "qa-lnmp"),
      ],
      "free@apache": [sshSite("not a url at all", "qa-apache")],
    };
    const refusal = await report(example(), {
      list: await productList(malformed),
    }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(refusal).toContain("whose baseURL is no http(s) URL");
    for (const value of ["s3cr3tpw", "not a url"])
      expect(refusal).not.toContain(value);
    const lines = await report(example(), { pastCheck: malformed });
    // A password a parser would refuse is masked by its shape first: the address is then whole.
    expect(lines.slice(4, 6)).toEqual([
      "  site https://***@bwu2.qa.test/ · qa-lnmp",
      `  site ${NOT_A_SITE_URL} · qa-lnmp`,
    ]);
    expect(lines).toContain(`  site ${NOT_A_SITE_URL} · qa-apache`);
    const output = lines.join("\n");
    for (const value of ["pa/ss-word9", "s3cr3tpw", "not a url"])
      expect(output).not.toContain(value);
  });

  test("an indented line keeps its indentation within the cap", async () => {
    const lines = await report(example(), {
      list: await productList({
        "pro@nginx": [
          // Past the line's cap, within a site key's (2,048), which the check refuses past.
          sshSite(`https://bwu2.qa.test/${"p".repeat(2_030)}`, "qa-lnmp"),
        ],
        "free@apache": [sshSite("https://bwu4.qa.test", "qa-apache")],
      }),
    });
    const site = lines[4] ?? "";
    expect(site.startsWith("  site https://bwu2.qa.test/ppp")).toBe(true);
    expect(Array.from(site)).toHaveLength(2_000);
    expect(site.endsWith("…")).toBe(true);
  });

  test("every line is one line, cut to its cap", async () => {
    const lines = await report(example(), {
      stateWarnings: [`two\nlines\u2028${"w".repeat(3_000)}`],
    });
    const warning = lines.find((line) => line.startsWith("warning:")) ?? "";
    expect(warning.startsWith("warning: two lines w")).toBe(true);
    expect(Array.from(warning)).toHaveLength(2_000);
    expect(warning.endsWith("…")).toBe(true);
  });
});

test.describe("checkoutWarnings", () => {
  const WARNED = "a pasted scp command may fail; move it to such a path";

  test("a checkout no shell reads specially is said nothing of", () => {
    expect(checkoutWarnings("/srv/wp-media-e2e_1.0@x", "auto-e2e")).toEqual([]);
  });

  test("a space, a quote, $, a backtick or a backslash in the checkout is warned of, naming it", () => {
    for (const checkout of [
      "/srv/my e2e",
      "/srv/it's",
      "/srv/$HOME",
      "/srv/a`b`",
      "/srv/a\\b",
    ]) {
      const [warning, ...more] = checkoutWarnings(checkout, "auto-e2e");
      expect(more).toEqual([]);
      expect(warning).toContain(JSON.stringify(checkout));
      expect(warning).toContain(WARNED);
    }
  });

  test("nothing without an scp host (no command is given) or a checkout", () => {
    expect(checkoutWarnings("/srv/my e2e", undefined)).toEqual([]);
    expect(checkoutWarnings(undefined, "auto-e2e")).toEqual([]);
  });

  test("the dry run lists it among its warnings", async () => {
    const config = {
      ...(example() as object),
      reports: { sshHost: "auto-e2e" },
    };
    const lines = await report(config, { shownFrom: "/srv/my e2e" });
    expect(
      lines.filter((line) => line.startsWith("warning: the checkout ")),
    ).toEqual([
      `warning: the checkout "/srv/my e2e" has characters besides letters, digits and _@%+=:,./- — ${WARNED}`,
    ]);
    expect(await report(config)).not.toContainEqual(
      expect.stringContaining("warning: the checkout"),
    );
  });
});

test.describe("pluginText", () => {
  test("what a required-version product builds: the ref and version, each marked when it is the default", () => {
    const of = (plugin?: { ref?: string; version?: string }): string =>
      pluginText({ artifacts: BACKWPUP_ARTIFACTS, edition: "pro", plugin });
    expect(of()).toBe("develop (default) · version 9.99.99 (default)");
    expect(of({ ref: "main" })).toBe("main · version 9.99.99 (default)");
    expect(of({ ref: "main", version: "5.0.0" })).toBe("main · version 5.0.0");
    expect(of({ ref: "release:latest-stable" })).toBe(
      "release:latest-stable · version from the release",
    );
    expect(of({ ref: "release:5.4.0", version: "1.2.3" })).toBe(
      "release:5.4.0 · version 1.2.3 ignored: from the release",
    );
  });

  test("what an embedded-version product builds: the source's version unless the task names one", () => {
    const of = (plugin?: { ref?: string; version?: string }): string =>
      pluginText({ artifacts: EMBEDDED_ARTIFACTS, edition: undefined, plugin });
    expect(of()).toBe("develop (default) · version from the source");
    expect(of({ version: "3.20.0" })).toBe(
      "develop (default) · version 3.20.0",
    );
  });

  test("a manifest the planner refuses is said, never thrown", () => {
    expect(
      pluginText({
        artifacts: BACKWPUP_ARTIFACTS,
        edition: undefined,
        plugin: undefined,
      }),
    ).toMatch(/^plugin cannot be planned: \S/);
  });
});

test.describe("builtRef", () => {
  test("the ref as pluginText names it, for the started line; nothing when the planner refuses", () => {
    const of = (plugin?: {
      ref?: string;
      version?: string;
    }): string | undefined =>
      builtRef({ artifacts: BACKWPUP_ARTIFACTS, edition: "pro", plugin });
    expect(of()).toBe("develop (default)");
    expect(of({ ref: "main", version: "5.0.0" })).toBe("main");
    expect(of({ ref: "release:latest-stable" })).toBe("release:latest-stable");
    // An editioned product without an edition: the planner refuses.
    expect(
      builtRef({
        artifacts: BACKWPUP_ARTIFACTS,
        edition: undefined,
        plugin: undefined,
      }),
    ).toBeUndefined();
  });
});
