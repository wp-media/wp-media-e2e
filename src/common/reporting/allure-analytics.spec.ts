import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  ANALYTICS_MARKER,
  pagesNamingAnalytics,
  removeAllureAnalytics,
  withoutAnalytics,
} from "./allure-analytics";

/** The loader exactly as Allure 3.18's awesome plugin renders it into a folder report's page. */
const LOADER = [
  `    <script async src="https://www.googletagmanager.com/gtag/js?id=G-LNDJ3J7WT0"></script>`,
  `    <script>`,
  `        window.dataLayer = window.dataLayer || [];`,
  `        function gtag(){dataLayer.push(arguments);}`,
  `        gtag('js', new Date());`,
  `        gtag('config', 'G-LNDJ3J7WT0', {`,
  `          "report": "awesome",`,
  `          "allureVersion": "3.18.0",`,
  `          "reportUuid": "7f4dd7a2-0961-4c7d-a30f-845b6ae87bbf",`,
  `          "single_file": "false"`,
  `        });`,
  `    </script>`,
  ``,
].join("\n");

/** The page around it, as Allure writes it: the app's script before, the data script after. */
const BEFORE = `<!DOCTYPE html>\n<html>\n<body>\n    <div id="app"></div>\n    <script   src="app-1.js"></script>\n`;
const AFTER = `    \n      <script async>\n        window.allureReportDataReady = true;\n      </script>\n</body>\n</html>\n`;

/** A page holding the loader. */
const PAGE = `${BEFORE}${LOADER}${AFTER}`;

let root: string;

test.beforeEach(() => {
  root = tempRoot("allure-analytics-");
});

test.afterEach(() => {
  removeTempRoot(root);
});

test.describe("withoutAnalytics", () => {
  test("removes the loader block whole, lines and all, and changes nothing around it", () => {
    expect(withoutAnalytics(PAGE)).toEqual({
      kind: "removed",
      html: `${BEFORE}${AFTER}`,
    });
  });

  test("a page that never names the tag manager is nothing to do", () => {
    expect(withoutAnalytics(`${BEFORE}${AFTER}`)).toEqual({ kind: "none" });
  });

  test("matches the values Allure fills in, for either plugin and layout", () => {
    const dashboard = LOADER.replace('"awesome"', '"dashboard"')
      .replace('"3.18.0"', '"3.22.1"')
      .replace('"false"', '"true"')
      .replace(
        "7f4dd7a2-0961-4c7d-a30f-845b6ae87bbf",
        "06500d84-282e-4851-ad9d-20d837d2ed3a",
      );

    expect(withoutAnalytics(`${BEFORE}${dashboard}${AFTER}`).kind).toBe(
      "removed",
    );
  });

  test("a block that differs from the template in any way is left, never partly removed", () => {
    for (const changed of [
      // Another call in the setup.
      LOADER.replace(
        "gtag('js', new Date());",
        "gtag('js', new Date()); gtag('set', {});",
      ),
      // The two ids disagree.
      LOADER.replace("'G-LNDJ3J7WT0', {", "'G-OTHER000', {"),
      // A line more.
      LOADER.replace(
        `"single_file": "false"`,
        `"single_file": "false",\n          "extra": "1"`,
      ),
      // Windows line ends.
      LOADER.replace(/\n/g, "\r\n"),
      // The script from another host.
      LOADER.replace(
        "www.googletagmanager.com",
        "evil.example/googletagmanager.com",
      ),
      // A value outside what Allure fills in: a plugin name, a single-file flag.
      LOADER.replace('"report": "awesome"', '"report": "Awesome Report"'),
      LOADER.replace('"single_file": "false"', '"single_file": "yes"'),
      // A blank line inside the block: each line must follow the one before.
      LOADER.replace("</script>\n    <script>", "</script>\n\n    <script>"),
    ]) {
      const page = `${BEFORE}${changed}${AFTER}`;
      const outcome = withoutAnalytics(page);
      expect(outcome.kind, changed).toBe("unrecognised");
    }
  });

  test("two blocks, or the tag manager named elsewhere too, leave the page as it is", () => {
    expect(withoutAnalytics(`${BEFORE}${LOADER}${LOADER}${AFTER}`)).toEqual({
      kind: "unrecognised",
      blocks: 2,
    });
    expect(
      withoutAnalytics(
        `${BEFORE}${LOADER}<!-- ${ANALYTICS_MARKER} -->${AFTER}`,
      ),
    ).toEqual({ kind: "unrecognised", blocks: 1 });
    expect(
      withoutAnalytics(`${BEFORE}<p>${ANALYTICS_MARKER}</p>${AFTER}`),
    ).toEqual({
      kind: "unrecognised",
      blocks: 0,
    });
  });
});

test.describe("removeAllureAnalytics", () => {
  /** Writes a report's page, creating its folder. */
  function page(relative: string, content: string | Buffer): string {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  test("cleans the top page and each plugin's, keeping their modes; other files are not read", () => {
    const awesome = page("awesome/index.html", PAGE);
    chmodSync(awesome, 0o640);
    page("dashboard/index.html", PAGE.replace('"awesome"', '"dashboard"'));
    page("index.html", `${BEFORE}${AFTER}`);
    // Not a page: never touched, whatever it holds.
    const data = page("awesome/data/x.json", PAGE);

    return removeAllureAnalytics(root).then((cleanup) => {
      expect(cleanup).toEqual({
        cleaned: ["awesome/index.html", "dashboard/index.html"],
        left: [],
      });
      expect(readFileSync(awesome, "utf8")).toBe(`${BEFORE}${AFTER}`);
      expect(statSync(awesome).mode & 0o777).toBe(0o640);
      expect(readFileSync(data, "utf8")).toBe(PAGE);
      // Nothing left beside the pages.
      expect(readdirSync(join(root, "awesome")).sort()).toEqual([
        "data",
        "index.html",
      ]);
    });
  });

  test("every other byte comes back as it was, invalid UTF-8 included", async () => {
    const odd = Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80]);
    const original = Buffer.concat([
      Buffer.from(BEFORE),
      odd,
      Buffer.from(LOADER),
      odd,
      Buffer.from(AFTER),
    ]);
    const path = page("awesome/index.html", original);

    await removeAllureAnalytics(root);

    expect(readFileSync(path)).toEqual(
      Buffer.concat([Buffer.from(BEFORE), odd, odd, Buffer.from(AFTER)]),
    );
  });

  test("a page it does not recognise is named and left byte for byte", async () => {
    const twice = `${BEFORE}${LOADER}${LOADER}${AFTER}`;
    const path = page("awesome/index.html", twice);

    expect(await removeAllureAnalytics(root)).toEqual({
      cleaned: [],
      left: ["awesome/index.html"],
    });
    expect(readFileSync(path, "utf8")).toBe(twice);
  });

  test("never follows a link, to a page or to a folder", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "index.html"), PAGE);
    const report = join(root, "report");
    mkdirSync(report);
    symlinkSync(join(outside, "index.html"), join(report, "linked.html"));
    symlinkSync(outside, join(report, "plugin"));

    expect(await removeAllureAnalytics(report)).toEqual({
      cleaned: [],
      left: [],
    });
    expect(readFileSync(join(outside, "index.html"), "utf8")).toBe(PAGE);
  });

  test("any page in a plugin's folder is cleaned, not only its index.html", async () => {
    const other = page("awesome/other.html", PAGE);

    expect(await removeAllureAnalytics(root)).toEqual({
      cleaned: ["awesome/other.html"],
      left: [],
    });
    expect(readFileSync(other, "utf8")).toBe(`${BEFORE}${AFTER}`);
  });

  test("pages deeper than a plugin's folder are not Allure's: left alone", async () => {
    const deep = page("awesome/widgets/index.html", PAGE);

    expect(await removeAllureAnalytics(root)).toEqual({
      cleaned: [],
      left: [],
    });
    expect(readFileSync(deep, "utf8")).toBe(PAGE);
  });
});

test.describe("pagesNamingAnalytics", () => {
  test("names the pages that still name the tag manager, and only those", async () => {
    mkdirSync(join(root, "awesome"));
    mkdirSync(join(root, "dashboard"));
    writeFileSync(join(root, "awesome", "index.html"), PAGE);
    writeFileSync(join(root, "dashboard", "index.html"), `${BEFORE}${AFTER}`);
    writeFileSync(join(root, "index.html"), `<p>${ANALYTICS_MARKER}</p>`);

    expect(await pagesNamingAnalytics(root)).toEqual([
      "awesome/index.html",
      "index.html",
    ]);
  });

  test("a page that cannot be read is named: it cannot be shown clean", async () => {
    test.skip(process.getuid?.() === 0, "root reads any file");
    writeFileSync(join(root, "index.html"), `${BEFORE}${AFTER}`);
    chmodSync(join(root, "index.html"), 0o000);

    expect(await pagesNamingAnalytics(root)).toEqual(["index.html"]);
  });

  test("a report that cannot be listed names nothing", async () => {
    expect(await pagesNamingAnalytics(join(root, "missing"))).toEqual([]);
  });
});
