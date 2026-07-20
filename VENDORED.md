# Vendored upstream

The repository was rebased on:

- Repository: `https://github.com/gotgenes/pi-packages.git`
- Package path: `packages/pi-subagents`
- Commit: `67eda5ac9add1cb6bb6240495090b5ecf1a1fb29`
- Upstream package version: `18.1.0`

The pre-restart implementation is preserved at the local branch
`legacy/pre-upstream-restart` (`e77299a`).

To inspect a later upstream snapshot without overwriting local work:

```bash
git fetch upstream main
git archive upstream/main packages/pi-subagents | tar -x -C /tmp
```

Do not copy the monorepo package blindly: its `package.json`, TypeScript config,
scripts, and package-local `AGENTS.md` assume the `pi-packages` workspace and
must be adapted for this standalone repository.
