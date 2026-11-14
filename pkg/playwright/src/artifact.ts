import { Readable } from "node:stream";

import { createZip } from "./zip.js";

export type ArtifactKind = "playwright-report";

export interface UploadArtifactOptions {
  /**
   * Hostname of the Urnerys instance, without scheme.
   */
  host: string;

  project: string;
  build: string;
  token: string;

  /**
   * Name of the artifact within the build. An existing artifact with the same name is replaced.
   */
  name: string;

  kind: ArtifactKind;

  /**
   * Directory to upload. For a `playwright-report`, it must have `index.html` at the top level.
   */
  directory: string;
}

export interface Artifact {
  /**
   * Where the artifact can be viewed.
   */
  url: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 100;

/*
 * Limits enforced by the server. Checking them here avoids streaming hundreds of MB only to have them rejected.
 */
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;
const MAX_FILES = 10_000;

/**
 * Zips the directory and uploads it as an artifact of the build. Throws an `Error` with a message suitable for users
 * if the upload is not possible or fails.
 */
export async function uploadArtifact(options: UploadArtifactOptions): Promise<Artifact> {
  const { host, project, build, token, name, kind, directory } = options;

  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Invalid artifact name "${name}": use at most ${MAX_NAME_LENGTH} letters, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }

  const zip = await createZip(directory);
  if (zip.files > MAX_FILES) {
    throw new Error(`${directory} has ${zip.files} files, more than the limit of ${MAX_FILES}`);
  }
  if (zip.size > MAX_UPLOAD_SIZE) {
    throw new Error(`The archive of ${directory} is ${zip.size} bytes, more than the limit of ${MAX_UPLOAD_SIZE}`);
  }

  const url = new URL(`https://${host}/api/v1/projects/${project}/builds/${build}/artifacts/${name}`);
  url.searchParams.set("kind", kind);

  /*
   * `duplex` is required by Node.js for a streamed body, but is missing from the DOM types.
   */
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers: {
      "Content-Type": "application/zip",
      Authorization: `Bearer ${token}`,
    },
    body: Readable.toWeb(Readable.from(zip.stream())) as ReadableStream<Uint8Array>,
    duplex: "half",
  };

  const response = await fetch(url, init);

  if (response.status === 501) {
    throw new Error(`Artifacts are not enabled on ${host}`);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${await problemDetail(response)}`.trim());
  }

  const { artifact } = (await response.json()) as { artifact: Artifact };
  return artifact;
}

async function problemDetail(response: Response): Promise<string> {
  try {
    const { title, detail } = (await response.json()) as { title?: string; detail?: string };
    return detail ?? title ?? "";
  } catch {
    return "";
  }
}
