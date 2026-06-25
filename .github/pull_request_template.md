<!-- Keep PRs focused. Title follows Conventional Commits (feat:/fix:/docs:/refactor: …). -->

## What & why

<!-- What does this change and why? Link any issue. -->

## Checks

- [ ] `npm test` passes (offline)
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run check:exports` passes (if the public surface changed)
- [ ] Added a changeset (`npm run changeset`) for any user-facing change

## Invariants preserved

- [ ] Zero runtime dependencies in the core (`openai` stays an optional peer)
- [ ] ESM-only, erasable TypeScript (no enums/namespaces; explicit `.ts` imports)
- [ ] No raw API key / response body logged or stored — redacted at the boundary
