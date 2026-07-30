# Remove agenthost-flyio

```bash
pnpm exec nanoclaw-agenthost-flyio uninstall
pnpm remove nanoclaw-agenthost-flyio
pnpm run build
# rebuild agent image without container/agent-runner/src/fly/*
```

Then restart the host. Groups still set to `--runtime fly` will fail wake until reconfigured to `docker` / `process` / etc.

Uninstall also removes the marked `@nanoclaw-agenthost-flyio:runner-register` block from `container/agent-runner/src/index.ts` (and scavenges unmarked `registerFlyRunner` hotfixes) so the agent image cannot keep a dangling `./fly/register.js` import after `fly/` is deleted.

**Order:** uninstall flyio before uninstalling `nanoclaw-sessionio` or `nanoclaw-agenthosts` if you are tearing those out too.

Optional: stop/destroy leftover Machines and volumes in `FLY_APP_AGENTS`.
