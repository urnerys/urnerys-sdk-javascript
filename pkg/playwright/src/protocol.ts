/*
 * Test attachments are how tests hand screenshots to the reporter. Every screenshot is attached twice:
 *
 *   - the PNG, under a name that is unique within the test attempt
 *   - a JSON attachment named `urnerys` with the content type below, which describes the screenshot and refers to the
 *     PNG by name
 *
 * Playwright doesn't require attachment names to be unique, so every metadata attachment has the same name. The
 * reporter finds them by content type.
 */

export const METADATA_ATTACHMENT_NAME = "urnerys";

export const METADATA_CONTENT_TYPE = "application/vnd.urnerys.screenshot+json";

export type RealizationAttributes = Record<string, string | number | undefined>;

export interface ScreenshotMetadata {
  /** Name of the attachment that holds the PNG. */
  image: string;

  collection: string;
  snapshot: string;
  formula: string;

  /** Attributes of the realization that are only known in the test worker, such as the browser and the viewport. */
  realization: RealizationAttributes;
}
