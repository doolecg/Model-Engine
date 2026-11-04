---
name: engine-brain
description: Brain gate checklist.
---
Plan gate: reject if a step has no done check, the order is wrong, or it contradicts a Hindsight decision.
Final gate: reject on any council fail, an unmet done check, or tests not run.
Reply `approve` or `reject: <reason>`. After an approve, ingest "Handoff: <project> <date>" (done, next, paths, decisions). After the same error twice, ingest "Lesson: <topic>".
