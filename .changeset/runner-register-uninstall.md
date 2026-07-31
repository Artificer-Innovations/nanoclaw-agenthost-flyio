---
"nanoclaw-agenthost-flyio": patch
---

Mark the agent-runner `registerFlyRunner` boot in `container/agent-runner/src/index.ts` and scavenge unmarked hotfixes on uninstall so deleting `fly/` cannot leave a dangling `./fly/register.js` import.
