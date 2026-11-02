# cya-artifact

Self-hosted, commentable HTML report pages on Cloudflare Workers and SQLite Durable Objects. Publish a single HTML file, share a viewer or editor link, collect comments, and keep version history. Optional webhook integrations let your own automation generate pages or answer change requests.

No AI provider, custom domain, or webhook is required. Without automation, new pages and comments wait for an administrator to publish or resolve them manually.

> **Screenshot placeholder:** a report with an inline comment, its answer attribution, and the editor toolbar. Add a screenshot from a local fixture; do not include private reports or editor links.

**中文说明：** 这是一个可自行部署的「可评论 HTML 报告页」站点，支持分享、行内编辑、评论与回答署名、版本恢复、多人状态同步和实时写作。默认使用 Cloudflare 的 `workers.dev` 地址；自定义域名和自动回答 webhook 都是可选项。不配置 webhook 时仍可创建和发布页面、写评论、查看版本，并由管理员手动处理待办。下面提供从零部署、本地运行和 API 使用方法。

## Features

- Single-file HTML pages with separate viewer and editor links.
- Editable static text, autosave, and version checks to prevent stale overwrites.
- Comments on a selection or the whole page; answer labels link back to comments.
- Version history and restore API; HTML download with a state snapshot and browser print/PDF.
- Shared state and presence over WebSockets, persisted per artifact.
- Live HTML or Markdown drafts while writing; publishing saves the final version.
- Invite-gated creation, administrator API, optional generic webhook receivers.

The history API and preview/restore implementation are available; the existing toolbar history button is hidden by default. This project does not include an administrator dashboard.

## Quick start: your own Cloudflare deployment

Prerequisites: Node.js 22 or newer, npm, Git, curl, and a [Cloudflare account](https://dash.cloudflare.com/sign-up). Enable Workers and choose a `workers.dev` subdomain in the Cloudflare dashboard. Check Cloudflare's current plan limits for Workers and SQLite Durable Objects before choosing a production workload.

### 1. Get the code and deploy

```sh
git clone https://github.com/coxon/cya-artifact.git
cd cya-artifact
npm ci
npx wrangler login
npx wrangler deploy
```

The committed `wrangler.toml` builds `dist/worker.js`, binds `ARTIFACT` → `ArtifactDO` and `INDEX` → `IndexDO`, and creates both SQLite namespaces with migration `v1`. No account or zone IDs need to be committed; see the [Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/). Wrangler selects your authenticated account; if you have several, set `CLOUDFLARE_ACCOUNT_ID` locally.

Use the `https://<worker-name>.<your-subdomain>.workers.dev` URL printed by Wrangler. You can change the Worker name in your own configuration before the first deployment.

### 2. Set the administrator secret

Generate a long, random token in your password manager, then enter it when prompted:

```sh
npx wrangler secret put ADMIN_TOKEN
```

Keep the token private. Admin endpoints reject requests when this secret is absent. No webhook secrets are needed for the following steps.

Set the target URL and load the same token into your shell without placing its literal value in shell history:

```sh
export ARTIFACT_BASE_URL='https://<worker-name>.<your-subdomain>.workers.dev'
read -r -s ADMIN_TOKEN
export ADMIN_TOKEN
```

Paste the token at the silent prompt and press Enter. Do not enable shell tracing (`set -x`) when using these commands.

### 3. Create and publish your first page

These commands work unchanged against the local server described below. API responses containing invitations and editor links stay in the ignored `.codex-run/` directory.

```sh
umask 077
mkdir -p .codex-run
curl -fsS "$ARTIFACT_BASE_URL/api/admin/invites" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"My first pages","daily_limit":20}' > .codex-run/invite.json
INVITE=$(node -p 'JSON.parse(require("fs").readFileSync(".codex-run/invite.json")).code')

curl -fsS "$ARTIFACT_BASE_URL/api/create" \
  -H 'Content-Type: application/json' \
  -d "{\"invite\":\"$INVITE\",\"instructions\":\"Create my first report\"}" \
  > .codex-run/first-page.json
JOB_ID=$(node -p 'JSON.parse(require("fs").readFileSync(".codex-run/first-page.json")).job_id')
ARTIFACT_ID=$(node -p 'JSON.parse(require("fs").readFileSync(".codex-run/first-page.json")).artifact_id')

cat > .codex-run/first.html <<'HTML'
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My first report</title></head>
<body><h1>My first report</h1><p id="summary">Ready for comments.</p></body></html>
HTML
./publish.sh "$JOB_ID" .codex-run/first.html 'My first report'
```

Open the `edit_url` stored in `.codex-run/first-page.json` to edit text or select text and add a comment. Share only `view_url` with viewers. The invite can also be entered in the home page form to create later pages.

Without a webhook, comments appear as **Pending** (stored as `open`) and their jobs as `pending`. Resolve a request manually:

```sh
curl -fsS "$ARTIFACT_BASE_URL/api/admin/jobs?status=pending&kind=edit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" > .codex-run/pending-jobs.json
# Set EDIT_JOB_ID to a job id from that file.
./edit_fetch.sh "$EDIT_JOB_ID" > .codex-run/revised.html
# Edit .codex-run/revised.html, keeping other content and shared-state keys intact.
./publish_edit.sh "$EDIT_JOB_ID" .codex-run/revised.html 'Addressed the comment' 'Maintainer'

curl -fsS "$ARTIFACT_BASE_URL/api/admin/artifacts/$ARTIFACT_ID/versions" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

`publish_edit.sh` uses the `base_version` saved by `edit_fetch.sh`. Exit code `3` means someone saved a newer version: fetch again, reapply the change, and retry. Publishing through the job endpoint resolves its comments and records the answering name. See [webhook and manual processing](docs/webhooks.md) for failure handling, retry, and routing.

## Run locally, without a Cloudflare login

Install dependencies once, then create an isolated development token:

```sh
npm ci
umask 077
node -e 'require("fs").writeFileSync(".dev.vars", "ADMIN_TOKEN=" + require("crypto").randomBytes(32).toString("base64url") + "\n", {flag:"wx", mode:0o600})'
npm run build
npm run dev
```

`npm run dev` runs Wrangler in local mode on `http://127.0.0.1:8787`; both Durable Objects persist in the ignored `.wrangler/` directory. The token-generation command deliberately refuses to overwrite an existing `.dev.vars`. Do not copy production credentials into this file, and leave webhook settings absent for isolated local work.

In a second terminal, from the repository root:

```sh
set -a
. ./.dev.vars
set +a
export ARTIFACT_BASE_URL=http://127.0.0.1:8787
```

Follow step 3 above to create a page, publish it, post a comment, resolve it, and inspect versions. Live writing works locally too:

```sh
./stream_start.sh "$ARTIFACT_ID" 'Writing a revision'
printf '%s' '<!doctype html><html><head><title>Draft</title></head><body>' | ./stream_append.sh "$ARTIFACT_ID"
printf '%s' '<h1>A live draft</h1></body></html>' | ./stream_append.sh "$ARTIFACT_ID"
./stream_end.sh "$ARTIFACT_ID"
```

This aborts the preview without publishing. To save a draft, publish `.drafts/<artifact_id>.html` through its job or the version-checked HTML API. See [GENERATOR.md](GENERATOR.md).

## Configuration

`.env.example` lists placeholders. Shell helpers do not automatically load `.env`; export values explicitly or source your own ignored file. Wrangler reads local Worker secrets from `.dev.vars`; deployed Worker secrets are set with Wrangler. Deployment credentials and application credentials serve different purposes.

| Setting | Used by | Requirement / default |
| --- | --- | --- |
| `ADMIN_TOKEN` | Worker and API helpers | Required for administrator operations; secret, no default. |
| `ARTIFACT_BASE_URL` | Shell helpers / optional API deploy | Helper target origin; defaults to `http://127.0.0.1:8787`. Worker-generated links use the incoming request's origin. |
| `ADMIN_TOKEN_FILE` | Shell helpers | Optional explicit file containing the admin token, when `ADMIN_TOKEN` is absent. |
| `ARTIFACT_BASE` | Shell helpers | Legacy alias for `ARTIFACT_BASE_URL`. |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler | Optional local account selection when needed; never commit a real ID. |
| `CLOUDFLARE_API_TOKEN` | Optional API deployment / secret script | Cloudflare API credential; also supported by Wrangler for noninteractive authentication. |
| `CF_ACCOUNT_ID` | `deploy.mjs`, `set_secret.mjs` | Required Cloudflare account ID for the optional API scripts. |
| `CF_WORKER_NAME` | API scripts | Defaults to `cya-artifact`; use the existing name when migrating. |
| `CF_ZONE_ID` | `deploy.mjs --domain` | Required only when attaching a custom domain. |
| `ROUTINE_WEBHOOK_URL` | Worker | Optional receiver for new jobs and default edit jobs. |
| `ROUTINE_SENDER_KEY` | Worker | Optional Bearer key; required with the routine URL to send notifications. |
| `ROUTINE_SENDER_KEY_ARTIFACT` | Worker | Legacy alias, used if `ROUTINE_SENDER_KEY` is absent. |
| `EDITOR_WEBHOOK_URL`, `EDITOR_SENDER_KEY` | Worker | Optional separate receiver/key pair for artifacts with `route:"editor"`. |

### Optional custom domain

The default deployment needs no zone ID. For a custom domain, copy `wrangler.toml` to ignored `wrangler.local.toml`, preserve its bindings and migration, and add a top-level route before the TOML table sections:

```toml
routes = [{ pattern = "reports.example.com", custom_domain = true }]
```

Then use `npx wrangler deploy --config wrangler.local.toml` and pass the same `--config` when setting secrets. The hostname must belong to a zone in your Cloudflare account. Choose whether to keep `workers_dev = true` in your local configuration.

### Optional direct API deployment

`deploy.mjs` is an alternative to Wrangler, not a required setup step. Export `CF_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and optionally `CF_WORKER_NAME`, then run `npm run build` followed by `node deploy.mjs`. It keeps existing secrets and enables a [`workers.dev` route](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/). To attach a custom domain, also set `CF_ZONE_ID` and an HTTPS `ARTIFACT_BASE_URL`, then use `node deploy.mjs --domain`. `node set_secret.mjs NAME` sets a secret from stdin. These commands change your Cloudflare deployment.

### Migrating an existing deployment

- Keep the same Cloudflare account, Worker name, Durable Object binding names/classes, and existing migration history. Changing them can create an empty, separate deployment.
- Put your existing name and any domain routes/account selection in ignored `wrangler.local.toml`, or export `CF_WORKER_NAME`, `CF_ACCOUNT_ID`, and, for an API-managed domain, `CF_ZONE_ID` and `ARTIFACT_BASE_URL`.
- Keep existing `ADMIN_TOKEN` and webhook secrets. `ROUTINE_SENDER_KEY_ARTIFACT` remains supported; the generic `ROUTINE_SENDER_KEY` takes precedence.
- Explicitly set `ADMIN_TOKEN_FILE` if you previously relied on a local `.admin_token` file. Helpers no longer discover that file implicitly.
- A separately routed editor integration with an incomplete URL/key pair now skips delivery instead of falling back to the routine integration. Jobs remain pending for manual processing or a later retry.
- The owner-specific bundled demo image endpoint has been removed. Pages that referenced it must embed or replace that image.
- Stored author names and legacy `source:"cya"` values remain valid. New unspecified answers display as `Assistant`; unnamed commenters display as `Editor`.

## API overview

JSON request bodies use `Content-Type: application/json`. Admin calls use `Authorization: Bearer <ADMIN_TOKEN>`; editor calls use `X-Edit-Token: <edit_token>`.

| Endpoint | Access / purpose |
| --- | --- |
| `POST /api/create` | Invite code; `{invite,instructions,context?,url?}` creates a pending job and editor/viewer links. |
| `GET /a/<id>` | Public viewer; `?edit=<token>` enables editing. |
| `GET /a/<id>/{raw,export,status}` | Public rendered HTML, offline export, or status/live draft. |
| `GET /a/<id>/ws` | Public shared-state socket; `?live=1` watches draft updates. |
| `GET /api/a/<id>/{me,source,versions,comments}` | Editor-only metadata, source, history, comments. |
| `POST /api/a/<id>/versions` | Editor save with `{html,base_version,author?}`. |
| `GET /api/a/<id>/versions/<n>` | Editor-only version preview. |
| `POST /api/a/<id>/restore` | Editor restore with `{n}`; creates another version. |
| `POST /api/a/<id>/comments` | Editor request with `{request,author?,selector?,text?,html?}`. |
| `GET /api/admin/jobs` | Admin queue, filtered by `status` and/or `kind`. |
| `GET /api/admin/jobs/<id>` | Authoritative job and current source for edit jobs. |
| `POST /api/admin/jobs/<id>/{publish,fail,notify}` | Publish/resolve, fail, or retry notification. |
| `GET/POST /api/admin/artifacts/<id>/html` | Read/write source; writes require `base_version` unless deliberately forced. |
| `GET/POST /api/admin/artifacts/<id>/draft` | Read live draft or `start` / `append` / `end`. |
| `GET /api/admin/artifacts/<id>/{versions,comments,state,edit-token}` | Admin inspection and editor-link retrieval. |
| `POST /api/admin/artifacts/<id>/edit-token/rotate` | Revoke the old editor link and issue a new one. |
| `POST /api/admin/artifacts/<id>/{settings,copy,reset-state}` | Notification/routing settings, test copy, or destructive state reset. |
| `GET/POST /api/admin/invites` | List/create invitation codes. |
| `POST /api/admin/invites/<code>/revoke` | Revoke an invitation. |

See [GENERATOR.md](GENERATOR.md) for the shared-state SDK and writing contract, and [docs/webhooks.md](docs/webhooks.md) for full integration examples.

## Security and operational limits

- Viewer URLs are public, unlisted links, not authentication. Anyone with a viewer URL can read the page, exported HTML, shared state, and active drafts, and can write collaborative state through the public sync socket. Do not publish confidential material without adding your own access layer.
- Editor links are bearer credentials. They grant source editing, private comment/history access, and restore rights. Keep them out of screenshots, logs, analytics, and public links; rotate a leaked token. Comments are private to editors/admins, but text and names placed in the published HTML are public.
- `ADMIN_TOKEN` grants administration of every page and invite. Keep it separate from webhook sender keys and Cloudflare API credentials. Never put secrets in generated HTML, source control, or CI logs.
- HTML runs in a sandboxed iframe with an opaque origin and CSP restrictions. Inline scripts and selected CDN scripts are allowed. External fetch/XHR, arbitrary remote images, embedded frames, and form navigation are blocked. This is isolation, not a guarantee that untrusted scripts or downloaded HTML are safe; review code and dependencies you publish.
- A webhook receiver must authenticate notifications, use its configured site origin for admin API calls, and treat all user instructions, HTML, selectors, snippets, and context URLs as untrusted input. See the integration document for URL-fetching precautions.
- Creation is invite-gated with a default limit of 20 jobs per rolling 24 hours per invite; comments are limited to 30 per page per rolling 24 hours. HTML and live drafts are capped at 1.5 MiB (currently measured in JavaScript string length), shared state at approximately 1 MiB, and each state update at 256 KiB (these limits use string-length accounting, not a consistent encoded-byte count). Drafts expire after 15 minutes of inactivity.
- Stored pages and history live in Durable Objects. Plan your own backup/export and retention policy; this project has no automated backup or deletion dashboard. Cloudflare usage can incur charges.

## Development and contributing

`npm run build` inlines the SDK, offline SDK, bridge, and host code into `dist/worker.js`. GitHub Actions runs the build and tests without deployment credentials or a deployed site. See [CONTRIBUTING.md](CONTRIBUTING.md) for local test commands and [TASK-comments.md](TASK-comments.md) for the comment regression contract.

## Authors and acknowledgements

- **coxon** — product and requirements.
- **Cya.Editor** (Grok Bot) — maintenance and deployment.
- **Codex** — development.

[MIT License](LICENSE), Copyright (c) 2026 coxon.
