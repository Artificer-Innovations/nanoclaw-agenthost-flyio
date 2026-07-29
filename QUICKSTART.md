# Quickstart — nanoclaw-agenthost-flyio

## 1. Peers first

```bash
pnpm exec nanoclaw-sessionio verify
pnpm exec nanoclaw-agenthosts verify
```

## 2. Install flyio

```bash
pnpm add nanoclaw-agenthost-flyio
pnpm exec nanoclaw-agenthost-flyio sync-skill
pnpm exec nanoclaw-agenthost-flyio install
pnpm run build
# publish agent image with runner fly/ helpers baked in
pnpm exec nanoclaw-agenthost-flyio verify
```

## 3. Env

```bash
export NANOCLAW_ALLOW_FLY_RUNTIME=1
export FLY_API_TOKEN=...
export FLY_APP_AGENTS=...
export FLY_AGENT_IMAGE=...
export FLY_REGION=iad
export SESSIONIO_TRANSPORT=http
export FLY_SESSIONIO_BASE_URL=http://<reachable>:18765
```

## 4. Opt in

```bash
ncl groups config update --id <ag> --runtime fly --session-transport http
```

Restart host → send a message → confirm Machine start/stop.

## Smoke checklist

- [ ] `verify` passes for sessionio, agenthosts, flyio
- [ ] Message round-trip with Machine stopped before wake
- [ ] Idle stop retains volume
- [ ] OneCLI path works; no raw provider keys in Machine inspect
