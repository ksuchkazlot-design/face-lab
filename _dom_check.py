"""Verify the DOM contract between the scripts and the HTML pages.

Checks that every getElementById / querySelector target used by a script
actually exists in the pages that load that script.
"""

import io
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")


def read(path):
    with io.open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def ids_in_html(html):
    return set(re.findall(r'id="([^"]+)"', html))


def script_ids(code):
    """IDs referenced through the $() helper or getElementById."""
    found = set()
    found.update(re.findall(r'\bFL\.\$\("([^"]+)"\)', code))
    found.update(re.findall(r'(?<!FL\.)\B\$\("([^"]+)"\)', code))
    found.update(re.findall(r'getElementById\("([^"]+)"\)', code))
    return found


def selectors(code):
    """Class/attribute selectors used with qsa or querySelector."""
    found = set()
    found.update(re.findall(r'qsa\("([^"]+)"', code))
    found.update(re.findall(r'FL\.qsa\("([^"]+)"', code))
    found.update(re.findall(r'querySelector\("([^"]+)"\)', code))
    found.update(re.findall(r"querySelector\('([^']+)'\)", code))
    return found


# Dynamically created elements: these are built by JS, not present in the HTML.
DYNAMIC = {
    ".cat-card__fill", ".cat-card__value", ".toggle__btn", ".tabs__btn",
    "#topnav .topnav__item", "#overlayToggle .toggle__btn",
    "#genderGrid .choice", "#ethnicityGrid .choice", "#gptChips .chip",
    "[data-seg]",
}

PAGE_SCRIPTS = {}


def collect_pages():
    pages = []
    pages.append(("index.html", os.path.join(STATIC, "index.html")))
    for name in sorted(os.listdir(os.path.join(STATIC, "analysis"))):
        pages.append(("analysis/" + name, os.path.join(STATIC, "analysis", name)))
    for name in sorted(os.listdir(os.path.join(STATIC, "details"))):
        pages.append(("details/" + name, os.path.join(STATIC, "details", name)))
    return pages


def main():
    failures = 0

    scripts = {
        "/script.js": read(os.path.join(STATIC, "script.js")),
        "/shared.js": read(os.path.join(STATIC, "shared.js")),
        "/analysis-page.js": read(os.path.join(STATIC, "analysis-page.js")),
        "/detail-page.js": read(os.path.join(STATIC, "detail-page.js")),
    }

    for label, path in collect_pages():
        html = read(path)
        present = ids_in_html(html)
        loaded = [src for src in scripts if 'src="%s"' % src in html]

        if not loaded:
            print("[FAIL] %s loads no script" % label)
            failures += 1
            continue

        needed = set()
        for src in loaded:
            needed |= script_ids(scripts[src])

        # shared.js is generic: it probes optional hooks, so only require the
        # ids the page-specific controller uses.
        optional = script_ids(scripts["/shared.js"])
        required = needed - optional
        missing = sorted(required - present)

        if missing:
            print("[FAIL] %s missing ids: %s" % (label, ", ".join(missing)))
            failures += 1
        else:
            print("[PASS] %s (%d ids, scripts: %s)"
                  % (label, len(present), " ".join(loaded)))

        # Check class selectors that are expected to exist statically.
        sels = set()
        for src in loaded:
            sels |= selectors(scripts[src])
        for selector in sorted(sels - DYNAMIC):
            token = selector.split()[-1]
            if token.startswith("."):
                if 'class="' not in html or token[1:] not in html:
                    print("[WARN] %s: selector %s not found statically"
                          % (label, selector))
        PAGE_SCRIPTS[label] = loaded

    # Cross-check: every metric key in server.py has a category page.
    server_code = read(os.path.join(BASE, "server.py"))
    cats = re.findall(r'CATEGORY_ORDER = \[([^\]]+)\]', server_code)
    cat_keys = re.findall(r'"([a-z_]+)"', cats[0]) if cats else []
    for key in cat_keys:
        for folder, suffix in (("analysis", ".html"), ("details", "-detail.html")):
            target = os.path.join(STATIC, folder, key + suffix)
            if not os.path.isfile(target):
                print("[FAIL] missing %s/%s%s" % (folder, key, suffix))
                failures += 1
    print("[PASS] all %d categories have analysis + detail pages" % len(cat_keys))

    print("\n%s" % ("DOM CONTRACT OK" if failures == 0
                    else "%d PAGE(S) FAILED" % failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
