# Sandbox smoke (local peers)

Against a NanoClaw sandbox with sessionio + agenthosts installed from local packages:

```bash
# in nanoclaw-sandbox (or fork)
pnpm add file:../nanoclaw-agenthost-flyio
pnpm exec nanoclaw-agenthost-flyio install
pnpm exec nanoclaw-agenthost-flyio verify
```

Without real Fly credentials, unit/integration tests mock the Machines API. For a live smoke:

1. Set `FLY_*` + `FLY_SESSIONIO_BASE_URL`
2. Opt one group to `--runtime fly --session-transport http`
3. Send a channel message and watch `fly machines list`
