import { type Locator, type Page, type TestInfo, test } from "@playwright/test";

import {
  METADATA_ATTACHMENT_NAME,
  METADATA_CONTENT_TYPE,
  type RealizationAttributes,
  type ScreenshotMetadata,
} from "./protocol.js";
import { type StabilizeOptions, stabilize } from "./stabilize.js";

type PageScreenshotOptions = NonNullable<Parameters<Page["screenshot"]>[0]>;

type LocatorScreenshotOptions = NonNullable<Parameters<Locator["screenshot"]>[0]>;

/*
 * Options that Playwright doesn't get to decide: the image is always a PNG attached to the test, and `timeout` is
 * the image timeout of `stabilize`.
 */
type ControlledScreenshotOptions = "path" | "type" | "quality" | "timeout";

/**
 * Options shared by page and element screenshots.
 */
export interface UrnerysScreenshotOptions extends StabilizeOptions {
  /**
   * Collection the snapshot belongs to.
   */
  collection: string;

  /**
   * Title of the snapshot within the collection.
   */
  title: string;

  /**
   * Formula the snapshot was rendered with. Defaults to the name of the Playwright project.
   */
  formula?: string;
}

export interface UrnerysPageScreenshotOptions
  extends UrnerysScreenshotOptions,
    Omit<PageScreenshotOptions, ControlledScreenshotOptions> {}

export interface UrnerysElementScreenshotOptions
  extends UrnerysScreenshotOptions,
    Omit<LocatorScreenshotOptions, ControlledScreenshotOptions> {}

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

/*
 * Takes a screenshot with `capture` and attaches it, together with its metadata, to the current test.
 */
async function attachScreenshot(
  page: Page,
  options: UrnerysScreenshotOptions,
  capture: () => Promise<Buffer>,
): Promise<void> {
  const { collection, title, formula: formulaOption } = options;

  const testInfo = test.info();

  const formula = formulaOption || testInfo.project.name;
  if (!collection || !title || !formula) {
    throw new Error("[urnerys] The collection, title, and formula must not be empty");
  }

  const image = `${collection}/${title} (${formula}).png`;
  claimImageName(testInfo, image);

  const body = await capture();

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

/**
 * Waits for the page to be ready, takes a screenshot of it, and attaches it to the current test so that the Urnerys
 * reporter uploads it.
 */
export async function urnerysPageScreenshot(page: Page, options: UrnerysPageScreenshotOptions): Promise<void> {
  const { collection, title, formula, timeout, ...screenshotOptions } = options;

  await attachScreenshot(page, options, async () => {
    await stabilize(page.locator(":root"), screenshotOptions.fullPage ? "all" : "viewport", { timeout });
    return page.screenshot({ ...screenshotOptions, type: "png" });
  });
}

/**
 * Waits for the element to be ready, takes a screenshot of it, and attaches it to the current test so that the
 * Urnerys reporter uploads it. Only images inside the element have to be loaded.
 */
export async function urnerysElementScreenshot(
  locator: Locator,
  options: UrnerysElementScreenshotOptions,
): Promise<void> {
  const { collection, title, formula, timeout, ...screenshotOptions } = options;

  await attachScreenshot(locator.page(), options, async () => {
    /*
     * Scrolls first, so that lazy images inside the element start loading before `stabilize` waits for them.
     */
    await locator.scrollIntoViewIfNeeded();
    await stabilize(locator, "all", { timeout });
    return locator.screenshot({ ...screenshotOptions, type: "png" });
  });
}
