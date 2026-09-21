# CLAUDE.md: Mug

A catalogue of collectible character mugs (3D sculpted, shaped, bas relief,
tiki, teapots) with collectors' shelves. The admin imports listings from brand
shops through a Cloudflare Worker, a local runner reads what the Worker is
refused, and everything waits in a review queue before it is published.

**Domain:** mug.neorgon.com (not live yet) · **Port:** 8892 · **Contracts:**
`docs/CONTRACTS.md` (read it before changing any interface; amend, never edit
silently) · **Sources and why:** `docs/sources.md`

## Run

```bash
make serve          # static pages → http://localhost:8892
make convex         # the LOCAL dev deployment (127.0.0.1:3210, HTTP actions :3211), pushes on change
make worker-dev     # the Worker on :8787 with a local R2
make validate       # node --test tests/ plus the page drift check; no install
make seed           # 12 brands, 12 sources, the owner's six pasted Amazon examples
make dev-token      # a dev sign-in token for ?devtoken= (see "Dev sign-in")
```

Open a page against the dev backend with `?convex=http://127.0.0.1:3210` on
localhost (remembered per browser; `?convex=` forgets it).

## Architecture in one breath

`shared/` is the listing contract (C1) and every extractor, imported unchanged
by the Worker (`worker/`), the runner (`runner/`), Convex (`convex/`) and the
admin page. Convex owns all state and identity; the Worker is stateless and
answers only Convex (one shared secret) plus public `GET /i/<key>` images from
R2. Writes live in `convex/lib/*Core.ts`, which take a `db` and never read
`process.env`, so `tests/` runs them on `tests/support/fakedb.mjs`, which
parses the real schema.

## Gotchas

**The pages are generated.** `index.html`, `mug/`, `brand/`, `community/`,
`shelf/`, `u/`, `admin/` and `bot/` come from `_templates/page.html` plus
`_templates/main/<page>.html` via `make pages`. A hand edit is overwritten and
`make validate` fails on the drift first.

**The Write tool decodes backslash-u escapes into raw characters.** A regex
written with escaped combining-mark code points landed as invisible combining
characters, a test's escaped BEL as a raw 0x07 byte, and an escaped em dash as
the banned character itself. Use `\p{M}`, `String.fromCharCode(...)` or
`new RegExp(...)` instead. `tests/syntax.test.mjs` fails on raw control
characters and em dashes in our modules.

**Convex refuses an auth config that reads an unset variable** (CONTRACTS
A7). `MUG_DEV_JWKS` must exist on every deployment: a `data:` URI on dev, the
literal `off` on production. Anything but `data:` adds no dev issuer.

**Check an env value with `npx convex env get NAME | shasum`**, never
`env list`, which prints every secret.

**Not a root npm workspace member**, so `npm install` here is local and safe
(`npm prefix` prints this folder). Never run npm at the monorepo root for this
site.

**A shop's Shopify `vendor` is often the licence, not the maker** (A6).
Sources carry their own brand, and the Worker and runner are told it.

**Amazon is never fetched**, and neither are Silver Buffalo's or Just Funky's
shops (robots.txt `Disallow: /`). Those enter by paste or by hand. Neither the
Worker nor the runner ever presents a browser User-Agent or skips robots.txt;
do not add an option that does.

**R2 keys are content addresses** (`o/<sha256>.<ext>`), so two mugs can share
one object. Hiding a mug never deletes R2 objects; `images:forget` deletes
only Convex files.

**Thumbnails:** a Shopify CDN image gets the CDN's own `width=480` copy at
mirror time (A5); everything else waits in `/admin/#images`, where the admin's
browser makes them. Free Workers cannot resize images.

**Publishing is closed until `PUBLISHING=open`** on the deployment: handles
can be claimed, but `/u/` and the community page name nobody. Photos are
pending until an admin approves them.

**Dev sign-in:** the production Clerk key refuses localhost. `make dev-auth`
makes a key pair in `.dev-auth/` (gitignored) and trusts its public half on
the dev deployment; `make dev-token` mints a token; open any page with
`?devtoken=<token>`. Subject `dev-admin` is in the dev `ADMIN_SUBJECTS`.
