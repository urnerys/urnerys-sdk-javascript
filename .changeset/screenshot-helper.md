---
"@urnerys/playwright": minor
---

Add the `urnerysScreenshot` helper

Take screenshots in Playwright tests with `urnerysScreenshot` from `@urnerys/playwright`.
It waits for fonts and images to load, and attaches the screenshot together with its metadata for the reporter.
The formula defaults to the name of the Playwright project.

The reporter now uploads each screenshot once, from the last attempt of a test, instead of once per retry.
