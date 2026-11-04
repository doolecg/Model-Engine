---
name: engine-run-check
description: Run council checklist.
---
Run the test command once, then the build or start command once. Cap output with `tail -n 30`. One run at a time.
Reply one line: `pass: <N> tests`, `note: <warning>` or `fail: <first failing error, verbatim>`.
