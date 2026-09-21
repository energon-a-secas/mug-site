#!/usr/bin/env python3
"""Generate Mug's pages from _templates/page.html.

    python3 scripts/pages.py            # write every page
    python3 scripts/pages.py --check    # exit 1 when a page differs from what the template makes

Every page shares one head, header and footer, so they live once, in the
template; a page contributes its <main> (from _templates/main/<page>.html) and
its head values (below). Never edit a generated page by hand: `--check` runs
in `make validate` and fails on the drift, which is how vitrina's routes.py
keeps three pages from quietly diverging (projects/vitrina-site/scripts/routes.py).

The template lives in an underscore directory on purpose: Jekyll leaves it out
of the published site.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "_templates" / "page.html"
MAIN_DIR = ROOT / "_templates" / "main"
SITE = "https://mug.neorgon.com"

# The production Convex deployment's URL, once it exists. Empty leaves every
# page on "not connected yet"; on localhost ?convex= overrides it (js/backend.js).
CONVEX_URL = ""

JSONLD = """  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "Mug",
    "description": "Browse character, 3D sculpted and shaped mugs from brand shops, track the ones you own and want, and share your shelf",
    "url": "https://mug.neorgon.com/",
    "applicationCategory": "LifestyleApplication",
    "operatingSystem": "Any",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    "author": { "@type": "Organization", "name": "Neorgon", "url": "https://neorgon.com/" }
  }
  </script>
"""

APP = '  <script type="module" src="/js/app.js"></script>\n'

PAGES = [
    {
        "page": "catalog", "out": "index.html", "path": "/", "nav": "catalog",
        "title": "Mug | Collectible Drinkware Catalog",
        "description": "Browse character, 3D sculpted and shaped mugs from brand shops, track the ones you own and want, and share your shelf",
        "robots": "index, follow", "jsonld": True,
    },
    {
        "page": "mug", "out": "mug/index.html", "path": "/mug/", "nav": "catalog",
        "title": "A mug | Mug",
        "description": "Capacity, style, maker and where it is sold, for one mug in the catalog, and who collects it",
        "robots": "index, follow",
    },
    {
        "page": "brand", "out": "brand/index.html", "path": "/brand/", "nav": "catalog",
        "title": "A maker | Mug",
        "description": "Every mug one maker has in the catalog, newest first",
        "robots": "index, follow",
    },
    {
        "page": "community", "out": "community/index.html", "path": "/community/", "nav": "community",
        "title": "Collectors | Mug",
        "description": "See which mugs collectors own and want most, and browse the shelves they chose to share",
        "robots": "index, follow",
    },
    {
        "page": "shelf", "out": "shelf/index.html", "path": "/shelf/", "nav": "shelf",
        "title": "My shelf | Mug",
        "description": "Your mugs: the ones you own, want and once had, with notes, and a public address when you want one",
        "robots": "noindex",
    },
    {
        "page": "profile", "out": "u/index.html", "path": "/u/", "nav": "community",
        "title": "A shelf | Mug",
        "description": "A collector's shared mug shelf",
        "robots": "noindex",
        "beacon_off": True,
    },
    {
        "page": "admin", "out": "admin/index.html", "path": "/admin/", "nav": "admin",
        "title": "Admin | Mug",
        "description": "Review imported listings, scan shop feeds and keep the catalog tidy",
        "robots": "noindex, nofollow",
        "css": ["/css/admin.css"],
        "beacon_off": True,
    },
    {
        "page": "bot", "out": "bot/index.html", "path": "/bot/", "nav": "",
        "title": "MugBot | Mug",
        "description": "What MugBot fetches, how it identifies itself, how it respects robots.txt, and how a shop can ask to be left out",
        "robots": "index, follow", "static": True,
    },
]

PLACEHOLDERS = [
    "TITLE", "DESCRIPTION", "CANONICAL", "ROBOTS", "CONVEX_URL", "EXTRA_CSS", "BEACON", "JSONLD", "PAGE",
    "NAV_CATALOG", "NAV_COMMUNITY", "NAV_SHELF", "NAV_ADMIN", "MAIN", "SCRIPTS",
]


def esc(text):
    return (text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;"))


def render(spec, template):
    main_file = MAIN_DIR / f"{spec['page']}.html"
    if not main_file.exists():
        raise SystemExit(f"pages.py: missing {main_file.relative_to(ROOT)}")
    values = {
        "TITLE": esc(spec["title"]),
        "DESCRIPTION": esc(spec["description"]),
        "CANONICAL": SITE + spec["path"],
        "ROBOTS": spec["robots"],
        "CONVEX_URL": CONVEX_URL,
        "EXTRA_CSS": "".join(f'  <link rel="stylesheet" href="{href}">\n' for href in spec.get("css", [])),
        "BEACON": '  <meta name="beacon" content="off">\n' if spec.get("beacon_off") else "",
        "JSONLD": JSONLD if spec.get("jsonld") else "",
        "PAGE": spec["page"],
        "MAIN": main_file.read_text().rstrip("\n"),
        "SCRIPTS": "" if spec.get("static") else APP,
    }
    for name in ("catalog", "community", "shelf", "admin"):
        values[f"NAV_{name.upper()}"] = ' aria-current="page"' if spec["nav"] == name else ""
    out = template
    for key in PLACEHOLDERS:
        token = "{{" + key + "}}"
        if token not in out:
            raise SystemExit(f"pages.py: the template lost {token}")
        out = out.replace(token, values[key])
    leftover = re.findall(r"\{\{[A-Z_]+\}\}", out)
    if leftover:
        raise SystemExit(f"pages.py: unknown placeholder(s) {sorted(set(leftover))} in {spec['out']}")
    if f'data-page="{spec["page"]}"' not in out:
        raise SystemExit(f"pages.py: {spec['out']} came out without its data-page")
    return out


def main():
    check = "--check" in sys.argv[1:]
    template = TEMPLATE.read_text()
    drift = []
    for spec in PAGES:
        target = ROOT / spec["out"]
        text = render(spec, template)
        if check:
            if not target.exists() or target.read_text() != text:
                drift.append(spec["out"])
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        print(f"  wrote {spec['out']}")
    if check:
        if drift:
            print("pages.py --check: out of date, run `make pages`:", ", ".join(drift))
            sys.exit(1)
        print(f"pages.py --check: {len(PAGES)} pages match the template")


if __name__ == "__main__":
    main()
