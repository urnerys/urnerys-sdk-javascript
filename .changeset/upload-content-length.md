---
"@urnerys/playwright": patch
---

Send `Content-Length` when uploading the report

The server can now reject an oversized upload right away, and reverse proxies no longer receive a body of unknown length.
