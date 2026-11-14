import fs from "node:fs";
import { Readable } from "node:stream";

import { createZip } from "./zip.js";

export type ArtifactKind = "playwright-report" | "playwright-trace";

/**
 * Attributes of an artifact, as reverse-DNS keys. See the attributes documentation of Urnerys for the known keys.
 */
export type ArtifactAttributes = Record<string, string | number | boolean>;

export interface ArtifactTarget {
  /**
   * Hostname of the Urnerys instance, without scheme.
   */
  host: string;

  project: string;
  build: string;
  token: string;

  /**
   * Name of the artifact within the build.
   */
  name: string;
}

export interface UploadArtifactOptions extends ArtifactTarget {
  /**
   * An existing artifact with the same name is replaced, along with its attributes and its links to images.
   */
  name: string;

  kind: ArtifactKind;

  attributes?: ArtifactAttributes;
}

export interface UploadDirectoryOptions extends UploadArtifactOptions {
  /**
   * Directory to upload. For a `playwright-report`, it must have `index.html` at the top level.
   */
  directory: string;
}

export interface UploadFileOptions extends UploadArtifactOptions {
  /**
   * Zip archive to upload, e.g. a Playwright trace.
   */
  file: string;
}

export interface LinkArtifactImagesOptions extends ArtifactTarget {
  /**
   * Names of the images, as returned by the image upload.
   */
  images: string[];
}

export interface Artifact {
  /**
   * Where the artifact can be viewed.
   */
  url: string;
}

/**
 * Thrown when the instance answers `501 Not Implemented`, i.e. artifacts are not enabled on it.
 */
export class ArtifactsNotEnabledError extends Error {
  constructor(host: string) {
    super(`Artifacts are not enabled on ${host}`);
    this.name = "ArtifactsNotEnabledError";
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 100;

/*
 * Limits enforced by the server. Checking them here avoids streaming hundreds of MB only to have them rejected.
 */
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_IMAGES_PER_LINK = 1_000;

/**
 * Zips the directory and uploads it as an artifact of the build. Throws an `Error` with a message suitable for users
 * if the upload is not possible or fails, and an `ArtifactsNotEnabledError` if the instance doesn't support artifacts.
 */
export async function uploadArtifact(options: UploadDirectoryOptions): Promise<Artifact> {
  const { directory } = options;

  checkName(options.name);

  const zip = await createZip(directory);
  if (zip.files > MAX_FILES) {
    throw new Error(`${directory} has ${zip.files} files, more than the limit of ${MAX_FILES}`);
  }
  if (zip.size > MAX_UPLOAD_SIZE) {
    throw new Error(`The archive of ${directory} is ${zip.size} bytes, more than the limit of ${MAX_UPLOAD_SIZE}`);
  }

  return put(options, zip.size, Readable.from(zip.stream()));
}

/**
 * Uploads a zip archive as an artifact of the build. Throws like `uploadArtifact`.
 */
export async function uploadArtifactFile(options: UploadFileOptions): Promise<Artifact> {
  const { file } = options;

  checkName(options.name);

  const { size } = await fs.promises.stat(file);
  if (size > MAX_UPLOAD_SIZE) {
    throw new Error(`${file} is ${size} bytes, more than the limit of ${MAX_UPLOAD_SIZE}`);
  }

  return put(options, size, fs.createReadStream(file));
}

/**
 * Links the artifact to images of the same build. Links that already exist are kept. Throws like `uploadArtifact`.
 */
export async function linkArtifactImages(options: LinkArtifactImagesOptions): Promise<void> {
  const { host, token, images } = options;

  for (let start = 0; start < images.length; start += MAX_IMAGES_PER_LINK) {
    const response = await fetch(`${artifactUrl(options)}/images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ images: images.slice(start, start + MAX_IMAGES_PER_LINK) }),
    });

    await checkResponse(host, response);
  }
}

function checkName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Invalid artifact name "${name}": use at most ${MAX_NAME_LENGTH} letters, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }
}

function artifactUrl({ host, project, build, name }: ArtifactTarget): URL {
  return new URL(`https://${host}/api/v1/projects/${project}/builds/${build}/artifacts/${name}`);
}

async function put(options: UploadArtifactOptions, size: number, body: Readable): Promise<Artifact> {
  const { host, token, kind, attributes } = options;

  const url = artifactUrl(options);
  url.searchParams.set("kind", kind);
  if (attributes) {
    url.searchParams.set("attributes", JSON.stringify(attributes));
  }

  /*
   * `duplex` is required by Node.js for a streamed body, but is missing from the DOM types.
   */
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(size),
      Authorization: `Bearer ${token}`,
    },
    body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
    duplex: "half",
  };

  const response = await fetch(url, init);
  await checkResponse(host, response);

  const { artifact } = (await response.json()) as { artifact: Artifact };
  return artifact;
}

async function checkResponse(host: string, response: Response): Promise<void> {
  if (response.status === 501) {
    throw new ArtifactsNotEnabledError(host);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${await problemDetail(response)}`.trim());
  }
}

async function problemDetail(response: Response): Promise<string> {
  try {
    const { title, detail } = (await response.json()) as { title?: string; detail?: string };
    return detail ?? title ?? "";
  } catch {
    return "";
  }
}
