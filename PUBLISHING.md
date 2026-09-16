# Publishing

The repo ships three GitHub Actions workflows:

- **CI** (`ci.yml`) — typecheck + build on every push/PR.
- **Docker image** (`docker-publish.yml`) — builds and pushes to the GitHub Container
  Registry (GHCR) when you push a `v*` tag. Uses the built-in `GITHUB_TOKEN`; no extra secret.
- **npm** (`npm-publish.yml`) — publishes to npm when you publish a GitHub Release. Needs an
  `NPM_TOKEN` repo secret.

## One-time setup

1. Create the GitHub repo and push:
   ```bash
   git remote add origin git@github.com:<roopesh>/zwave-orchestrator.git
   git push -u origin main
   ```
2. **Replace `roopesh`** in `package.json` (`repository`, `homepage`, `bugs`) with your GitHub
   username/org. GHCR images publish to `ghcr.io/<roopesh>/zwave-orchestrator` automatically.
3. For npm: create an automation token at npmjs.com and add it as the repo secret `NPM_TOKEN`
   (Settings → Secrets and variables → Actions). Also confirm the package name `zwave-orchestrator`
   is available, or rename it.

## Cut a release

```bash
# bump version first (updates package.json)
npm version patch          # or minor / major

git push --follow-tags
```

- Pushing the `v0.1.1` tag triggers **docker-publish** → `ghcr.io/<roopesh>/zwave-orchestrator:0.1.1`
  and `:latest`. Make the GHCR package **public** once (repo → Packages → package → settings).
- To publish to npm, create a **GitHub Release** from that tag — that triggers **npm-publish**.

## Verify locally before releasing

```bash
npm run build && npm pack --dry-run     # inspect what npm would publish
docker build -t zwave-orchestrator .    # verified working on this project
```
