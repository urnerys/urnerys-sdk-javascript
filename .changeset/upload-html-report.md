---
"@urnerys/playwright": minor
---

Upload the Playwright HTML report to the build

Once the run is done, the reporter uploads the report of the Playwright HTML reporter to the build and prints its URL.
The report is named `playwright-report`, or the value of the new `name` option, which runs that upload to the same build must set to different values.
Set `report: false` to turn the upload off.
The upload is skipped with a warning when the HTML reporter is not configured, and a failed upload never fails the run.
