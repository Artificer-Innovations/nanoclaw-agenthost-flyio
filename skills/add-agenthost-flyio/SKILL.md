---
name: add-agenthost-flyio
description: Install Fly Machines RuntimeDriver for NanoClaw remote agents over HTTP sessionio.
---

# Add agenthost-flyio

Run NanoClaw agents on **Fly Machines** that start on wake and stop when idle. Requires `nanoclaw-sessionio` (HTTP mailbox) and `nanoclaw-agenthosts`.

## Prerequisites

- NanoClaw v2 host with `nanoclaw-sessionio` and `nanoclaw-agenthosts` already installed and `verify` green
- Node ≥ 20, pnpm
- Fly org/app + `FLY_API_TOKEN`
- Agent image Fly can pull (`FLY_AGENT_IMAGE`)
- OneCLI reachable from Machines (`GATEWAY_BASE_URL` / rewrite — not `host.docker.internal`)
- Sessionio HTTP listen URL reachable from Machines (`FLY_SESSIONIO_BASE_URL` or `SESSIONIO_BASE_URL`) via **6PN**, **Flycast**, or **WireGuard**

## Install order

1. `/add-sessionio` → verify
2. `/add-agenthosts` → verify
3. `/add-agenthost-flyio` (this skill)

## Recipe

### 0. Sync skill (first time / after upgrade)

```bash
pnpm exec nanoclaw-agenthost-flyio sync-skill
```

### 1. Add package

```bash
pnpm add nanoclaw-agenthost-flyio
# or local: pnpm add file:../nanoclaw-agenthost-flyio
```

### 2. Install into the fork

```bash
pnpm exec nanoclaw-agenthosts verify
pnpm exec nanoclaw-sessionio verify
pnpm exec nanoclaw-agenthost-flyio install
pnpm install
pnpm run build
# rebuild + publish agent image that includes container/agent-runner/src/fly/*
pnpm exec nanoclaw-agenthost-flyio verify
```

### 3. Configure env

```bash
NANOCLAW_ALLOW_FLY_RUNTIME=1
FLY_API_TOKEN=...
FLY_APP_AGENTS=your-agents-app
FLY_AGENT_IMAGE=registry.fly.io/your-agent:tag
FLY_REGION=iad
SESSIONIO_TRANSPORT=http
FLY_SESSIONIO_BASE_URL=http://<reachable-host>:18765
# ONECLI_URL / GATEWAY_BASE_URL for credentialed egress
```

### 4. Opt in a group

```bash
ncl groups config update --id <ag> --runtime fly --session-transport http
```

Restart the NanoClaw host.

## Networking

| Host placement         | How agents reach sessionio                                         |
| ---------------------- | ------------------------------------------------------------------ |
| Host on Fly (same org) | Prefer private **6PN** / Flycast URL                               |
| Host on laptop         | `fly wireguard` and set `FLY_SESSIONIO_BASE_URL` to the WG address |

Do **not** use filesystem transport with `runtime=fly` — wake fails closed.

## Verify / smoke

1. Host health + sessionio/agenthosts/flyio `verify`
2. `fly machines list -a $FLY_APP_AGENTS`
3. Send a message → Machine starts → reply delivers
4. Idle → Machine **stopped**; volume retained
5. Credentialed call via OneCLI from inside Machine (no raw API keys in `fly machines status`)

## Uninstall

See [REMOVE.md](./REMOVE.md). Uninstall flyio **before** removing sessionio/agenthosts.
