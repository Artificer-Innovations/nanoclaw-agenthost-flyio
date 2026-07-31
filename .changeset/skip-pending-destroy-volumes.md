---
"nanoclaw-agenthost-flyio": patch
---

Skip non-attachable Fly volumes when reusing by name (allowlist: created / legacy omit) so wake can create a fresh volume instead of failing with "volume not found".
