"use strict";
/* Shared helpers: translations, language menu, CSRF-aware fetch, scroll reveal, mobile nav. */
(() => {
  const LANG_ATTR = { es: "es", en: "en", pt: "pt", zh: "zh-Hans", fr: "fr", ja: "ja" };
  // locale used for numbers and dates (Mexican Spanish writes 0.97, not 0,97)
  const NUM_LOCALE = { es: "es-MX", en: "en-US", pt: "pt-BR", zh: "zh-CN", fr: "fr-FR", ja: "ja-JP" };
  const CODES = Object.keys(LANG_ATTR);
  const fromAttr = (v) => CODES.find((c) => LANG_ATTR[c] === v) || "es";

  let lang = fromAttr(document.documentElement.lang);
  let dict = {};
  const cache = {};

  function load(code) {
    if (!cache[code]) {
      cache[code] = fetch(`/static/i18n/${code}.json`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return cache[code];
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function rich(s) {
    return esc(s).replace(/\[\[(.+?)\]\]/g, '<span class="mark">$1</span>').replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function t(key, vars) {
    let s = dict[key];
    if (s === undefined) s = key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(dict, key);
  const queue = (label) => (has(`queue.${label}`) ? t(`queue.${label}`) : label);

  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => { if (has(el.dataset.i18n)) el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => { if (has(el.dataset.i18nHtml)) el.innerHTML = rich(t(el.dataset.i18nHtml)); });
    root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.dataset.i18nAttr.split(";").forEach((pair) => {
        const [name, key] = pair.split(":").map((x) => x.trim());
        if (name && has(key)) el.setAttribute(name, t(key));
      });
    });
  }

  function storeChoice(code) {
    document.cookie = `st_lang=${code}; path=/; max-age=31536000; samesite=lax`;
    try { localStorage.setItem("st_lang", code); } catch (e) { /* storage may be blocked */ }
  }

  async function setLang(code, { persist = true } = {}) {
    if (!LANG_ATTR[code]) return;
    if (persist) storeChoice(code);
    dict = await load(code);
    lang = code;
    document.documentElement.lang = LANG_ATTR[code];
    apply();
    syncMenus();
    document.dispatchEvent(new CustomEvent("langchange", { detail: { lang: code } }));
  }

  /* ----- language menus (there can be several per page: nav, footer, login) ----- */
  function syncMenus() {
    document.querySelectorAll(".lang-menu [data-lang]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.lang === lang)));
  }
  function closeAll(except) {
    document.querySelectorAll(".lang").forEach((box) => {
      if (box === except) return;
      box.querySelector(".lang-menu").hidden = true;
      box.querySelector(".lang-btn").setAttribute("aria-expanded", "false");
    });
  }
  function initMenus() {
    document.querySelectorAll(".lang").forEach((box) => {
      const btn = box.querySelector(".lang-btn");
      const menu = box.querySelector(".lang-menu");
      const items = () => [...menu.querySelectorAll("button")];
      btn.addEventListener("click", () => {
        const open = menu.hidden;
        closeAll(box);
        menu.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
        if (open) {
          const rect = btn.getBoundingClientRect();
          menu.classList.toggle("up", window.innerHeight - rect.bottom < 360 && rect.top > 360);
          (items().find((b) => b.getAttribute("aria-checked") === "true") || items()[0]).focus();
        }
      });
      menu.addEventListener("click", (e) => {
        const b = e.target.closest("[data-lang]");
        if (!b) return;
        closeAll();
        btn.focus();
        setLang(b.dataset.lang);
      });
      menu.addEventListener("keydown", (e) => {
        const list = items();
        const i = list.indexOf(document.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
        else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
        else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
        else if (e.key === "Escape" || e.key === "Tab") { closeAll(); if (e.key === "Escape") btn.focus(); }
      });
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".lang")) closeAll(); });
    syncMenus();
  }

  /* ----- fetch with CSRF header ----- */
  function csrf() {
    const m = document.querySelector('meta[name="session-csrf"]') || document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : "";
  }
  async function api(url, { method = "GET", body } = {}) {
    const opts = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["X-CSRF-Token"] = csrf();
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try { res = await fetch(url, opts); } catch (e) { return { ok: false, status: 0, data: { detail: "network" } }; }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data };
  }
  function errorText(res) {
    const d = res && res.data && res.data.detail;
    if (res.status === 0) return t("err.network");
    if (typeof d === "string" && has(`err.${d}`)) return t(`err.${d}`);
    if (res.status === 429) return t("err.rate_limited");
    if (res.status === 422) return t("err.validation");
    if (res.status === 503) return t("err.model");
    return t("err.generic");
  }

  /* ----- formatting ----- */
  const pct = (x, digits = 0) => new Intl.NumberFormat(NUM_LOCALE[lang], { style: "percent", maximumFractionDigits: digits }).format(x);
  const num = (x, digits = 2) => new Intl.NumberFormat(NUM_LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
  function ago(iso) {
    const sec = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(NUM_LOCALE[lang], { numeric: "auto", style: "short" });
    const abs = Math.abs(sec);
    if (abs < 60) return rtf.format(0, "second");
    if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
    return rtf.format(Math.round(sec / 86400), "day");
  }
  function date(iso) {
    return new Intl.DateTimeFormat(NUM_LOCALE[lang], { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  }
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----- page chrome ----- */
  function initReveal() {
    const els = [...document.querySelectorAll(".reveal")];
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; };
    els.forEach((el) => { if (inView(el)) el.classList.add("seen"); });
    document.documentElement.classList.add("js");
    if (!("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("seen")); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const siblings = [...en.target.parentElement.children].filter((c) => c.classList.contains("reveal"));
        en.target.style.transitionDelay = `${Math.max(0, siblings.indexOf(en.target)) * 70}ms`;
        en.target.classList.add("seen");
        io.unobserve(en.target);
      });
    }, { threshold: 0.15 });
    els.forEach((el) => { if (!el.classList.contains("seen")) io.observe(el); });
  }
  function initNav() {
    const nav = document.querySelector(".nav");
    const toggle = document.querySelector(".nav-toggle");
    if (nav && toggle) {
      toggle.addEventListener("click", () => {
        const open = !nav.classList.contains("open");
        nav.classList.toggle("open", open);
        toggle.setAttribute("aria-expanded", String(open));
      });
      nav.querySelectorAll(".nav-links a").forEach((a) => a.addEventListener("click", () => { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }));
    }
    document.querySelectorAll("[data-focus]").forEach((a) => a.addEventListener("click", () => {
      const target = document.getElementById(a.dataset.focus);
      if (target) setTimeout(() => target.focus({ preventScroll: true }), reduced() ? 0 : 450);
    }));
  }

  const ready = (async () => {
    let stored = null;
    try { stored = localStorage.getItem("st_lang"); } catch (e) { /* ignore */ }
    dict = await load(lang);
    const fromUrl = new URLSearchParams(location.search).get("lang");
    if (fromUrl && LANG_ATTR[fromUrl] === document.documentElement.lang) {
      storeChoice(lang); // an explicit ?lang= link wins over an older saved choice
    } else if (stored && stored !== lang && LANG_ATTR[stored]) {
      // cookie was cleared but the browser remembers the choice: restore it
      await setLang(stored);
    }
  })();

  document.addEventListener("DOMContentLoaded", () => { initMenus(); initReveal(); initNav(); });

  window.ST = { t, has, queue, apply, setLang, api, errorText, pct, num, ago, date, esc, rich, reduced, ready, get lang() { return lang; } };
})();
