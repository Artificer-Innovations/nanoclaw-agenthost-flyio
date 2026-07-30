# nanoclaw-agenthost-flyio

Fly Machines **RuntimeDriver** for NanoClaw — wake/stop remote agent VMs over **HTTP sessionio**.

## Why

Local Docker binds agent session DBs to the host filesystem. Fly Machines cannot share those mounts. This package registers a `fly` driver that:

- Creates/starts/stops Machines + volumes via the Machines API
- Requires `session_transport=http` (reuses `nanoclaw-sessionio`)
- Applies OneCLI proxy config as Machine env/files (no Docker argv)
- Persists `machine_id` / `volume_id` in `.fly-machine.json` per session

## Install

```bash
pnpm add nanoclaw-sessionio nanoclaw-agenthosts nanoclaw-agenthost-flyio
pnpm exec nanoclaw-sessionio install
pnpm exec nanoclaw-agenthosts install
pnpm exec nanoclaw-agenthost-flyio sync-skill
pnpm exec nanoclaw-agenthost-flyio install
pnpm exec nanoclaw-agenthost-flyio verify
```

See [QUICKSTART.md](./QUICKSTART.md), [docs/local-dev-fly-ngrok.md](./docs/local-dev-fly-ngrok.md) (laptop host + OneCLI + ngrok), and the skill `.claude/skills/add-agenthost-flyio/`.

## Peers

| Package                    | Role                      |
| -------------------------- | ------------------------- |
| `nanoclaw-agenthosts` ^0.1 | `RuntimeDriver` registry  |
| `nanoclaw-sessionio` ^0.1  | HTTP mailbox + agent peer |

## License

MIT © Artificer Innovations, LLC
