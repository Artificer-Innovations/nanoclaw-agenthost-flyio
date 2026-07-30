# Install guide — Fly-hosted NanoClaw agents

End-to-end setup for running an agent group on **Fly Machines** with this package.

Docker agents share session SQLite with the host via bind mounts. Fly Machines cannot. That forces three architecture choices:

1. **HTTP sessionio** — host and agent exchange inbound/outbound over a mailbox HTTP API (not filesystem mounts).
2. **A publicly (or privately) routable mailbox URL** — the Machine must dial the host’s sessionio listener.
3. **OneCLI proxy reachable from the Machine** — credentialed provider calls go through OneCLI’s CONNECT proxy, not raw API keys on the guest.

This guide walks those pieces in order. For a laptop host + ngrok smoke path only, see [local-dev-fly-ngrok.md](./local-dev-fly-ngrok.md).

---

## Mental model

```text
┌──────────────── host (laptop or Fly) ─────────────────┐
│  NanoClaw host                                         │
│    sessionio HTTP listen  :18765                       │
│    OneCLI mgmt            :10254  (host → OneCLI only) │
│    Machines API           → api.machines.dev           │
│                                                        │
│  OneCLI                                                │
│    MITM proxy             :10255                       │
└───────────────┬───────────────────────┬────────────────┘
                │                       │
     mailbox URL│                       │ GATEWAY_BASE_URL
  (public HTTPS,│                       │ (public CONNECT /
   Flycast, 6PN,│                       │  TCP tunnel / 6PN)
   or WireGuard)│                       │
                ▼                       ▼
        ┌─────────────── Fly agent Machine ───────────────┐
        │  FLY_AGENT_IMAGE (amd64 runner + fly/ helpers)  │
        │  volume: /workspace (session DBs, agent files)  │
        │  SESSIONIO_BASE_URL → host mailbox              │
        │  HTTPS_PROXY      → OneCLI proxy                │
        └─────────────────────────────────────────────────┘
```

**What must be reachable from the Machine**

| Service | Port (typical) | Why |
| --- | --- | --- |
| Sessionio mailbox | `18765` | Agent polls inbound / posts outbound |
| OneCLI **proxy** | `10255` | CONNECT egress to providers |
| Webchat API (optional) | `3201` | Agent HTTP tools / terminals |

**What stays private (host → local only)**

| Service | Port | Why |
| --- | --- | --- |
| OneCLI **management** | `10254` | Host creates agents / fetches container-config. Do not expose unless you have a reason. |

---

## Prerequisites checklist

- [ ] NanoClaw v2 fork (Node ≥ 20, pnpm)
- [ ] `nanoclaw-sessionio` and `nanoclaw-agenthosts` installed; both `verify` green
- [ ] Fly account + org; `fly` CLI logged in (`fly auth login`)
- [ ] Docker + `docker buildx` (to build/push the agent image)
- [ ] OneCLI running with vault / providers configured (proxy on `:10255`)
- [ ] A path for Machines to reach sessionio + OneCLI proxy (see [Networking](#5-make-the-mailbox--onecli-reachable))

---

## 1. Install packages into the fork

Preferred order (agenthosts before sessionio is fine; if sessionio was installed first, run sessionio `install` again after agenthosts so `public-exports` slots fill):

```bash
pnpm add nanoclaw-sessionio nanoclaw-agenthosts nanoclaw-agenthost-flyio

pnpm exec nanoclaw-agenthosts install
pnpm exec nanoclaw-sessionio install
pnpm exec nanoclaw-agenthost-flyio sync-skill
pnpm exec nanoclaw-agenthost-flyio install

pnpm install
pnpm run build

pnpm exec nanoclaw-agenthosts verify
pnpm exec nanoclaw-sessionio verify
pnpm exec nanoclaw-agenthost-flyio verify
```

`install` copies host + runner patches (boot registration, `src/fly/*` helpers). **`verify` does not publish an image** — you still need section 3.

Uninstall later: flyio **before** sessionio/agenthosts (see skill `REMOVE.md`).

---

## 2. Create the Fly agents app + token

Agents live in their own Fly **app** (Machines + volumes). You choose the name.

```bash
# Pick a unique app name
fly apps create nanoclaw-agents-YOURNAME

# Optional: confirm
fly apps list
```

Put that exact slug in `.env`:

```bash
FLY_APP_AGENTS=nanoclaw-agents-YOURNAME
FLY_REGION=iad          # or your preferred region
```

### API token

Create a deploy/org token the **host** will use for the Machines API (not baked into the guest image):

```bash
# App-scoped (preferred once the app exists)
fly tokens create deploy -a nanoclaw-agents-YOURNAME -x 720h

# Or org-scoped if you manage several apps
fly tokens create org -o YOUR_ORG -x 720h
```

```bash
FLY_API_TOKEN=FlyV1_...   # paste the token
NANOCLAW_ALLOW_FLY_RUNTIME=1
```

`NANOCLAW_ALLOW_FLY_RUNTIME` is a second gate: even with `runtime=fly` on a group, wakes refuse without it.

Registry auth for image pushes:

```bash
fly auth docker
```

---

## 3. Build and publish the agent image

Fly Machines pull a **container image**. After flyio install, the runner must include:

- sessionio HTTP peer
- `container/agent-runner/src/fly/*` (workspace bootstrap on the volume)

The image must match Fly’s Machine platform (**`linux/amd64`**). An arm64-only Mac build fails Machine create with `platform not found: linux/amd64`.

In a NanoClaw fork that has `container/build-fly.sh` (added by this package / skill resources or your fork’s equivalent):

```bash
# From the NanoClaw fork root; reads FLY_APP_AGENTS from .env
fly auth docker
./container/build-fly.sh
# → pushes registry.fly.io/$FLY_APP_AGENTS:latest (linux/amd64, source baked in)
```

Pin in `.env` (tag or digest):

```bash
FLY_AGENT_IMAGE=registry.fly.io/nanoclaw-agents-YOURNAME:latest
# Prefer digest after a known-good build:
# FLY_AGENT_IMAGE=registry.fly.io/nanoclaw-agents-YOURNAME@sha256:...
```

**After any flyio / sessionio / runner change:** rebuild + push, update `FLY_AGENT_IMAGE` if you pin digests, clear any `.fly.wake-blocked` under the session, restart the host, then re-message.

---

## 4. Configure sessionio (HTTP mailbox)

Fly requires `session_transport=http` for fly groups. Host-wide listen settings:

```bash
SESSIONIO_TRANSPORT=http
SESSIONIO_HTTP_HOST=0.0.0.0
SESSIONIO_HTTP_PORT=18765
SESSIONIO_HTTP_TOKEN=pick-a-long-shared-secret
```

Confirm locally after the host is up:

```bash
curl -sS "http://127.0.0.1:18765/health"
# → {"ok":true} (or equivalent)
```

The **Machine** does not use `127.0.0.1`. It uses `FLY_SESSIONIO_BASE_URL` (preferred) or `SESSIONIO_BASE_URL` — whatever URL is reachable from Fly’s network. Same `SESSIONIO_HTTP_TOKEN` is injected into guest env by the fly transport.

---

## 5. Make the mailbox + OneCLI reachable

Pick one networking shape. Machines must dial both URLs successfully (mailbox `/health` is waited on at wake).

### Option A — Laptop host + public tunnels (dev)

Recommended while iterating. Full walkthrough: [local-dev-fly-ngrok.md](./local-dev-fly-ngrok.md).

Summary:

| Path | Tunnel type | Example env |
| --- | --- | --- |
| Sessionio `:18765` | **HTTP** ngrok / Cloudflare | `FLY_SESSIONIO_BASE_URL=https://sio-….ngrok-free.app` |
| Webchat `:3201` (optional) | **HTTP** | `WEBCHAT_PUBLIC_BASE_URL=https://chat-….ngrok-free.app` |
| OneCLI proxy `:10255` | **TCP** (not HTTP) | `GATEWAY_BASE_URL=http://0.tcp.ngrok.io:12345` |
| OneCLI mgmt `:10254` | none | `ONECLI_URL=http://127.0.0.1:10254` |

**Why OneCLI must be TCP:** OneCLI is a CONNECT proxy. Clients send `Host: api.anthropic.com`. An `ngrok http` edge expects the ngrok hostname and returns **421**. Use `ngrok tcp 10255` (ngrok TCP needs account payment-method verification even on free tier).

Set tunnels in `.env`, then **restart the NanoClaw host**.

### Option B — Host on Fly (same org)

Prefer private networking:

```bash
FLY_SESSIONIO_BASE_URL=http://<host-app>.flycast:18765
# or 6PN / internal DNS your org uses
GATEWAY_BASE_URL=http://<onecli-proxy-host>:10255
```

Do not point agents at `host.docker.internal` — that only works for local Docker.

### Option C — Laptop host + Fly WireGuard

```bash
fly wireguard create
# Set FLY_SESSIONIO_BASE_URL / GATEWAY_BASE_URL to addresses
# reachable over the WG interface from Machines (or vice versa per your topology)
```

Use this when you want private reachability without exposing sessionio on the public internet.

---

## 6. OneCLI on the host

Host management (local):

```bash
ONECLI_URL=http://127.0.0.1:10254
ONECLI_API_KEY=...
```

At wake, flyio asks OneCLI for container-config and materializes **proxy env + CA files** onto the Machine (no Docker argv). The guest should show `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` (or equivalent), **not** raw provider API keys in `fly machines status`.

Ensure:

1. OneCLI is running before you wake agents.
2. `GATEWAY_BASE_URL` (or OneCLI’s returned proxy URL) is what Machines can dial.
3. Mailbox hostname is on `NO_PROXY` (fly-transport merges this) so sessionio calls are not sent through the MITM proxy.

---

## 7. Host `.env` cheat sheet

Minimum for a working fly agent:

```bash
# Gates
NANOCLAW_ALLOW_FLY_RUNTIME=1

# Fly
FLY_API_TOKEN=...
FLY_APP_AGENTS=nanoclaw-agents-YOURNAME
FLY_AGENT_IMAGE=registry.fly.io/nanoclaw-agents-YOURNAME:latest
FLY_REGION=iad
# FLY_VOLUME_SIZE_GB=3

# Sessionio listen (host)
SESSIONIO_TRANSPORT=http
SESSIONIO_HTTP_HOST=0.0.0.0
SESSIONIO_HTTP_PORT=18765
SESSIONIO_HTTP_TOKEN=...

# What Machines dial
FLY_SESSIONIO_BASE_URL=https://…          # or Flycast / WG URL
GATEWAY_BASE_URL=http://…                 # OneCLI CONNECT endpoint

# OneCLI management (host only)
ONECLI_URL=http://127.0.0.1:10254
ONECLI_API_KEY=...

# Optional webchat for Fly agents
# WEBCHAT_PUBLIC_BASE_URL=https://…
```

Fly boot also hydrates listed `FLY_*` / `GATEWAY_*` keys from `.env` when unset in `process.env` (NanoClaw does not dotenv-load everything automatically).

---

## 8. Opt in one agent group

Keep other groups on Docker/process while you smoke-test:

```bash
ncl groups config update --id <agent-group-id> \
  --runtime fly \
  --session-transport http
```

Restart the host (macOS example from a NanoClaw fork):

```bash
bash setup/lib/restart.sh
# or: source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

Filesystem transport + `runtime=fly` is rejected (driver `requiredTransport: 'http'`).

---

## 9. First wake — what success looks like

1. Send a channel message to the fly group (or enqueue inbound that triggers wake).
2. Host logs: fly wake success (Machine created/started).
3. `fly machines list -a "$FLY_APP_AGENTS"` → Machine **started**.
4. Volume attached; identity written:

   ```text
   data/v2-sessions/<agent_group>/<session>/.fly-machine.json
   ```

5. Agent peers to sessionio; reply delivers on your channel.
6. Idle / kill → Machine **stopped**, volume **retained** (by design — warm restart; Fly still bills stopped Machines + volumes until you destroy them).
7. Second wake reuses the same `machineId` / `volumeId` when possible.

```bash
fly machines list -a "$FLY_APP_AGENTS"
fly volumes list -a "$FLY_APP_AGENTS"
fly logs -a "$FLY_APP_AGENTS" -i <machine-id>
```

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `platform not found: linux/amd64` | Image built for arm64 | Rebuild with `linux/amd64` (`./container/build-fly.sh`) |
| Wake no-ops / “wake blocked” | Five failed wakes wrote `.fly.wake-blocked` | Fix root cause, delete the file under the session dir, retry |
| Mailbox health never OK | `FLY_SESSIONIO_BASE_URL` wrong, tunnel down, ngrok interstitial | Curl the public `/health` from outside your LAN; prefer clean tunnel / skip interstitial |
| **421** / wrong Host on provider calls | OneCLI exposed via `ngrok http` | Switch to **TCP** tunnel; `GATEWAY_BASE_URL=http://host:port` |
| Proxy to `host.docker.internal` | `GATEWAY_BASE_URL` unset | Set public/WG proxy URL; restart host |
| `unable to open database file` / missing tables | Stale image without volume bootstrap | Rebuild image with current runner `fly/` helpers |
| Destinations empty / invented `to=` names | Meta projection / peer bug or stale image | Update flyio + rebuild image; check runner logs for sessionio meta apply |
| Raw Anthropic keys on Machine | OneCLI apply skipped / wrong path | Confirm OneCLI mgmt from host; inspect guest for `HTTPS_PROXY` + CA paths only |
| Verify fails after agenthosts install | Sessionio slots empty | `pnpm exec nanoclaw-sessionio install` again |

After repeated failures, always check:

```bash
find data/v2-sessions -name '.fly.wake-blocked' -print
# and host logs / fly logs for the first real error, not only the block file
```

---

## 11. Security notes

- Public tunnels expose the mailbox and (for TCP) a path to your OneCLI proxy. Use `SESSIONIO_HTTP_TOKEN`, short-lived tunnels, and a disposable Fly app for experiments.
- Prefer Flycast/6PN/WireGuard when the host is co-located or VPN’d.
- `FLY_API_TOKEN` and `ONECLI_API_KEY` stay on the **host**, not in the agent image.
- Pin image digests in production so `:latest` cannot drift under you.

---

## Related

- [QUICKSTART.md](../QUICKSTART.md) — short path
- [local-dev-fly-ngrok.md](./local-dev-fly-ngrok.md) — laptop + ngrok detail
- [sandbox-smoke.md](./sandbox-smoke.md) — install without live Fly
- [api-contract.md](../api-contract.md) — peer/driver contract
- Skill: `.claude/skills/add-agenthost-flyio/` after `sync-skill`
