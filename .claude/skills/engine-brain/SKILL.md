---
name: engine-brain
description: Brain gate checklist.
---
Plan gate: reject if a step has no done check, the order is wrong, or it contradicts a Hindsight decision.
Final gate: reject on any council fail, an unmet done check, or tests not run.
Reply `approve` or `reject: <reason>`. After an approve, ingest "Handoff: <project> <date>" (done, next, paths, decisions). After the same error twice, ingest "Lesson: <topic>".
If the plan needs an on-demand tool (Blender work), add a line `enable: blender` with a one-line reason after your approve or reject; when a step is finished and the tool is no longer needed add `disable: blender`; never enable a tool the plan does not need.
