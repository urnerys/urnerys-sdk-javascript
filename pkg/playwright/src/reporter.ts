import { randomUUID } from "node:crypto";
import os from "node:os";

import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { fetchGithubOidcToken, githubBuildId, githubCommit } from "./github.js";

export interface UrnerysReporterOptions {
  /** Name of the Urnerys project the build belongs to. */
  project: string;

  /** Hostname of the Urnerys instance, without scheme. Defaults to `URNERYS_HOST`, then `app.urnerys.dev`. */
  host?: string;

  /**
   * What to do with the build once all images are uploaded: `check` creates a check against the baseline,
   * `promote` makes the build the new baseline. The build is left as is when omitted.
   */
  mode?: "check" | "promote";

  /** Baseline to check against or promote to. Defaults to `production`. */
  baseline?: string;
}

interface Session {
  token: string;
  build: string;
}

function osType(): string {
  const platform = os.platform();
  return platform === "win32" ? "windows" : platform;
}

async function exchangeToken(host: string, subjectToken: string): Promise<string> {
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

  const { access_token } = (await response.json()) as { access_token: string };
  return access_token;
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

  private uploads: Promise<void>[] = [];

  constructor(private options: UrnerysReporterOptions) {
    this.host = options.host ?? process.env.URNERYS_HOST ?? "app.urnerys.dev";
    this.baseline = options.baseline ?? "production";
  }

  onBegin(config: FullConfig): void {
    this.version = config.version;

    this.session = this.setup().catch((e: Error) => {
      console.warn("[urnerys] Skipping uploads — setup failed:", e.message);
      return undefined;
    });
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name.startsWith("urnerys-realization|") && attachment.body) {
        const formula = attachment.name.slice("urnerys-realization|".length);

        if (!this.reportedRealizations.has(formula)) {
          this.reportedRealizations.add(formula);

          const attributes = {
            ...(JSON.parse(attachment.body.toString()) as Record<string, string | number>),
            "dev.urnerys.tool.name": "playwright",
            "dev.urnerys.tool.version": this.version,
            "dev.urnerys.os.type": osType(),
            "dev.urnerys.os.version": os.release(),
            "dev.urnerys.host.arch": os.arch(),
          };

          this.uploads.push(
            this.session.then((session) => session && this.reportRealization(session, formula, attributes)),
          );
        }
      }

      if (!attachment.name.startsWith("urnerys|") || !attachment.body) continue;

      const [, collection, snapshot, formula] = attachment.name.split("|");
      const body = attachment.body;

      this.uploads.push(
        this.session.then((session) => session && this.uploadOne(session, collection, snapshot, formula, body)),
      );
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
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
            Authorization: `Bearer ${session.token}`,
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
            Authorization: `Bearer ${session.token}`,
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
   * A build id from `URNERYS_BUILD_ID` means the build was created elsewhere, so it is not created again.
   */
  private async setup(): Promise<Session> {
    const token = process.env.URNERYS_TOKEN ?? (await this.exchangeGithubToken());

    const existingBuild = process.env.URNERYS_BUILD_ID;
    const build = existingBuild ?? githubBuildId() ?? randomUUID().replaceAll("-", "").substring(0, 13);

    if (!existingBuild) {
      await createBuild(this.host, this.options.project, token, build);
    }

    return { token, build };
  }

  private async exchangeGithubToken(): Promise<string> {
    const oidcToken = await fetchGithubOidcToken(`https://${this.host}`);
    if (!oidcToken) {
      throw new Error("URNERYS_TOKEN is not set and no GitHub OIDC token is available");
    }

    return exchangeToken(this.host, oidcToken);
  }

  private async uploadOne(
    session: Session,
    collection: string,
    snapshot: string,
    formula: string,
    body: Buffer,
  ): Promise<void> {
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
          headers: { Authorization: `Bearer ${session.token}` },
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

  private async reportRealization(
    session: Session,
    formula: string,
    attributes: Record<string, string | number | undefined>,
  ): Promise<void> {
    try {
      const response = await fetch(
        `https://${this.host}/api/v1/projects/${this.options.project}/builds/${session.build}/realizations/${encodeURIComponent(formula)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`,
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
