---
"nanoclaw-agenthost-flyio": patch
---

Skip pending_destroy / dead Fly volumes when reusing by name so wake can create a fresh volume instead of failing with "volume not found".
