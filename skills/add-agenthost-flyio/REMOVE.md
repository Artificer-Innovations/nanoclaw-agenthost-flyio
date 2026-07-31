# Remove agenthost-flyio

Idle `kill` only **stops** Machines (volumes retained for warm restart). Removing
this package does **not** stop Fly billing by itself — you must destroy Machines
and volumes.

## 1. Destroy remote Fly resources (required)

From the NanoClaw fork (needs `FLY_API_TOKEN` + `FLY_APP_AGENTS` in env or `.env`):

```bash
pnpm exec nanoclaw-agenthost-flyio teardown
```

This walks `data/v2-sessions/**/.fly-machine.json`, calls Machines API
`DELETE` for each machine + volume, and clears the identity files.

`uninstall` runs the same teardown best-effort after removing local files. If
credentials are missing or the API errors, run `teardown` (or the manual
commands below) yourself before walking away — otherwise stopped Machines and
volumes keep billing.

### Manual fallback (fly CLI)

```bash
# List what still exists
fly machines list -a "$FLY_APP_AGENTS"
fly volumes list -a "$FLY_APP_AGENTS"

# Destroy each Machine (force) then its volume
fly machines destroy <machine-id> -a "$FLY_APP_AGENTS" --force
fly volumes destroy <volume-id> -a "$FLY_APP_AGENTS" -y
```

Session identity files (if teardown did not clear them):

```text
data/v2-sessions/<agent_group>/<session>/.fly-machine.json
```

## 2. Uninstall the package from the fork

```bash
pnpm exec nanoclaw-agenthost-flyio uninstall   # also attempts teardown
pnpm remove nanoclaw-agenthost-flyio
pnpm run build
# rebuild agent image without container/agent-runner/src/fly/*
```

Then restart the host. Groups still set to `--runtime fly` will fail wake until
reconfigured to `docker` / `process` / etc.

Uninstall also removes the marked `@nanoclaw-agenthost-flyio:runner-register`
block from `container/agent-runner/src/index.ts` (and scavenges unmarked
`registerFlyRunner` hotfixes) so the agent image cannot keep a dangling
`./fly/register.js` import after `fly/` is deleted.

**Order:** uninstall flyio before uninstalling `nanoclaw-sessionio` or
`nanoclaw-agenthosts` if you are tearing those out too.
