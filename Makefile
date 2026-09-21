.DEFAULT_GOAL := help

PORT = 8892
CONVEX = node_modules/.bin/convex

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make serve        Start the static site → http://localhost:$(PORT)"
	@echo "  make kill         Stop this project's HTTP server"
	@echo "  make validate     Every test, plain node, no install; plus the page drift check"
	@echo "  make pages        Regenerate the pages from _templates/ (never edit them by hand)"
	@echo ""
	@echo "  make install      npm install, for the Convex CLI only (not a root workspace member)"
	@echo "  make convex       Run the local dev deployment and push on every change"
	@echo "  make seed         Seed brands, sources and the six pasted examples into the dev deployment"
	@echo "  make dev-auth     Make the dev sign-in key and trust it on the dev deployment"
	@echo "  make dev-token    Print a dev sign-in token for ?devtoken= (localhost only)"
	@echo ""
	@echo "  make worker-install  npm install inside worker/ (wrangler, pinned)"
	@echo "  make worker-dev      Run the Worker locally on :8787 with a local R2"
	@echo "  make runner          How to run the local runner"
	@echo ""
	@echo "  Production is the owner's: see README.md, 'Going live'."
	@echo ""

# ── Dev server ────────────────────────────────────────────────────────────────
# scripts/serve.py is http.server plus Cache-Control: no-cache; a plain
# http.server sends only Last-Modified, so browsers keep stale ES modules after
# edits. Falls back to plain http.server outside the monorepo.
.PHONY: serve
serve:
	@echo "Serving → http://localhost:$(PORT)"
	@if [ -f ../../scripts/serve.py ]; then python3 ../../scripts/serve.py $(PORT); else python3 -m http.server $(PORT); fi

.PHONY: kill
kill:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Stopped server on port $(PORT)" || echo "No server running on port $(PORT)"

# ── Tests ─────────────────────────────────────────────────────────────────────
# The backend tests import convex/lib/*.ts directly, so this needs no install:
# only a Node that strips TypeScript types by default (verified on v25.4.0).
.PHONY: validate pages
validate:
	@node --test tests/
	@python3 scripts/pages.py --check

pages:
	@python3 scripts/pages.py

# ── Convex (dev) ──────────────────────────────────────────────────────────────
# The dev deployment is LOCAL (127.0.0.1:3210, HTTP actions on :3211), so its
# actions can reach `make worker-dev` on :8787. Point a page at it with
# ?convex=http://127.0.0.1:3210 on localhost.
.PHONY: install convex seed dev-auth dev-token
install:
	npm install

convex:
	$(CONVEX) dev --typecheck disable --tail-logs disable

seed:
	$(CONVEX) run seed:sources
	$(CONVEX) run seed:pastes

dev-auth:
	node scripts/dev-auth.mjs init
	$(CONVEX) env set MUG_DEV_JWKS "$$(node scripts/dev-auth.mjs jwks)"
	@echo "Add dev-admin to ADMIN_SUBJECTS on the dev deployment for admin: $(CONVEX) env set ADMIN_SUBJECTS dev-admin"

dev-token:
	@node scripts/dev-auth.mjs token

# ── Worker (dev) ──────────────────────────────────────────────────────────────
.PHONY: worker-install worker-dev runner
worker-install:
	cd worker && npm install

worker-dev:
	cd worker && npx wrangler dev --port 8787

runner:
	@echo "The runner fetches, from your own connection, what the Worker is refused."
	@echo "  1. Create a token in /admin/#runner and put it in runner/.env (see runner/.env.example)."
	@echo "  2. node runner/mug-runner.mjs drain          # pages and images waiting for the runner"
	@echo "     node runner/mug-runner.mjs scan <source>  # a whole source, from here"
