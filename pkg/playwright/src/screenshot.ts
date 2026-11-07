import { type Page, type TestInfo, test } from "@playwright/test";

import {
  METADATA_ATTACHMENT_NAME,
  METADATA_CONTENT_TYPE,
  type RealizationAttributes,
  type ScreenshotMetadata,
} from "./protocol.js";
import { type StabilizeOptions, stabilize } from "./stabilize.js";

type PageScreenshotOptions = NonNullable<Parameters<Page["screenshot"]>[0]>;

export interface UrnerysScreenshotOptions
  extends StabilizeOptions,
    Omit<PageScreenshotOptions, "path" | "type" | "quality" | "timeout"> {
  /** Collection the snapshot belongs to. */
  collection: string;

  /** Formula the snapshot was rendered with. Defaults to the name of the Playwright project. */
  formula?: string;
}

/*
 * Image attachment names already used by each test attempt. The metadata refers to the image by name, so the name
 * must be unique within the attempt. The same name also means the same snapshot, which would be uploaded twice.
 */
const attachedImages = new WeakMap<TestInfo, Set<string>>();

function claimImageName(testInfo: TestInfo, name: string): void {
  let names = attachedImages.get(testInfo);
  if (!names) {
    names = new Set();
    attachedImages.set(testInfo, names);
  }

  if (names.has(name)) {
    throw new Error(`[urnerys] The test already took the screenshot ${name}`);
  }
  names.add(name);
}

/*
 * The values used to render a formula that are only known in the test worker (the browser and the viewport). The
 * reporter combines them with the values it has access to and reports them to Urnerys.
 */
function realizationAttributes(page: Page): RealizationAttributes {
  const browser = page.context().browser();
  const viewport = page.viewportSize();

  return {
    "dev.urnerys.renderer.type": "browser",
    "dev.urnerys.renderer.name": browser?.browserType().name(),
    "dev.urnerys.renderer.version": browser?.version(),
    "dev.urnerys.viewport.width": viewport?.width,
    "dev.urnerys.viewport.height": viewport?.height,
  };
}

/**
 * Waits for the page to be ready, takes a screenshot, and attaches it to the current test so that the Urnerys
 * reporter uploads it.
 */
export async function urnerysScreenshot(page: Page, title: string, options: UrnerysScreenshotOptions): Promise<void> {
  const { collection, formula: formulaOption, fullPage, timeout, ...screenshotOptions } = options;

  const testInfo = test.info();

  const formula = formulaOption || testInfo.project.name;
  if (!collection || !title || !formula) {
    throw new Error("[urnerys] The collection, title, and formula must not be empty");
  }

  const image = `${collection}/${title} (${formula}).png`;
  claimImageName(testInfo, image);

  await stabilize(page, { fullPage, timeout });

  const body = await page.screenshot({ ...screenshotOptions, fullPage, type: "png" });

  const metadata: ScreenshotMetadata = {
    image,
    collection,
    snapshot: title,
    formula,
    realization: realizationAttributes(page),
  };

  await testInfo.attach(image, { body, contentType: "image/png" });
  await testInfo.attach(METADATA_ATTACHMENT_NAME, {
    body: JSON.stringify(metadata),
    contentType: METADATA_CONTENT_TYPE,
  });
}
