import type { Page } from "@playwright/test";

export interface StabilizeOptions {
  /**
   * Whether the screenshot covers the whole page instead of only the viewport. Decides which images have to be
   * loaded. Defaults to `false`.
   */
  fullPage?: boolean;

  /**
   * How long to wait for images to load, in milliseconds. Defaults to 5 seconds.
   */
  timeout?: number;
}

/*
 * Returns the `src` of every visible image that isn't ready yet. Considers only images that intersect the viewport,
 * unless `fullPage` is set. Runs in the browser, so it must not reference anything outside its own body.
 */
function pendingImages(fullPage: boolean): string[] {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  return Array.from(document.querySelectorAll("img"))
    .filter((img) => {
      const rect = img.getBoundingClientRect();

      /*
       * Hidden images (e.g. `display: none`) have an empty rect and never show up in a screenshot.
       */
      if (rect.width === 0 || rect.height === 0) {
        return false;
      }

      return fullPage || (rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth);
    })
    .filter(
      /*
       * https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/complete
       * https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/naturalWidth
       */
      (img) => !img.complete || img.naturalWidth === 0,
    )
    .map((img) => img.currentSrc || img.src);
}

function isTimeoutError(error: unknown): boolean {
  /*
   * Checks the name rather than `instanceof errors.TimeoutError`, which fails when there is more than one copy of
   * Playwright installed.
   */
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Waits until every visible image has loaded. Fails with the list of images that didn't load in time, which also
 * catches broken images.
 */
async function waitForImages(page: Page, options: StabilizeOptions = {}): Promise<void> {
  const { fullPage = false, timeout = 5_000 } = options;

  const expression = `(${pendingImages})(${JSON.stringify(fullPage)}).length === 0`;

  try {
    await page.waitForFunction(expression, undefined, { timeout });
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }

    const pending = await page.evaluate(pendingImages, fullPage);
    throw new Error(`[urnerys] Images did not load:\n${pending.map((src) => `  ${src}`).join("\n")}`, {
      cause: error,
    });
  }
}

/**
 * Waits until the browser has finished loading the fonts the page uses.
 */
async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/*
 * The steps run in order before every screenshot. Each one waits for one kind of page content to settle.
 */
const steps: ((page: Page, options: StabilizeOptions) => Promise<void>)[] = [
  (page) => page.waitForTimeout(50),
  (page) => page.waitForLoadState("networkidle"),
  (page) => waitForFonts(page),
  (page, options) => waitForImages(page, options),
];

/**
 * Waits until the page is ready for a screenshot.
 */
export async function stabilize(page: Page, options: StabilizeOptions = {}): Promise<void> {
  for (const step of steps) {
    await step(page, options);
  }
}
