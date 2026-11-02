# rbxdl worker

Cloudflare Worker behind `/toys/rbxdl/`. Roblox's `assetdelivery`
endpoint is `Access-Control-Allow-Origin`, so a browser
cannot read the file. The worker fetches and adds CORS.

## deploy

```sh
cd tools/rbxdl-worker
npx wrangler deploy
```

`wrangler` prints the URL (something like `https://rbxdl.<subdomain>.workers.dev`).
Put that in `_config.yml`:

```yaml
rbxdl_endpoint: "https://rbxdl.<subdomain>.workers.dev"
```

That's it.

## routes

| route | returns |
| --- | --- |
| `GET /api/meta/:id` | JSON: name, type, creator, extension, blocked |
| `GET /api/file/:id?name=` | the file, with `Content-Disposition` |

## limits

- private, moderated, and place assets are refused.
- 32 MB cap or you get a 413.
- audio is served as ogg (how Roblox stores it). There is no ffmpeg here.
- no caching of file bytes. Metadata is cached for 10 minutes.

## locking it down

The worker defaults to `access-control-allow-origin: *` because it is read-only
and only speaks to Roblox. To restrict it, set a var:

```sh
npx wrangler deploy --var ALLOWED_ORIGINS:https://jitterdev.github.io
```

Cloudflare's rate limiting rules also apply.
