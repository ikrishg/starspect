# starspect

A browser extension to verify the authenticity of GitHub stars.

## Status

Early scaffold. The verification logic is not written yet. Today the repo contains:

- `extension/`: a [WXT](https://wxt.dev) browser extension (TypeScript) with a background script, a content script and a popup. These are still the WXT starter entrypoints.
- `server/`: a [Hono](https://hono.dev) API for Cloudflare Workers. It currently has one route, `GET /`, which returns a plain text greeting.

## Development

Requires Node 22 and pnpm.

```sh
pnpm install

# extension (Chrome, or add :firefox)
pnpm --filter ./extension dev
pnpm --filter ./extension build
pnpm --filter ./extension zip

# server (Cloudflare Workers)
pnpm --filter ./server dev
pnpm --filter ./server deploy
```

CI installs the workspace, type checks and builds on every push to `main`.
