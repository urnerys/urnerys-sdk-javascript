import fs from "node:fs";
import path from "node:path";

import type { FullConfig } from "@playwright/test/reporter";

/**
 * Folder the HTML reporter writes to, or `undefined` if the HTML reporter is not configured.
 *
 * Playwright doesn't expose this path to other reporters, so this follows the rules of the HTML reporter as of Playwright
 * 1.64: the environment variable, then the `outputFolder` option, then `playwright-report` next to the nearest
 * `package.json`.
 */
export function htmlReportFolder(config: FullConfig, configDir: string): string | undefined {
  const html = config.reporter.find(([name]) => name === "html");
  if (!html) {
    return undefined;
  }

  const fromEnv = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || process.env.PLAYWRIGHT_HTML_REPORT;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  const outputFolder = (html[1] as { outputFolder?: string } | undefined)?.outputFolder;
  if (outputFolder) {
    return path.resolve(configDir, outputFolder);
  }

  return path.resolve(packageDir(configDir) ?? process.cwd(), "playwright-report");
}

function packageDir(directory: string): string | undefined {
  if (fs.existsSync(path.join(directory, "package.json"))) {
    return directory;
  }

  const parent = path.dirname(directory);
  return parent === directory ? undefined : packageDir(parent);
}
