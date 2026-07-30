# Local-dev Fly smoke (host + OneCLI on your laptop)

Run the NanoClaw **host** and **OneCLI** on your development machine, expose the two ports Fly Machines must dial with **ngrok** (or Cloudflare Tunnel), and opt one agent group into `runtime=fly`.

This is the recommended short path while OneCLI hosted is waitlisted and you are not yet putting the host/OneCLI on Fly.

```text
┌─────────────────────────── your laptop ───────────────────────────┐
│  NanoClaw host                                                    │
│    sessionio listen 0.0.0.0:18765                                 │
│    ONECLI_URL        http://127.0.0.1:10254   (mgmt, local only)  │
│                                                                   │
│  OneCLI                                                           │
│    mgmt  :10254                                                   │
│    proxy :10255                                                   │
│                                                                   │
│  ngrok HTTP → https://sio-xxx.ngrok-free.app  → :18765 (mailbox)  │
│  ngrok TCP  → tcp://X.tcp.ngrok.io:PORT       → :10255 (OneCLI)   │
└───────────────────────────────────────────────────────────────────┘
                              ▲
                              │ sessionio: HTTPS; OneCLI: CONNECT via TCP
                              │
                    ┌─────────┴──────────┐
                    │  Fly agent Machine │
                    │  SESSIONIO_BASE_URL = sio HTTP tunnel
                    │  HTTPS_PROXY / GATEWAY = OneCLI TCP tunnel
                    └────────────────────┘
```

**Do not tunnel `:10254` unless you have a reason.** The host talks to OneCLI management locally. Machines only need the **proxy** (`:10255`) and the **mailbox** (`:18765`).

**OneCLI must use a TCP tunnel**, not `ngrok http`. OneCLI is a CONNECT proxy: clients send `Host: api.anthropic.com`. An HTTP tunnel expects the ngrok hostname and returns **421** (`Received a request for different Host than the current tunnel`).

---

## 0. Prerequisites

| Piece | Notes |
| --- | --- |
| NanoClaw v2 fork | With `nanoclaw-sessionio` + `nanoclaw-agenthosts` installed and `verify` green |
| This package | `nanoclaw-agenthost-flyio` installed + `verify` green |
| Fly | Org, app for agents (`FLY_APP_AGENTS`), `FLY_API_TOKEN`, region |
| Agent image | Registry tag Fly can pull (`FLY_AGENT_IMAGE`), built with agent-runner + sessionio peer + `fly/` helpers |
| OneCLI | Running locally with vault / providers configured; proxy listening on **10255** |
| ngrok | Account + authtoken. **TCP** for OneCLI requires a payment method on the account ([ngrok TCP verification](https://ngrok.com/blog/tcp-endpoints-require-verification)) — free tier is not charged, but without a card the TCP listener advertises and then **connection refused**. |
| Node ≥ 20, pnpm, `fly` CLI | — |

Optional but recommended: set a shared `SESSIONIO_HTTP_TOKEN` so the mailbox is not wide open on the public tunnel.

---

## 1. Install packages into the fork (once)

From the NanoClaw fork:

```bash
pnpm add nanoclaw-sessionio nanoclaw-agenthosts nanoclaw-agenthost-flyio
# or local file: deps while developing the packages

pnpm exec nanoclaw-sessionio install
pnpm exec nanoclaw-agenthosts install
pnpm exec nanoclaw-agenthost-flyio sync-skill
pnpm exec nanoclaw-agenthost-flyio install

pnpm install
pnpm run build
# Rebuild + publish the agent image that includes:
#   container/agent-runner sessionio peer + src/fly/*
# Then set FLY_AGENT_IMAGE to that tag.

pnpm exec nanoclaw-sessionio verify
pnpm exec nanoclaw-agenthosts verify
pnpm exec nanoclaw-agenthost-flyio verify
```

---

## 2. Start local services

### 2.1 OneCLI

Start your usual local OneCLI so that:

- Management API is on `http://127.0.0.1:10254`
- MITM proxy is on `http://127.0.0.1:10255` (or whatever you will tunnel)

Confirm from the laptop:

```bash
curl -sS "http://127.0.0.1:10254/health" || true
curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:10255/" || true
```

Exact health paths vary by OneCLI version; the important check is that **10255 accepts connections**.

### 2.2 NanoClaw host

In the fork `.env` (or process env), set at least:

```bash
# Sessionio — listen locally; agents will use the ngrok URL (next section)
SESSIONIO_TRANSPORT=http
SESSIONIO_HTTP_HOST=0.0.0.0
SESSIONIO_HTTP_PORT=18765
SESSIONIO_HTTP_TOKEN=dev-shared-token-change-me

# OneCLI management stays local (host → OneCLI)
ONECLI_URL=http://127.0.0.1:10254
ONECLI_API_KEY=...

# Fly driver
NANOCLAW_ALLOW_FLY_RUNTIME=1
FLY_API_TOKEN=...
FLY_APP_AGENTS=your-agents-app
FLY_AGENT_IMAGE=registry.fly.io/your-agent:tag
FLY_REGION=iad
# FLY_VOLUME_SIZE_GB=3
```

Leave `FLY_SESSIONIO_BASE_URL` / `GATEWAY_BASE_URL` unset until the tunnels are up (section 3).

Start the host, then confirm mailbox health:

```bash
curl -sS "http://127.0.0.1:18765/health"
# → {"ok":true} (or equivalent)
```

---

## 3. Open ngrok tunnels

Two tunnels — mailbox and OneCLI proxy.

### Option A — ngrok agent config (recommended)

`~/.ngrok2/ngrok.yml` or the v3 config path from `ngrok config check`:

```yaml
version: "3"
agent:
  authtoken: ${NGROK_AUTHTOKEN}
tunnels:
  sessionio:
    proto: http
    addr: 18765
  onecli-proxy:
    proto: tcp   # required — CONNECT proxy, not reverse HTTP
    addr: 10255
```

```bash
ngrok start --all
```

### Option B — two terminals

```bash
ngrok http 18765 --url=   # or random
ngrok tcp 10255           # OneCLI — must be tcp
```

Copy the public endpoints, for example:

```text
SESSIONIO_PUBLIC=https://sio-abc123.ngrok-free.app
ONECLI_PROXY_PUBLIC=tcp://0.tcp.ngrok.io:12345
# GATEWAY_BASE_URL uses http:// (CONNECT to the TCP listener), not https://
```

### Free-tier interstitial

ngrok free URLs sometimes inject a browser warning page. For API clients that can break health/mailbox calls. Mitigations:

- Use a reserved domain / paid plan without the interstitial, or
- Send the ngrok skip header if your peer stack allows it (`ngrok-skip-browser-warning: 1`) — sessionio peer may not send this by default; prefer a clean tunnel for smoke tests.

Quick check from your laptop (simulates what a Machine will do):

```bash
curl -sS "$SESSIONIO_PUBLIC/health"
# Should look like local /health — not an HTML interstitial
```

---

## 4. Point the host at the public URLs

Add to the fork `.env` and **restart the NanoClaw host** so wake picks them up:

```bash
# What Fly agents dial for the mailbox (must be the ngrok URL, not localhost)
FLY_SESSIONIO_BASE_URL=https://sio-abc123.ngrok-free.app
SESSIONIO_BASE_URL=https://sio-abc123.ngrok-free.app

# OneCLI CONNECT endpoint (TCP tunnel → :10255). Use http://host:port — not https://
GATEWAY_BASE_URL=http://0.tcp.ngrok.io:12345

# Keep management local
ONECLI_URL=http://127.0.0.1:10254
```

Notes:

- `FLY_SESSIONIO_BASE_URL` wins over `SESSIONIO_BASE_URL` for Fly wakes.
- Do **not** leave agents on `host.docker.internal` — the driver rewrites that using `GATEWAY_BASE_URL`’s host.
- If OneCLI’s `/v1/container-config` already returns a correct public proxy URL, you still want `GATEWAY_BASE_URL` set so rewrite has a sensible target.
- **Never** set `GATEWAY_BASE_URL` to an `ngrok http` URL for OneCLI — you will get **421** from ngrok when the agent calls Anthropic/etc.

Same `SESSIONIO_HTTP_TOKEN` must be known to the host (listen auth) and injected into Machines (fly-transport copies `SESSIONIO_HTTP_TOKEN` into guest env when set).

---

## 5. Opt in one agent group

```bash
ncl groups config update --id <agent-group-id> \
  --runtime fly \
  --session-transport http
```

Keep other groups on `docker` / `process` so you can compare.

Restart the host after config + env changes.

---

## 6. Smoke tests (ladder)

### A. Tunnels only

```bash
curl -sS "$SESSIONIO_PUBLIC/health"
# From a throwaway environment that is not your LAN, optional:
#   curl through a remote shell or `fly machines run` with curl to both URLs
```

### B. Machine lifecycle (no model call required)

1. Ensure no Machine is running: `fly machines list -a "$FLY_APP_AGENTS"`
2. Send a channel message to the fly group (or otherwise enqueue inbound + wake)
3. Expect: Machine **created/started**, volume attached, host logs show fly wake success
4. Agent should peer to sessionio over the tunnel (check host sessionio / Machine logs)
5. After idle / host kill: Machine **stopped**, volume **retained**
6. Second wake: should reuse `.fly-machine.json` identity (no new volume)

```bash
fly machines list -a "$FLY_APP_AGENTS"
fly volumes list -a "$FLY_APP_AGENTS"
```

Session identity on the host disk:

```text
data/v2-sessions/<agent_group>/<session>/.fly-machine.json
```

### C. Credentialed egress via OneCLI

1. Prompt the agent to call a provider API that must go through the proxy
2. Confirm Machine env has `HTTPS_PROXY=http://x:…@<tcp-host>:<port>` (TCP tunnel), not `host.docker.internal` and not an `ngrok-free.dev` HTTP hostname
3. Confirm `fly machines status <id> -a "$FLY_APP_AGENTS"` (or inspect) does **not** show raw provider API keys
4. Confirm the call succeeds (OneCLI vault path)

If proxy TLS fails, check that OneCLI CA material was applied (`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` guest files from fly-onecli). With a **TCP** tunnel, TLS is between the agent and OneCLI’s MITM (ngrok does not terminate HTTPS).

| Symptom | Likely cause |
| --- | --- |
| **421** different Host / `Requested Host: api.anthropic.com` | OneCLI exposed via `ngrok http` — switch to `ngrok tcp 10255` |
| **307** no body on proxy host | `HTTPS_PROXY` used `http://` against an HTTPS-only ngrok **HTTP** edge (wrong tunnel type for CONNECT anyway) |

### D. Failure injection

| Break | Expected |
| --- | --- |
| Stop sessionio ngrok | Wake fails closed (sessionio `/health` wait) or agent cannot poll inbound |
| Stop OneCLI proxy ngrok | Wake may still start Machine; credentialed calls fail |
| `NANOCLAW_ALLOW_FLY_RUNTIME` unset | Wake refused |
| Group left on `session_transport=filesystem` | Agenthosts rejects `fly` + filesystem |

---

## 7. Env cheat sheet

| Variable | Where | Role |
| --- | --- | --- |
| `SESSIONIO_TRANSPORT=http` | Host | Use HTTP mailbox |
| `SESSIONIO_HTTP_HOST` / `_PORT` | Host | Listen bind (laptop) |
| `SESSIONIO_HTTP_TOKEN` | Host (+ injected to Machine) | Shared bearer |
| `FLY_SESSIONIO_BASE_URL` | Host | Public URL Machines dial for mailbox |
| `SESSIONIO_BASE_URL` | Host | Fallback / general agent dial URL |
| `ONECLI_URL` | Host | Local management API |
| `ONECLI_API_KEY` | Host | Management auth (never on Machine) |
| `GATEWAY_BASE_URL` | Host | Public proxy URL/host for Machine rewrite |
| `NANOCLAW_ALLOW_FLY_RUNTIME=1` | Host | Opt-in gate for wakes |
| `FLY_API_TOKEN` / `FLY_APP_AGENTS` / `FLY_AGENT_IMAGE` / `FLY_REGION` | Host | Machines API |

---

## 8. Operational gotchas

1. **Laptop sleep** kills tunnels and in-memory sessionio queues (HTTP mailbox is not durable across host restart).
2. **ngrok URL changes** on free tier when you restart the agent — update `.env` and restart NanoClaw.
3. **Image drift** — after `agenthost-flyio install`, rebuild/publish `FLY_AGENT_IMAGE` or Machines run a stale runner.
4. **Security** — public tunnels expose mailbox + proxy. Use a token, short-lived tunnels, and a disposable Fly app for experiments.
5. **Mixed runtimes** — only the fly group needs HTTP transport; docker groups can stay on filesystem.

---

## 9. Cleanup

```bash
# Stop ngrok
# Stop NanoClaw host + OneCLI

fly machines list -a "$FLY_APP_AGENTS"
# Optionally stop/destroy experiment Machines and volumes

# Revert the group
ncl groups config update --id <agent-group-id> --runtime docker --session-transport filesystem
```

Uninstall order if removing packages: flyio → then sessionio/agenthosts (see skill `REMOVE.md`).

---

## Related

- [QUICKSTART.md](../QUICKSTART.md)
- [docs/sandbox-smoke.md](./sandbox-smoke.md) — package install without live Fly
- Skill: `.claude/skills/add-agenthost-flyio/SKILL.md` after `sync-skill`
