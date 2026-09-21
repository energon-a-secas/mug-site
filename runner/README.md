# mug-runner

Some shops refuse requests from datacenter addresses, the Worker's included.
The runner does the same work from the owner's own connection: it reads the
pages and images Convex queued for it, and posts the results back over
Convex's `/runner/` HTTP routes (`docs/CONTRACTS.md` C8). It can also scan a
whole source.

It is the same reader as the Worker, not a second one. Discovery and
extraction are `worker/src/shop.js`, fetching is `shared/net/polite.js`, and
the extractors are `shared/extract/`. So the runner is bound by the same rules
(C10):

- it always identifies as `MugBot/1.0 (+https://mug.neorgon.com/bot/)`;
- it reads robots.txt before the first request to a host, and obeys it: a
  disallowed page is reported to Convex as `ROBOTS_DISALLOWED`, never worked
  around;
- it follows redirects by hand, each hop checked, with the same caps and the
  same 15 s deadline.

There is no option to present a browser user agent or to skip robots.txt, on
purpose. Two things are added because the runner runs on a home network:

- it waits 1.5 s between requests to the same host (robots.txt included);
- it checks every address a shop's name resolves to, at connect time, and
  refuses private, loopback, link-local and CGNAT ones, so a public name that
  points into the home network (a shop's own record, or `10.0.0.1.nip.io`) is
  refused before a byte is sent.

Node 18 or newer. No dependencies, nothing to install.

## Configuration

From the environment, or `runner/.env` (gitignored; copy `.env.example`). The
environment wins.

| Name | Value |
|---|---|
| `MUG_CONVEX_SITE` | `https://<deployment>.convex.site`, or `http://127.0.0.1:3211` for a local deployment |
| `MUG_RUNNER_TOKEN` | `mugr_` and 32 letters and digits, made in the admin page and shown once |
| `MUG_DEV_ALLOW_LOOPBACK` | `1` only to scan a fixture shop on `127.0.0.1` or `localhost` |

The token is never printed, and is redacted from any message that would echo it.

## Commands

```bash
node runner/mug-runner.mjs drain [--limit N] [--dry]
node runner/mug-runner.mjs scan <sourceSlug> [--max-pages N]
node runner/mug-runner.mjs help
```

**drain** asks `GET /runner/queue?limit=N` (default 25) and works through it:

- a `page` item is extracted (a Shopify `/products/<handle>` path reads
  `<url>.json` first, anything else reads the HTML) and posted to
  `/runner/ingest` as `{ id, listing }`, or `{ id, error: { code, message } }`;
- an `image` item is fetched and sniffed, then uploaded to Convex storage
  (`POST /runner/upload-url`, then `POST <uploadUrl>` with the image's
  Content-Type) and attached with `POST /runner/image { mugId, index, storageId }`.
  An image that cannot be fetched or is not an image is reported with
  `/runner/ingest { id, error }`; a failed upload is left in the queue.

`--dry` does all of the reading and posts nothing (the queue is still read
with its GET).

**scan** asks `POST /runner/scan { sourceSlug }` for a run and the source, then
reads the source's entry URLs exactly as the Worker would for its adapter,
extracts jsonld URLs one by one, posts `/runner/stage` in chunks of at most 50,
and ends with `POST /runner/finish { runId, error? }`. The source's `brand`
(A6) is passed to the extractors. `--max-pages` defaults to, and is capped at,
the 40 discover pages C10.5 allows a scan. A page that fails is counted and
skipped; an entry URL that fails on its first page is named in `error`.

Exit codes: `0` done (individual items may still have failed; the summary
says which), `1` a runtime failure such as Convex being unreachable, `2` a
usage or configuration error, including a refused token.

## Assumptions about the Convex side

C8 fixes the routes; two details it leaves open, which the runner settles
this way:

- image failures are reported through `/runner/ingest` with the queue item's
  `id`, since `/runner/image` has no error form. `convex/runner.ts` queues
  image items as `"<mugId>:<index>"` and its ingest takes staging ids only, so
  today it answers `bad-id`; the runner says so and the image stays queued
  (and is tried again by the next drain) until Convex accepts image ids;
- `/runner/finish`'s `error` is a string, `"<CODE> on <url>: <message>"`,
  several joined with ` | `, at most 500 characters (which `convex/http.ts`
  expects).

## Tests

`tests/runner.test.mjs` runs drain and scan against a stubbed Convex and
synthetic shops, checks the pacing on a fake clock, runs the DNS-guarded fetch
over a real loopback socket, and runs the CLI as a process. No test reaches a
real shop.
