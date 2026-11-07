---
"@urnerys/playwright": minor
---

Add element screenshots and rename `urnerysScreenshot` to `urnerysPageScreenshot`

Take a screenshot of a single element with `urnerysElementScreenshot`, which takes a Playwright `Locator`.
It scrolls the element into view, waits for fonts and for the images inside the element to load, and attaches the screenshot like a page screenshot.
