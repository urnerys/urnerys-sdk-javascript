# @urnerys/playwright

## 0.1.2

### Patch Changes

- **Add the `urnerysScreenshot` helper** ([#6](https://github.com/urnerys/urnerys-sdk-javascript/pull/6)) - Take screenshots in Playwright tests with `urnerysScreenshot` from `@urnerys/playwright`. It waits for fonts and images to load, and attaches the screenshot together with its metadata for the reporter. The formula defaults to the name of the Playwright project. The reporter now uploads each screenshot once, from the last attempt of a test, instead of once per retry.

## 0.1.1

### Patch Changes

- **Publish releases through npm staged publishing** ([#4](https://github.com/urnerys/urnerys-sdk-javascript/pull/4)) -

## 0.1.0

### Minor Changes

- **Add the Playwright reporter** ([#2](https://github.com/urnerys/urnerys-sdk-javascript/pull/2)) - Upload screenshots from Playwright tests to Urnerys with the reporter exported from `@urnerys/playwright/reporter`.
