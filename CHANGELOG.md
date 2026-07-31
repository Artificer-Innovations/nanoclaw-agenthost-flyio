# Changelog

## 0.1.1

### Patch Changes

- Skip non-attachable Fly volumes when reusing by name (allowlist: `created` / legacy omit of `state`) so wake can create a fresh volume instead of failing with "volume not found". Empty or whitespace `state` fails closed (not treated as legacy omit).

## 0.1.0

- Initial release: Fly Machines `RuntimeDriver` (`fly`) with `requiredTransport: http`
- Durable `.fly-machine.json` identity; OneCLI env/file apply; sessionio peer env injection
- CLI install/verify/uninstall with agenthosts + sessionio peer gates
- Skill `/add-agenthost-flyio` + runner volume workspace helpers
