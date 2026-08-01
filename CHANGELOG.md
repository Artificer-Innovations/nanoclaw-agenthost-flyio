# Changelog

## Unreleased

### Minor Changes

- Emit phase-rich runtime status during Fly wake via `ctx.onStatus` (preparing → transport/config/provision/start → ready/failed), with optional `wakeDeps.publishRuntimeActivity` fallback.

- Harden wake against Fly dashboard clickops: reconcile tracked Machines before warm early-return, recreate identity when a Machine is destroyed/404, skip `.fly.wake-blocked` for retryable transport errors, and auto-expire wake-blocked after 15 minutes.

## 0.1.1

### Patch Changes

- Skip non-attachable Fly volumes when reusing by name (allowlist: `created` / legacy omit of `state`) so wake can create a fresh volume instead of failing with "volume not found". Empty or whitespace `state` fails closed (not treated as legacy omit).

## 0.1.0

- Initial release: Fly Machines `RuntimeDriver` (`fly`) with `requiredTransport: http`
- Durable `.fly-machine.json` identity; OneCLI env/file apply; sessionio peer env injection
- CLI install/verify/uninstall with agenthosts + sessionio peer gates
- Skill `/add-agenthost-flyio` + runner volume workspace helpers
