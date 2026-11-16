# Sago Media

Self-hosted media upload backend for [Sago Drop](https://github.com/sago-cream/sago-drop). It provides device authorization, bounded uploads, image optimization, public share links, and an administration dashboard. Videos are normalized locally by Sago Drop before upload; the server validates and stores them without transcoding.

The former npm CLI and pull-request upload API were removed in v1.0.0. Use [`gh-image`](https://github.com/drogers0/gh-image) or GitHub's editor for pull-request attachments.

## Configuration

- `MEDIA_BASE_URL` and `MEDIA_PUBLIC_URL`
- `MEDIA_GITHUB_CLIENT_ID` and `MEDIA_GITHUB_CLIENT_SECRET`
- `MEDIA_OWNER_GITHUB_ID`, using GitHub's immutable numeric user ID
- upload limits from `MEDIA_*` variables, including `MEDIA_UPLOAD_TIMEOUT_MS`

The GitHub OAuth callback is `$MEDIA_PUBLIC_URL/auth/github/callback`.

Video uploads must be H.264/AAC MP4 files using `yuv420p` at no more than
1920x1080 in landscape or 1080x1920 in portrait.

## Workspace

- `server/` contains the Bun API, authentication, database, and dashboard API.
- `web/` contains the Vite and React admin dashboard.
- `scripts/` contains the media processing pipeline.

Run the development servers together:

```bash
bun run dev
```

The dashboard is available from Vite at `http://localhost:5173/admin/`; API requests are proxied to the Bun service on port 3000.

## Build and test

```bash
bun run check
docker build -t sago-media .
```

## Release

After merging a release commit that updates `package.json`, create and push the matching tag. Tagged releases publish the multi-architecture container image.

```bash
git tag v2.0.0
git push origin v2.0.0
```

## Upgrade from 1.x

Version 2.0 replaces `PR_MEDIA_*` settings with `MEDIA_*`, renames the product
commands to `sago-media-*`, and uses `/srv/sago-media` as the default storage root.
There are no legacy aliases. Update the environment and volume mount together
with the image. Keep the existing media files and `.service/media.sqlite` so
share URLs, device credentials, and sessions survive the upgrade.

Sago Cloud owns the host migration, Compose service, timers, and Caddy routing.
Follow its [media migration guide](https://github.com/sago-cream/sago-cloud/blob/main/docs/media-migration.md) before deploying 2.0. The HTTP endpoints and
content-addressed share paths are unchanged; Sago Drop needs no client release.

## Upload jobs

Sago Drop 0.11.0 and later use `POST /v1/upload-jobs` with a UUID
`Idempotency-Key` and `X-Media-SHA256`. A `202` response means the complete,
checksum-verified file and its SQLite job are saved on the persistent volume.
Authenticated `GET /v1/upload-jobs/:id` returns `receiving`, `queued`,
`processing`, `ready` with a final result, or `failed` with an explanation.
Jobs are visible only to devices belonging to the same GitHub account.

The in-process worker bounds concurrency and processing duration, recovers jobs
on restart, and retains terminal results for seven days. Retries with the same
ID and file do not create a second job or charge quota twice. Failed jobs refund
the original reservation, including when processing crosses midnight. An
interrupted, unacknowledged transfer can be uploaded again with the same ID.

The retired `/v1/uploads` endpoint returns a plain-text `426` upgrade instruction
that existing clients display. For a staged rollout only, set
`MEDIA_ALLOW_LEGACY_UPLOADS=1` to temporarily keep synchronous uploads working.
Deploy the job-capable server with this setting, publish Sago Drop 0.11.0, then
remove the setting after verifying the app release is downloadable. Keep the
media volume mounted: both staged input and the queue live under `.service`.
