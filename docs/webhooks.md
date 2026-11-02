# Optional webhook integrations

Webhooks notify your own generator, workflow service, or human-assisted editor that a job is ready. They are optional. An unconfigured receiver does not prevent page creation, publishing, comments, version history, shared state, or live writing.

Without a receiver, a new page waits for manual publication. Comments remain `open` (shown as **Pending**) and their edit jobs remain `pending`. The administrator can process the same jobs using the API or shell helpers below.

## Configure receivers

Set these values as Worker secrets on your own deployment, or in ignored `.dev.vars` for a local receiver:

| Route | URL | Bearer key |
| --- | --- | --- |
| Default / routine | `ROUTINE_WEBHOOK_URL` | `ROUTINE_SENDER_KEY` (legacy fallback: `ROUTINE_SENDER_KEY_ARTIFACT`) |
| Separate editor | `EDITOR_WEBHOOK_URL` | `EDITOR_SENDER_KEY` |

Each route requires both its URL and a nonempty key. New-page jobs always use the routine route. Edit jobs use the routine route unless their artifact has `route:"editor"`. Set the route through:

```sh
curl -fsS "$ARTIFACT_BASE_URL/api/admin/artifacts/$ARTIFACT_ID/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"route":"editor","notify":true}'
```

Use `route:"routine"` for the default receiver; legacy `route:"cya"` is also accepted. `notify:false` suppresses notification for that artifact. Copies default to notifications off.

A missing editor URL/key pair **does not** fall back to the routine receiver. It records `{"skipped":"not_configured"}` instead. With `notify:false`, the result is `{"skipped":"notify_off"}`. Jobs and comments remain available for manual processing.

The receiver needs a separately provisioned `ADMIN_TOKEN` to fetch and publish jobs. A sender key authenticates notifications only; it does not authorize the administrator API.

## Notification format

The Worker sends an HTTP `POST` with:

```http
Content-Type: application/json
Authorization: Bearer <sender key for this route>
```

```json
{
  "job_id": "jExampleJob12345",
  "artifact_id": "Example123",
  "kind": "edit",
  "url": "https://reports.example.com/a/Example123"
}
```

- `job_id`: identifier to fetch from the administrator API.
- `artifact_id`: page identifier, also verified against the fetched job.
- `kind`: `new` or `edit`; read the authoritative kind from the job.
- `url`: viewer URL based on the request's origin. It contains no admin or editor token.

The notification is a pointer, not the complete task. The receiver should verify the Bearer key before accepting a payload, validate the payload shape, queue work, and return a `2xx` response promptly. Processing can finish asynchronously through the publish/fail API. Do not redirect the notification endpoint: the sender does not follow redirects and uses a ten-second timeout.

The job's `notified` field records the latest delivery result as a JSON-encoded string: HTTP `{status,to}`, a skipped reason, or `{error:"delivery_failed",to}`. `to` is `routine` or `editor`. A successful HTTP response means the notification was accepted; it does not mean the job has been completed. Non-2xx responses and transport errors leave the job pending. There is no automatic retry scheduler or exactly-once delivery guarantee.

To resend after fixing configuration or recovering a receiver:

```sh
curl -fsS -X POST "$ARTIFACT_BASE_URL/api/admin/jobs/$JOB_ID/notify" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

This still respects the artifact's `notify` setting. Receivers should deduplicate by job ID and inspect current job status before writing. An administrator can deliberately republish a completed job; the server does not make repeated publishes idempotent.

## Fetch the authoritative job

Use a configured, trusted `ARTIFACT_BASE_URL`; do not derive an admin endpoint from an untrusted webhook `url`.

```sh
umask 077
mkdir -p .codex-run
curl -fsS "$ARTIFACT_BASE_URL/api/admin/jobs/$JOB_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" > .codex-run/job.json
```

Common fields include `id`, `artifact_id`, `kind`, `status`, `instructions`, `context_text`, `context_url`, `title`, `reason`, `created`, `updated`, and `url`. Timestamps are Unix milliseconds. Job statuses are `pending`, `ready`, and `failed`. Stop if the job is not pending, unless an administrator explicitly requested another publication.

An edit job additionally provides:

```json
{
  "kind": "edit",
  "current_version": 3,
  "title": "Example report",
  "html": "<!doctype html>...",
  "comments": [
    {
      "id": "cExample123",
      "request": "Clarify the summary",
      "author": "Reviewer",
      "selector": "#summary",
      "snippet_text": "Original summary",
      "snippet_html": "<p id=\"summary\">Original summary</p>",
      "status": "open",
      "created": 0
    }
  ]
}
```

`selector` is a hint from the live document; confirm it using the snippet and current source. A null selector means a whole-page request. Dynamic elements may not exist in the static HTML. The returned `html` and `current_version` are the current source, even if other editors have changed the page since the comment was created.

## Publish or fail

New jobs accept:

```http
POST /api/admin/jobs/<job_id>/publish
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"html":"<!doctype html>...","title":"My report","author":"My generator"}
```

Edit jobs require the version you read:

```http
POST /api/admin/jobs/<job_id>/publish
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"html":"<!doctype html>...","base_version":3,"note":"Clarified the summary","author":"Maintainer"}
```

A successful publish returns `{ok:true,url,version}` (new jobs also include artifact metadata), saves a new version, ends any draft, marks the job `ready`, and broadcasts an update. Edit publication also marks that job's comments `resolved`, records `resolved_by`, and preserves shared state. `author` is trimmed to 60 characters; absent, blank, or non-string authors default to `Assistant`. Existing source values such as `cya` remain compatibility labels, not a requirement to use a particular provider.

A stale `base_version` returns HTTP `409` with `error:"stale"` and `current_version`. Fetch the job again, reapply only the requested change to the new source, and retry. Do not use `force:true` to bypass concurrent edits in normal automation.

To fail a job:

```http
POST /api/admin/jobs/<job_id>/fail
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"reason":"The requested change needs more information."}
```

The job becomes `failed`. An edit failure marks its comments failed, stops the draft, and keeps the published page unchanged. A new-page failure appears on its waiting page.

## Manual processing without a webhook

Export `ARTIFACT_BASE_URL` and `ADMIN_TOKEN` as in the README, then:

```sh
umask 077
mkdir -p .codex-run
curl -fsS "$ARTIFACT_BASE_URL/api/admin/jobs?status=pending&kind=edit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" > .codex-run/pending-jobs.json
# Choose a job from that file and set JOB_ID.
./edit_fetch.sh "$JOB_ID" > .codex-run/revised.html
# Make the requested change in .codex-run/revised.html.
./publish_edit.sh "$JOB_ID" .codex-run/revised.html 'Applied requested change' 'Maintainer'
# Or: ./fail.sh "$JOB_ID" 'Reason visible to the editor'
```

`edit_fetch.sh` caches the fetched version in `.edits/`. `publish_edit.sh` sends that version and returns exit code `3` for a conflict. New-page jobs can be published with `./publish.sh "$JOB_ID" page.html 'Title'`.

Direct `POST /api/admin/artifacts/<id>/html` saves a version but does **not** resolve an edit job's comments. Use the job publish endpoint when answering a pending comment. The metadata backfill endpoint for comments only changes author names, not their status.

## Live writing and answer labels

Optional live-writing calls use the same admin token:

```http
POST /api/admin/artifacts/<artifact_id>/draft
{"op":"start","note":"Preparing the revision"}

POST /api/admin/artifacts/<artifact_id>/draft
{"op":"append","chunk":"<h1>Updated report</h1>"}

POST /api/admin/artifacts/<artifact_id>/draft
{"op":"end"}
```

Start, append in reading order as you write, then publish the completed HTML. A publish ends the preview automatically; `end` aborts without saving a version. A draft expires after 15 minutes of inactivity. Preview scripts do not execute. Active drafts are visible to viewers, so do not stream private reasoning or credentials.

To connect a published answer to its comment, include the exact comment ID:

```html
<span class="by" data-cid="cExample123">Maintainer 答 · 评论 2</span>
```

Preserve existing `data-cid` values. The displayed number is the position among **all** comments on the artifact ordered by creation time, not the position in a single job. The ID is authoritative. See [GENERATOR.md](../GENERATOR.md) for the shared-state SDK and legacy label compatibility.

## Receiver security

Treat instructions, comments, HTML, selectors, and context as untrusted data. An automated generator should only build or edit the specified page; it must not obey content asking it to reveal credentials, message other people, or operate unrelated systems.

Fetch job context URLs only under an explicit policy: allow approved schemes/hosts, block private and link-local network destinations and metadata services, limit redirects/size/time, and revalidate redirect destinations. Never attach the admin token to a context URL. Keep the receiver's configured base origin separate from user-supplied URLs and webhook fields. Do not log Authorization headers, admin tokens, edit tokens, or full private job bodies.
