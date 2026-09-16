# Publishing

The repo is live at **https://github.com/roopesh/zwave-orchestrator** and ships as a
**build-from-source Home Assistant add-on** (the root `config.yaml` + `Dockerfile`): users add the
repo URL in HA and install, and HA builds it locally. No image publish is required for that.

Three GitHub Actions workflows are wired up for optional distribution upgrades:

- **CI** (`ci.yml`) — typecheck + build on every push/PR.
- **Docker image** (`docker-publish.yml`) — builds and pushes a multi-arch image to the GitHub
  Container Registry (GHCR) when you push a `v*` tag. Uses the built-in `GITHUB_TOKEN`.
- **npm** (`npm-publish.yml`) — publishes to npm when you publish a GitHub Release. Needs an
  `NPM_TOKEN` repo secret.

## Switch the add-on to a prebuilt image (optional, later)

Faster installs for users (no local build), at the cost of publishing a public container image. The
slug stays `zwave_orchestrator`, so installed users just get an in-place **Update**.

1. Add `image: "ghcr.io/roopesh/zwave-orchestrator"` to `config.yaml`.
2. Cut a release so the image exists first:
   ```bash
   npm version patch          # bumps package.json; keep config.yaml version in sync
   git push --follow-tags
   ```
   The `v*` tag triggers **docker-publish** → `ghcr.io/roopesh/zwave-orchestrator:<version>` + `:latest`.
3. Make the GHCR package **public** once (repo → Packages → package → settings).

## Publish to npm (optional)

1. Add an automation token from npmjs.com as the repo secret `NPM_TOKEN` (Settings → Secrets and
   variables → Actions). Confirm the name `zwave-orchestrator` is available.
2. Create a **GitHub Release** from a version tag — that triggers **npm-publish**.

## Verify locally

```bash
npm run build && npm pack --dry-run     # inspect what npm would publish
docker build -t zwave-orchestrator .    # the same Dockerfile HA builds as the add-on
```
