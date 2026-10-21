# rbxdl worker

Cloudflare Worker behind `/toys/rbxdl/`. It exists for one reason: Roblox's
`assetdelivery` endpoint sends no `Access-Control-Allow-Origin`, so a browser
cannot read the file. The worker fetches server-side and adds CORS.

## deploy

```sh
cd tools/rbxdl-worker
npx wrangler deploy
```

`wrangler` prints the URL, something like `https://rbxdl.<subdomain>.workers.dev`.
Put that in `_config.yml`:

```yaml
rbxdl_endpoint: "https://rbxdl.<subdomain>.workers.dev"
```

That is the only wiring. The toy reads the value at build time.

## routes

| route | returns |
| --- | --- |
| `GET /api/meta/:id` | JSON: name, type, creator, extension, blocked |
| `GET /api/file/:id?name=` | the file, with `Content-Disposition` |

## limits

- public assets only. private, moderated, and place assets are refused.
- 32 MB cap. Anything bigger gets a 413.
- audio is served as Roblox stores it (ogg). There is no ffmpeg here.
- no caching of file bytes. Metadata is cached for 10 minutes.

## locking it down

The worker defaults to `access-control-allow-origin: *` because it is read-only
and only speaks to Roblox. To restrict it, set a var:

```sh
npx wrangler deploy --var ALLOWED_ORIGINS:https://jitterdev.github.io
```

Cloudflare's rate limiting rules also apply if the toy ever gets popular.
