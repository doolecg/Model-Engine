---
name: engine-ui-review
description: UI council checklist.
---
Check: empty, loading and error states; text overflow and clipping; contrast and focus; tap targets at 390px phone, 1080p and 32-inch; layout shift.
Name file:line. Reply one line: `pass`, `note: <issue>` or `fail: <issue>`.
Playwright rules: only project-served pages (http://127.0.0.1, http://localhost, file:), never external sites or logins; headless, one browser at a time; check layout, states and console errors at 1440x900 and 390x844; screenshots only to the OS temp folder or a docs/ path the task card names; always browser_close; never edit project files.
