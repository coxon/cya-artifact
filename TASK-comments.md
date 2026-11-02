# Comment regression contract

This document describes the current comment behavior and local regression scope. It contains no production page IDs or deployment tasks.

## Attribution and navigation

- The toolbar has no comments/pin button. Pending comment markers and `.by` answer labels remain entry points to the comment panel.
- Each comment shows its stable number, status, request, location snippet, asker, answerer, timestamps, and resolved version when available.
- An unnamed asker displays as `Editor`. New job publications without an answer name use `Assistant`. Explicit author names, including existing historical names, are preserved.
- A `.by` label should carry `data-cid="<comment_id>"`. Clicking it opens the matching card; escape, close, or scrolling closes it. A viewer receives only public attribution plus an editor-link prompt, never private comment content.
- “Jump to comment” locates the selected element, verifies snippet text, and falls back to text search or the answer label. “View answer” prefers the label's containing block. A successful match is highlighted temporarily; missing matches show a notice.
- Labels cannot be edited as text, including labels nested in an editable parent. Application buttons and inputs must keep working.
- Legacy labels can be bound at publish time when exactly one valid `评论 N` reference identifies a comment. Existing IDs and nested markup are preserved; ambiguous references remain unbound.

## API behavior

Editor comment endpoints require `X-Edit-Token`; viewers receive `403`. Job publication accepts `author` and writes it to the resolved comments and version. Direct HTML publication accepts `author` but does not resolve an edit job. An absent direct-publish author is stored as `null`.

Admin metadata repair endpoints remain available:

- `POST /api/admin/artifacts/<id>/comments/<cid>` with `{author?,resolved_by?}`.
- `POST /api/admin/artifacts/<id>/versions/<n>` with `{author}`.

They change attribution, not job or comment status. See [docs/webhooks.md](docs/webhooks.md) for manual resolution and optional automation.

## Relevant implementation

| Concern | Location |
| --- | --- |
| Comment persistence, settlement, author metadata, versions | `ArtifactDO` in `worker.src.js` |
| Job publication, routing, private editor API | `handleAdmin`, `notifyJob`, `handleEditorApi` in `worker.src.js` |
| Label binding | `bindCommentChips` in `worker.src.js` |
| Host cards, panel, numbering, navigation | `host.js` |
| Label click interception, edit protection, location highlight | `bridge.js` |
| Version-checked editing helpers | `edit_fetch.sh`, `publish_edit.sh`, `artifact_put.sh` |
| Writing and attribution conventions | [GENERATOR.md](GENERATOR.md) |

## Local verification

Use the committed Wrangler configuration and local `.dev.vars` setup from [README.md](README.md). Leave webhook variables absent. Run only against a loopback server and create fresh fixtures.

`tests/comments_polish_test.mjs` covers comment-to-label mapping, explicit and missing authors, nested labels, location/highlight, edit protection, viewer permissions, history rendering, and desktop/mobile layouts. It uses a local admin token, creates its own pages/comments, blocks external browser requests, and writes screenshots and results under ignored `.codex-run/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test commands. Mobile browser emulation is not a substitute for native touch/long-press testing on a physical device.
