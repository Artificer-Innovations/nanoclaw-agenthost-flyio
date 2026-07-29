# API Contract — nanoclaw-agenthost-flyio

Aligned with **agenthosts API v1** and **sessionio API v1**.

## Registration

```ts
registerRuntimeDriver("fly", flyDriver);
// flyDriver.requiredTransport === "http"
```

Installer inserts `@nanoclaw-agenthost-flyio:boot` in `src/index.ts` calling `startAgenthostFlyio()`.

## Peer requirements (install / verify fail closed)

### agenthosts

- `src/agenthosts.ts`: `AGENTHOSTS_API_VERSION = 1`, `registerRuntimeDriver`, `resolveRuntimeDriver`
- `src/container-runner.ts`: wake/kill/is-running rename markers + `public-exports` + `resolveRuntimeDriver`

### sessionio

- `src/sessionio.ts`: `SESSIONIO_API_VERSION = 1`, `registerSessionTransport`, `resolveSessionTransport`
- `src/index.ts`: `@nanoclaw-sessionio:index-boot:begin`

## Host opt-in

Wakes require `NANOCLAW_ALLOW_FLY_RUNTIME=1|true|yes` in addition to per-group `runtime=fly`.

## Identity

Persisted at `<sessionDir>/.fly-machine.json`:

```ts
{ machineId, volumeId, app, region, image, updatedAt? }
```

## Semver

- **patch** — wake/installer bugs, docs
- **minor** — optional WakeContext / env keys / Machines client options
- **major** — driver name change, peer API bump, marker renames, identity schema break
