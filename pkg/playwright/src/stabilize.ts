import type { Locator, Page } from "@playwright/test";

/**
 * Which images have to be loaded before the screenshot:
 *
 *   - `viewport`: images inside the root element that intersect the viewport
 *   - `all`: every image inside the root element
 */
export type ImageScope = "viewport" | "all";

export interface StabilizeOptions {
  /**
   * How long to wait for images to load, in milliseconds. Defaults to 5 seconds.
   */
  timeout?: number;
}

/*
 * Returns the `src` of every visible image inside `root` (including `root` itself) that isn't ready yet. Runs in the
 * browser, so it must not reference anything outside its own body.
 */
function pendingImages(root: Element, scope: ImageScope): string[] {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  const images = Array.from(root.querySelectorAll("img"));
  if (root instanceof HTMLImageElement) {
    images.push(root);
  }

  return images
    .filter((img) => {
      const rect = img.getBoundingClientRect();

      /*
       * Hidden images (e.g. `display: none`) have an empty rect and never show up in a screenshot.
       */
      if (rect.width === 0 || rect.height === 0) {
        return false;
      }

      if (scope === "all") {
        return true;
      }

      return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
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

/**
 * Waits until every visible image inside the root element has loaded. Fails with the list of images that didn't load
 * in time, which also catches broken images.
 */
async function waitForImages(root: Locator, scope: ImageScope, options: StabilizeOptions): Promise<void> {
  const { timeout = 5_000 } = options;

  const deadline = Date.now() + timeout;

  for (;;) {
    const pending = await root.evaluate(pendingImages, scope, { timeout });
    if (pending.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`[urnerys] Images did not load:\n${pending.map((src) => `  ${src}`).join("\n")}`);
    }

    await root.page().waitForTimeout(100);
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

/**
 * Waits until the page is ready for a screenshot of `root`. Images are only considered inside `root`.
 */
export async function stabilize(root: Locator, scope: ImageScope, options: StabilizeOptions = {}): Promise<void> {
  const page = root.page();

  await page.waitForTimeout(50);
  await page.waitForLoadState("networkidle");
  await waitForFonts(page);
  await waitForImages(root, scope, options);
}
