# Model rules

The main session is the orchestrator: it runs on whichever model you pick, talks to you, and coordinates. It does not edit project files itself. Flow: the orchestrator asks the Brain (Opus) to gate the plan, `recall` fetches memory and code, the `builder` agent (Sonnet 5.5) builds one step at a time, the council of 3 reviews, the builder applies findings, the Brain gates "done" and commits to memory. Chat and planning talk need no agents.

- Every repo search goes to the `recall` agent (Haiku 5.5). It uses Hindsight first, then codegraph. The orchestrator does not grep or read around the repo itself.
- Project edits go to the `builder` agent (Sonnet 5.5) with a short task card (task, files, done check), one step at a time.
- Every test run goes to the `council-run` agent (Haiku 5.5). Before "done", also call `council-ui` and `council-code` (Haiku 5.5) in parallel with it. Pass them the diff.
- Call the `reviewer` agent (Opus 5.5) at three points: before a plan locks, after the same error twice, and before saying "done". Pass it the plan or the final diff plus the council findings. It replies approve or reject. On reject, fix and call it again.
- After an approve, the reviewer ingests the "Handoff:" document to Hindsight. After the same error twice it ingests a "Lesson:" document.
- Max 3 subagents running at once, and one build or test run at a time.

# Live view

`node .claude/live/server.js --open` starts the dashboard on http://127.0.0.1:4777 (stop it by PID). Hooks in `.claude/settings.json` feed it; run `npm install --prefix .claude/live` once first. Only runs with `MODEL_ENGINE_LIVE=1` report in (the dashboard chat sets it; set it in a terminal to watch a terminal session). T3 Code and other tools stay out.
