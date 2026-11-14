import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { uploadArtifact } from "./artifact.js";
import { fetchGithubOidcToken, githubBuildId, githubCommit } from "./github.js";
import { METADATA_CONTENT_TYPE, type RealizationAttributes, type ScreenshotMetadata } from "./protocol.js";
import { htmlReportFolder } from "./report.js";

export interface UrnerysReporterOptions {
  /**
   * Name of the Urnerys project the build belongs to.
   */
  project: string;

  /**
   * Hostname of the Urnerys instance, without scheme. Defaults to `URNERYS_HOST`, then `app.urnerys.dev`.
   */
  host?: string;

  /**
   * What to do with the build once all images are uploaded: `check` creates a check against the baseline,
   * `promote` makes the build the new baseline. The build is left as is when omitted.
   */
  mode?: "check" | "promote";

  /**
   * Baseline to check against or promote to. Defaults to `production`.
   */
  baseline?: string;

  /**
   * Whether to upload the report of the Playwright HTML reporter to the build once the run is done. Defaults to `true`.
   * The upload is skipped with a warning if the HTML reporter is not configured.
   */
  report?: boolean;

  /**
   * Name of the report within the build. Defaults to `playwright-report`. Runs that upload to the same build need
   * different names, since a report replaces an earlier one with the same name.
   */
  name?: string;
}

/*
 * Passed by Playwright to every reporter, but not documented.
 */
interface PlaywrightReporterOptions {
  configDir?: string;
}

interface Session {
  build: string;

  /**
   * Returns a token that is valid for at least a few more minutes.
   */
  token(): Promise<string>;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

/*
 * Long enough for a request that starts with a token close to expiry to reach the server in time.
 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface Screenshot extends ScreenshotMetadata {
  body: Buffer;
}

function screenshotKey({ collection, snapshot, formula }: Screenshot): string {
  return JSON.stringify([collection, snapshot, formula]);
}

/*
 * Whether Playwright is done with the test after this attempt. A test is retried when it didn't end with the
 * expected status and has retries left. Playwright doesn't retry skipped or interrupted tests.
 */
function isFinalAttempt(test: TestCase, result: TestResult): boolean {
  return (
    result.status === test.expectedStatus ||
    result.status === "skipped" ||
    result.status === "interrupted" ||
    result.retry >= test.retries
  );
}

function osType(): string {
  const platform = os.platform();
  return platform === "win32" ? "windows" : platform;
}

/*
 * Returns the cached token until it gets close to expiry, then fetches a new one. A failed refresh keeps the old token,
 * so the next call tries again.
 */
function refreshingToken(initial: AccessToken, refresh: () => Promise<AccessToken>): () => Promise<string> {
  let current = Promise.resolve(initial);

  return async () => {
    const pending = current;
    const token = await pending;
    if (Date.now() < token.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return token.value;
    }

    /*
     * Concurrent callers that saw the same expiring token share one refresh.
     */
    if (current === pending) {
      current = refresh().catch((e: unknown) => {
        current = pending;
        throw e;
      });
    }

    return (await current).value;
  };
}

async function exchangeToken(host: string, subjectToken: string): Promise<AccessToken> {
  const formData = new FormData();
  formData.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
  formData.set("subject_token", subjectToken);
  formData.set("subject_token_type", "urn:ietf:params:oauth:token-type:id_token");

  const response = await fetch(`https://${host}/api/v1/token`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in?: number };
  return {
    value: access_token,
    expiresAt: expires_in === undefined ? Number.POSITIVE_INFINITY : Date.now() + expires_in * 1000,
  };
}

async function createBuild(host: string, project: string, token: string, build: string): Promise<void> {
  const response = await fetch(`https://${host}/api/v1/projects/${project}/builds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: build,
      build: { origin: { commit: githubCommit() } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create build: ${response.status}`);
  }
}

class UrnerysReporter implements Reporter {
  private host: string;

  private baseline: string;

  private session!: Promise<Session | undefined>;

  private version = "";

  private reportedRealizations = new Set<string>();

  /*
   * Screenshots of tests that may still be retried, by test id. Each attempt replaces the screenshots of earlier
   * attempts, and they are uploaded once the test is done.
   */
  private pendingScreenshots = new Map<string, Map<string, Screenshot>>();

  private uploadedScreenshots = new Set<string>();

  private uploads: Promise<void>[] = [];

  /*
   * `undefined` if the HTML reporter is not configured.
   */
  private reportFolder: string | undefined;

  constructor(private options: UrnerysReporterOptions & PlaywrightReporterOptions) {
    this.host = options.host ?? process.env.URNERYS_HOST ?? "app.urnerys.dev";
    this.baseline = options.baseline ?? "production";
  }

  onBegin(config: FullConfig): void {
    this.version = config.version;

    const configDir = this.options.configDir ?? (config.configFile ? path.dirname(config.configFile) : process.cwd());
    this.reportFolder = htmlReportFolder(config, configDir);

    this.session = this.setup().catch((e: Error) => {
      console.warn("[urnerys] Skipping uploads — setup failed:", e.message);
      return undefined;
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const screenshots = new Map<string, Screenshot>();

    for (const attachment of result.attachments) {
      if (attachment.contentType !== METADATA_CONTENT_TYPE || !attachment.body) {
        continue;
      }

      const metadata = JSON.parse(attachment.body.toString()) as ScreenshotMetadata;

      /*
       * `urnerysPageScreenshot` and `urnerysElementScreenshot` attach the image before its metadata, so it is always
       * there.
       */
      const image = result.attachments.find((a) => a.name === metadata.image && a.contentType === "image/png");
      if (!image?.body) {
        continue;
      }

      const screenshot = { ...metadata, body: image.body };
      screenshots.set(screenshotKey(screenshot), screenshot);
    }

    this.pendingScreenshots.set(test.id, screenshots);

    if (isFinalAttempt(test, result)) {
      this.uploadScreenshots(test.id);
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    /*
     * A run can end before a test reaches its final attempt, e.g. when it hits `maxFailures`.
     */
    for (const testId of [...this.pendingScreenshots.keys()]) {
      this.uploadScreenshots(testId);
    }

    await Promise.all(this.uploads);

    const session = await this.session;
    if (!session || !this.options.mode) {
      return;
    }

    const { project } = this.options;

    try {
      if (this.options.mode === "promote") {
        const response = await fetch(`https://${this.host}/api/v1/projects/${project}/baselines/${this.baseline}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await session.token()}`,
          },
          body: JSON.stringify({ baseline: { build: session.build } }),
        });
        if (!response.ok) {
          console.warn(`[urnerys] Failed to update baseline: ${response.status}`);
        }
      } else {
        const response = await fetch(`https://${this.host}/api/v1/projects/${project}/builds/${session.build}/checks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await session.token()}`,
          },
          body: JSON.stringify({ check: { baseline: this.baseline } }),
        });
        if (!response.ok) {
          console.warn(`[urnerys] Failed to create check: ${response.status}`);
        }
      }
    } catch (e) {
      console.warn(`[urnerys] Failed to finalize build ${session.build}:`, (e as Error).message);
    }
  }

  /*
   * The HTML reporter writes its files in `onEnd`, and `onExit` runs once every reporter's `onEnd` has finished.
   */
  async onExit(): Promise<void> {
    if (this.options.report === false) {
      return;
    }

    const session = await this.session;
    if (!session) {
      return;
    }

    const folder = this.reportFolder;
    if (!folder) {
      console.warn("[urnerys] Skipping the report upload — the Playwright HTML reporter is not configured");
      return;
    }

    if (!fs.existsSync(path.join(folder, "index.html"))) {
      console.warn(`[urnerys] Skipping the report upload — ${folder} has no index.html`);
      return;
    }

    try {
      const artifact = await uploadArtifact({
        host: this.host,
        project: this.options.project,
        build: session.build,
        token: await session.token(),
        name: this.options.name ?? "playwright-report",
        kind: "playwright-report",
        directory: folder,
      });
      console.log(`[urnerys] Uploaded the Playwright report: ${artifact.url}`);
    } catch (e) {
      console.warn("[urnerys] Failed to upload the Playwright report:", (e as Error).message);
    }
  }

  /*
   * Reports the realization of a formula the first time a screenshot with that formula is uploaded.
   */
  private addRealization({ formula, realization }: Screenshot): void {
    if (this.reportedRealizations.has(formula)) {
      return;
    }
    this.reportedRealizations.add(formula);

    const attributes: RealizationAttributes = {
      ...realization,
      "dev.urnerys.tool.name": "playwright",
      "dev.urnerys.tool.version": this.version,
      "dev.urnerys.os.type": osType(),
      "dev.urnerys.os.version": os.release(),
      "dev.urnerys.host.arch": os.arch(),
    };

    this.uploads.push(this.session.then((session) => session && this.uploadRealization(session, formula, attributes)));
  }

  /*
   * Uploads the screenshots from the last attempt of a test. A screenshot that was already uploaded, e.g. by another
   * test with the same collection, title, and formula, is skipped.
   */
  private uploadScreenshots(testId: string): void {
    const screenshots = this.pendingScreenshots.get(testId);
    if (!screenshots) {
      return;
    }

    this.pendingScreenshots.delete(testId);

    for (const [key, screenshot] of screenshots) {
      if (this.uploadedScreenshots.has(key)) {
        const { collection, snapshot, formula } = screenshot;
        console.warn(`[urnerys] Skipping duplicate screenshot ${collection}/${snapshot}/${formula}`);
        continue;
      }

      this.uploadedScreenshots.add(key);
      this.addRealization(screenshot);
      this.uploads.push(this.session.then((session) => session && this.uploadScreenshot(session, screenshot)));
    }
  }

  /*
   * A build id from `URNERYS_BUILD_ID` means the build was created elsewhere, so it is not created again.
   */
  private async setup(): Promise<Session> {
    const token = await this.initialToken();

    const existingBuild = process.env.URNERYS_BUILD_ID;
    const build = existingBuild ?? githubBuildId() ?? randomUUID().replaceAll("-", "").substring(0, 13);

    if (!existingBuild) {
      await createBuild(this.host, this.options.project, await token(), build);
    }

    return { token, build };
  }

  /*
   * A token from `URNERYS_TOKEN` is used as is. A token exchanged for a GitHub OIDC token expires, possibly before a
   * long run is done, so it is exchanged again when needed.
   */
  private async initialToken(): Promise<() => Promise<string>> {
    const fromEnv = process.env.URNERYS_TOKEN;
    if (fromEnv) {
      return async () => fromEnv;
    }

    return refreshingToken(await this.exchangeGithubToken(), () => this.exchangeGithubToken());
  }

  private async exchangeGithubToken(): Promise<AccessToken> {
    const oidcToken = await fetchGithubOidcToken(`https://${this.host}`);
    if (!oidcToken) {
      throw new Error("URNERYS_TOKEN is not set and no GitHub OIDC token is available");
    }

    return exchangeToken(this.host, oidcToken);
  }

  private async uploadScreenshot(session: Session, { collection, snapshot, formula, body }: Screenshot): Promise<void> {
    const formData = new FormData();
    formData.set("collection", collection);
    formData.set("snapshot", snapshot);
    formData.set("formula", formula);
    formData.set("payload", new File([new Uint8Array(body)], "screenshot.png", { type: "image/png" }));

    try {
      const response = await fetch(
        `https://${this.host}/api/v1/projects/${this.options.project}/builds/${session.build}/images`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${await session.token()}` },
          body: formData,
        },
      );
      if (!response.ok) {
        console.warn(`[urnerys] Upload failed for ${snapshot}/${formula}: ${response.status}`);
      }
    } catch (e) {
      console.warn(`[urnerys] Upload error for ${snapshot}/${formula}:`, (e as Error).message);
    }
  }

  private async uploadRealization(session: Session, formula: string, attributes: RealizationAttributes): Promise<void> {
    try {
      const response = await fetch(
        `https://${this.host}/api/v1/projects/${this.options.project}/builds/${session.build}/realizations/${encodeURIComponent(formula)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await session.token()}`,
          },
          body: JSON.stringify({ realization: { attributes } }),
        },
      );
      if (!response.ok) {
        console.warn(`[urnerys] Realization report failed for ${formula}: ${response.status}`);
      }
    } catch (e) {
      console.warn(`[urnerys] Realization report error for ${formula}:`, (e as Error).message);
    }
  }
}

export default UrnerysReporter;
