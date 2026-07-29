# Contributing

- Branch from `develop`; release via merge to `main`
- User-facing changes need a Changeset
- `pnpm run lint` / `typecheck` / `test:coverage` / `test:integration` must pass
- Skill `resources/` are synced from `packages/host` + `packages/runner` on build — do not edit skill copies by hand
