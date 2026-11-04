---
name: engine-run-check
description: Run council checklist.
---
Run the test command once, then the build or start command once. Cap output with `tail -n 30`. One run at a time.
Reply one line: `pass: <N> tests`, `note: <warning>` or `fail: <first failing error, verbatim>`.
Playwright rules: after tests, start the app only if the task card says how, load it, check the console for errors and that the main view renders, then stop what you started by PID. Only project-served pages (http://127.0.0.1, http://localhost, file:), never external sites or logins; headless, one browser at a time; screenshots only to the OS temp folder or a docs/ path the task card names; always browser_close; never edit project files.
