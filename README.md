<h1 align="center">Model Engine</h1>

<p align="center">
  <strong>A team of Claude Code agents with a live dashboard that shows who is doing what.</strong><br>
  One session plans and talks to you, a builder edits the files, a three-member council reviews, and an Opus reviewer signs off.<br>
  Everything runs on your computer. No account, no analytics.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4ade80?style=flat-square&labelColor=17171b"></a>
  <img alt="Node 18.14 or newer" src="https://img.shields.io/badge/node-18.14%2B-4ade80?style=flat-square&labelColor=17171b">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-4ade80?style=flat-square&labelColor=17171b">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-model-engine">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#what-model-engine-runs-on-your-machine">What it runs</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="docs/images/02-building.png" alt="The live view while the builder is working: an animated diagram of the agents and a session log" width="100%">
</p>

---

Model Engine is a set of Claude Code agents, skills and hooks, plus a small local web page that shows them working. **Drop the `.claude` folder into a project, start the dashboard, and watch each step of a build move through plan, recall, build, review and sign-off.** The agents are real Claude Code subagents, run with your own Claude Code account.

## Quick start

You need [Claude Code](https://code.claude.com) and Node.js 18.14 or newer (the minimum for the Claude Agent SDK that the dashboard chat uses). The `--open` flag starts Microsoft Edge, so it is Windows only. The server itself is plain Node and the URL works in any browser.

```bash
git clone https://github.com/doolecg/Model-Engine.git
cd Model-Engine
npm install --prefix .claude/live
node .claude/live/server.js --open
```

Without `--open`, start the server and visit http://127.0.0.1:4777.

The dashboard has its own chat, which sets everything up for you. To watch a normal terminal session instead, set `MODEL_ENGINE_LIVE=1` before starting Claude Code in the project folder:

```powershell
$env:MODEL_ENGINE_LIVE = "1"; claude
```

Without that variable the hooks do nothing, so other tools that open this folder stay out of the dashboard. To use the agents in your own project, copy the `.claude` folder into it and merge `CLAUDE.md` with your own.

## Run it in Docker

```bash
docker compose up --build
```

Then open http://127.0.0.1:4777. The container publishes the port on your own computer only.

1. Put your API key in a `.env` file next to `docker-compose.yml`: `ANTHROPIC_API_KEY=...`. A Claude subscription login on the host does not carry into the container, so an API key is needed.
2. Set `WORKSPACE` (in the same `.env` file or your shell) to the folder the agents may edit. They can only touch that folder and the container. The default is `./workspace`.
3. The dashboard's project list lives in the Docker volume `engine-data`, mounted at `/data`.
4. Stop it with `docker compose down`. Add `-v` to delete the volume as well.

## Why Model Engine

A long agent session is hard to follow. You see a stream of tool calls and have to guess which model did what and whether anyone checked it.

Here each job has an owner. The orchestrator (your main session) talks to you and never edits project files. Only the builder edits. Searches go to a read-only recall agent. Before anything is called done, three cheap reviewers check the change and an Opus reviewer says approve or reject. The dashboard draws this as it happens, so you can see where a build is and who is holding it up.

## Features

The roles, as set in `CLAUDE.md` and `.claude/agents`:

- **Orchestrator.** The main session. It talks to you and coordinates, and does not edit project files.
- **Reviewer (Opus).** Checks the plan before it locks, checks the final diff before "done", and answers approve or reject. After an approve it writes a handoff note to memory, and after the same error twice a lesson.
- **Recall (Haiku).** Read-only lookup. It searches memory (Hindsight) first, then code (codegraph).
- **Builder (Sonnet).** The only agent that edits files. It takes one short task card at a time and runs its own check.
- **Council (Haiku).** Three members: UI, code and run. UI and code read the diff. Run executes the tests and starts the app. Each replies pass, note or fail.

### On-demand tools

Frugal Blender is an optional MCP server (named `blender`) that you install yourself. It is off by default and only the Brain (reviewer) can switch it on, only when a plan needs it, and it switches off again when the turn ends. You must also tick it under Settings > On-demand tools. Only the builder can use it.

The live view at http://127.0.0.1:4777:

- **Diagram.** An animated picture of the agents above, lit up as hooks report events.
- **Session log.** A running list of what each agent did.
- **Changes tab.** The files being edited, as they are edited. Click a change to see its diff.
- **Per project.** Each project tab keeps its own session log and diffs.
- **Plan tab.** A chat with the Brain (Opus) that interviews you and writes `PLAN.md` in the project folder. It may only write `PLAN.md` and files under `docs/`. A button then sends that plan to the build chat to work through step by step.
- **Status? button.** Asks the running agent for a short status without stopping its work.
- **Settings page.** The disclaimers, what the dashboard runs, privacy, and two options: reduce motion and the default tab.

The skills in `.claude/skills` (`engine-brain`, `engine-builder`, `engine-recall`, `engine-code-review`, `engine-ui-review`, `engine-run-check`) hold the checklist each agent follows.

Hindsight and codegraph are optional MCP servers that you install and configure yourself. They do not ship with this repo. The recall, builder, reviewer and code council agents list their tools, and without these servers those lookups simply have nothing to call.

The UI and run council members also use the Playwright MCP, an optional MCP server you install yourself (like Hindsight and codegraph). Without it they fall back to reading the diff and running tests.

## Screenshots

<p align="center">
  <img src="docs/images/01-recall.png" alt="Recall agent searching memory and code" width="49%">
  <img src="docs/images/03-changes.png" alt="Changes tab listing live file edits" width="49%">
</p>
<p align="center">
  <img src="docs/images/04-council.png" alt="The three council members reviewing a diff" width="49%">
  <img src="docs/images/05-done.png" alt="A finished build after the reviewer approves" width="49%">
</p>
<p align="center">
  <img src="docs/images/07-plan.png" alt="Plan tab with the plan chat" width="49%">
  <img src="docs/images/06-settings.png" alt="Settings page with the disclaimer" width="49%">
</p>

## What Model Engine runs on your machine

Read this before the first start.

- **Agents that change files and run commands.** The builder can read, create, edit and delete files in the project folder and run shell commands. The run council member runs commands too. The dashboard chat has permission modes, including ones that stop asking before edits or commands. It warns you before you switch to them. Use a project under version control and back it up.
- **Hooks.** `.claude/settings.json` runs `node .claude/live/hook.js` on session start, prompt submit, subagent start and stop, every tool use and stop. The hook sends the event to the local server. It exits at once unless `MODEL_ENGINE_LIVE=1` is set, and it fails quietly if the server is down.
- **A local server.** `.claude/live/server.js` listens on `127.0.0.1` only (default port 4777), so other computers on your network cannot reach it.
- **Docker (optional).** In Docker, agents are limited to the mounted workspace folder and the container.
- **Microsoft Edge (Windows only).** With `--open`, the server opens the dashboard in an Edge app window.

Settings you can change with environment variables:

- `MODEL_ENGINE_PORT` changes the port, for the server and the hook.
- `MODEL_ENGINE_STORE` changes where the dashboard keeps its project list. The default is `.claude/live/projects.json`.

## Privacy

The dashboard has no analytics and no account. The server listens on your own computer only, and its project list lives in `.claude/live/projects.json`, which Git ignores.

Nothing leaves your machine except what Claude Code itself sends to Anthropic: your prompts and the files the agents read, under your account and Anthropic's terms. Model Engine does not see or control that traffic. If you use Hindsight or other MCP servers, what they send depends on how you set them up.

## Development

Needs Node.js 18.14 or newer.

```bash
npm install --prefix .claude/live
node .claude/live/server.js        # dashboard on http://127.0.0.1:4777
```

Stop the server by its process ID, which it prints on start.
## Licence

MIT. See [LICENSE](LICENSE).

## Disclaimer

This software is provided "as is", without warranty of any kind, as set out in the [LICENSE](LICENSE). To the extent permitted by law, the authors are not liable for any loss or damage from using it, including lost data, lost work or damage to files or projects. Nothing here limits liability that cannot be limited by law, such as for death or personal injury caused by negligence.

Back up your work before using it. You use it at your own risk.

Not affiliated with or endorsed by Anthropic. AI output can be wrong; check it before relying on it. The agents send your prompts and the files they read to Anthropic through Claude Code, and to any MCP server you connect.
