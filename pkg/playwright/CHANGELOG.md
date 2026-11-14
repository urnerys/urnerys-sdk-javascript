# @urnerys/playwright

## 0.3.0

### Minor Changes

- **Upload the Playwright HTML report to the build** ([#12](https://github.com/urnerys/urnerys-sdk-javascript/pull/12)) - Once the run is done, the reporter uploads the report of the Playwright HTML reporter to the build and prints its URL. The report is named `playwright-report`, or the value of the new `report: { name }` option, which runs that upload to the same build must set to different values. Set `report: false` to turn the upload off. The upload is skipped with a warning when the HTML reporter is not configured, and a failed upload never fails the run.

## 0.2.0

### Minor Changes

- **Add element screenshots and rename `urnerysScreenshot` to `urnerysPageScreenshot`** ([#8](https://github.com/urnerys/urnerys-sdk-javascript/pull/8)) - Take a screenshot of a single element with `urnerysElementScreenshot`, which takes a Playwright `Locator`. It scrolls the element into view, waits for fonts and for the images inside the element to load, and attaches the screenshot like a page screenshot.

## 0.1.2

### Patch Changes

- **Add the `urnerysScreenshot` helper** ([#6](https://github.com/urnerys/urnerys-sdk-javascript/pull/6)) - Take screenshots in Playwright tests with `urnerysScreenshot` from `@urnerys/playwright`. It waits for fonts and images to load, and attaches the screenshot together with its metadata for the reporter. The formula defaults to the name of the Playwright project. The reporter now uploads each screenshot once, from the last attempt of a test, instead of once per retry.

## 0.1.1

### Patch Changes

- **Publish releases through npm staged publishing** ([#4](https://github.com/urnerys/urnerys-sdk-javascript/pull/4)) -

## 0.1.0

### Minor Changes

- **Add the Playwright reporter** ([#2](https://github.com/urnerys/urnerys-sdk-javascript/pull/2)) - Upload screenshots from Playwright tests to Urnerys with the reporter exported from `@urnerys/playwright/reporter`.
