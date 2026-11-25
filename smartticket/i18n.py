"""Server-side page rendering: partial includes and translation of ``data-i18n`` markers.

Pages are rendered in the visitor's language before they leave the server, so there is no flash of
Spanish text for someone who picked another language. ``static/js/i18n.js`` uses the same locale
files to switch languages live without a reload.
"""
from __future__ import annotations

import html
import json
import re
from functools import lru_cache
from pathlib import Path

STATIC_DIR = Path(__file__).parent / "static"
LOCALE_DIR = STATIC_DIR / "i18n"
PAGES_DIR = STATIC_DIR / "pages"

DEFAULT_LANG = "es"
# code -> value for <html lang>
LANGS = {"es": "es", "en": "en", "pt": "pt", "zh": "zh-Hans", "fr": "fr", "ja": "ja"}

_INCLUDE = re.compile(r"<!--\s*@include\s+([\w-]+)\s*-->")
_TEXT = re.compile(r'(<(\w+)\b[^>]*?\sdata-i18n(-html)?="([^"]+)"[^>]*>)([^<]*)(</\2>)')
_ATTRS = re.compile(r'<[a-zA-Z][^>]*?\sdata-i18n-attr="([^"]+)"[^>]*>')
_HTML_LANG = re.compile(r'<html lang="[^"]*"')
# set by the app in dev so edits to templates and locale files show up without a restart
live_reload = False
_MARKUP = [(re.compile(r"\[\[(.+?)\]\]"), r'<span class="mark">\1</span>'),
           (re.compile(r"\*\*(.+?)\*\*"), r"<strong>\1</strong>")]


def normalize_lang(value: str | None) -> str:
    value = (value or "").strip().lower()[:8]
    if value in LANGS:
        return value
    base = value.split("-")[0]
    return base if base in LANGS else DEFAULT_LANG


@lru_cache(maxsize=None)
def locale(lang: str) -> dict[str, str]:
    return json.loads((LOCALE_DIR / f"{lang}.json").read_text(encoding="utf-8"))


def t(lang: str, key: str) -> str:
    return locale(lang).get(key) or locale(DEFAULT_LANG).get(key, key)


def rich(text: str) -> str:
    """Escape, then allow the two tiny markup forms used in locale strings."""
    out = html.escape(text, quote=False)
    for rx, repl in _MARKUP:
        out = rx.sub(repl, out)
    return out


def _translate(page: str, lang: str) -> str:
    def text(m: re.Match) -> str:
        start, _tag, is_html, key, _old, end = m.groups()
        value = t(lang, key)
        return start + (rich(value) if is_html else html.escape(value, quote=False)) + end

    def attrs(m: re.Match) -> str:
        tag = m.group(0)
        for pair in m.group(1).split(";"):
            name, _, key = pair.partition(":")
            value = html.escape(t(lang, key.strip()), quote=True)
            tag = re.sub(rf'(\s{re.escape(name.strip())}=")[^"]*(")', lambda mm: mm.group(1) + value + mm.group(2), tag,
                         count=1)
        return tag

    page = _TEXT.sub(text, page)
    page = _ATTRS.sub(attrs, page)
    return _HTML_LANG.sub(f'<html lang="{LANGS[lang]}"', page, count=1)


@lru_cache(maxsize=None)
def _template(name: str) -> str:
    page = (PAGES_DIR / f"{name}.html").read_text(encoding="utf-8")
    for _ in range(3):  # partials may include partials
        page = _INCLUDE.sub(lambda m: (PAGES_DIR / "partials" / f"{m.group(1)}.html").read_text(encoding="utf-8"), page)
    return page


@lru_cache(maxsize=None)
def _translated(name: str, lang: str) -> str:
    return _translate(_template(name), lang)


def render(name: str, lang: str, values: dict[str, str] | None = None) -> str:
    """Render page ``name`` in ``lang``; ``{{key}}`` placeholders are filled with escaped ``values``."""
    if live_reload:
        clear_cache()
    page = _translated(name, lang)
    for key, value in (values or {}).items():
        page = page.replace("{{" + key + "}}", html.escape(str(value), quote=True))
    return page


def clear_cache() -> None:
    locale.cache_clear()
    _template.cache_clear()
    _translated.cache_clear()
