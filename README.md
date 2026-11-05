# Urnerys SDK for JavaScript

Packages for using [Urnerys](https://app.urnerys.dev) from JavaScript and TypeScript.

| Package                                 | Description                                  |
| --------------------------------------- | -------------------------------------------- |
| [`@urnerys/playwright`](pkg/playwright) | Playwright reporter that uploads screenshots |

## Development

The repository is a pnpm workspace. Publishable packages live in `pkg/`.
The Nix flake provides Node.js, pnpm, and Biome.

```sh
nix develop
pnpm install
pnpm run typecheck
pnpm run build
```
