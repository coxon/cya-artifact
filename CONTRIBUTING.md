# Contributing

Changes should preserve the ability to clone this repository and run it locally without a Cloudflare account, production credentials, a custom domain, or webhook integrations.

## Development setup

Use Node.js 22 or newer. Install dependencies with `npm ci`, then follow the README's local setup to create `.dev.vars` and start `npm run dev`. The standard Wrangler configuration binds both SQLite Durable Objects; do not commit personal account IDs or replace those bindings to make a local test work.

The source files are:

- `worker.src.js`: routes, HTML shells, authorization, and Durable Objects.
- `sdk.js`, `sdk_offline.js`: shared-state and exported-page SDKs.
- `bridge.js`: behavior inside the report iframe.
- `host.js`: editor/viewer toolbar, comments, version UI, and draft previews.
- `build.mjs`: inlines those scripts into generated `dist/worker.js`.

Edit source files, not `dist/worker.js`.

## Tests

```sh
npx playwright install chromium
npm run build
npm test
```

The default test runner checks webhook delivery with mocked fetches, starts an isolated local Wrangler instance with generated credentials, exercises API and helper workflows, verifies multi-client WebSocket synchronization, and runs the editor UI regression suite in Chromium. Tests do not require external network access, production secrets, or a deployed Worker. It stops the server on completion. Dependency and browser installation are separate setup steps.

For additional browser regressions, run:

```sh
npm run test:browser
```

This includes the core tests plus comment attribution/navigation, desktop/mobile editing, and the waiting-page/live-draft flow in Chromium. For the extended matrix, also install WebKit:

```sh
npx playwright install webkit
npm run test:all
```

The extended suite adds WebKit to editing and waiting-page regressions. On Linux, Playwright may need system dependencies (`npx playwright install --with-deps chromium webkit`). Browser installation downloads binaries; test execution itself uses local pages and blocks external resources. Keep local artifacts, screenshots, development vars, and Durable Object state out of commits.

GitHub Actions performs build and local tests only; it does not deploy, set secrets, or access a live site. See [TASK-comments.md](TASK-comments.md) for the comment regression contract. When a regression requires a browser, include a local fixture and explain the behavior it protects.

## Pull requests

Describe the user-visible change, relevant compatibility or migration effects, and which checks passed. Distinguish local emulation from actual Cloudflare deployment and physical-device testing. Keep changes focused, and document any new environment variables or API fields.

Do not use production reports or live credentials as test fixtures. Do not print tokens or request headers in logs. Review the staged diff and ignored files before committing. The repository should contain no personal domain, Cloudflare account/zone ID, local username/path, or private artifact identifier. Use example domains and descriptive placeholders.

For existing deployments, preserve the Worker name, binding names, object classes, and migration history. New migrations must account for retained SQLite data. A successful local test does not authorize deploying or changing any production resource.

The project uses the [MIT License](LICENSE). By contributing, you agree that your contributions are provided under that license.
