"use strict";
/* Landing: real classifier form, route animation, result ticket, batch mode and threshold board. */
(() => {
  const { t, queue, api, errorText, pct, num, esc, reduced } = window.ST;
  const $ = (sel, root = document) => root.querySelector(sel);
  const MIN_BODY = 10;
  const MAX_BATCH = 10;

  // Example tickets stay in English: the model was trained on English tickets.
  const EXAMPLES = {
    billing: ["Charged twice for my subscription", "This month I saw two identical charges on my card for the same subscription. Please refund the duplicate payment."],
    vpn: ["VPN down for the whole office", "Since this morning nobody in the office can connect to the corporate VPN. The client times out during authentication and remote staff cannot reach internal systems."],
    refund: ["Refund for my last order", "I would like a refund for my last purchase. The product did not meet our expectations and we already sent it back within the return period."],
  };
  const BATCH_SAMPLE = [
    "Invoice missing | I did not receive the invoice for October, please send it again.",
    "VPN down | Nobody in the office can connect to the VPN since this morning.",
    "Return label | I requested a return but never got the shipping label by email.",
    "Enterprise plan | Does the enterprise plan include SSO? We are 200 people.",
  ].join("\n");

  const stage = $(".stage");
  const form = $("#composer");
  const subject = $("#subject");
  const body = $("#body");
  const bodyError = $("#body-error");
  const counter = $("#counter");
  const codeEl = $("#composer-code");
  const bubbleText = $("#bubble-text");
  const bubbleMs = $("#bubble-ms");
  const stubs = $("#stubs");
  let showcase = [];
  let last = null; // last live result, re-rendered on language change

  /* ---------- helpers ---------- */
  const typeLabel = (x) => t(`type.${x}`);
  const prioLabel = (x) => t(`priority.${x}`);
  const wide = () => window.matchMedia("(min-width: 1180px)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- result tickets ---------- */
  function renderStub(p, { code, subjectText, enter = false }) {
    const node = $("#tpl-stub").content.firstElementChild.cloneNode(true);
    window.ST.apply(node);
    const review = p.needs_review;
    node.classList.toggle("review", review);
    $(".stub-code", node).textContent = code ? `#${code}` : t("stub.example");
    $(".stub-when", node).textContent = `${queue(p.queue.label)} · ${t("stub.took", { ms: num(p.latency_ms, 1) })}`;
    $(".stub-subject", node).textContent = subjectText || t("stub.noSubject");
    $(".stub-for", node).textContent = review ? t("stub.maybeFor") : t("stub.goesTo");
    $(".stub-queue", node).textContent = queue(p.queue.label);
    for (const k of ["type", "queue", "priority"]) {
      $(`[data-k="${k}"]`, node).textContent = pct(p[k].confidence);
      $(`[data-v="${k}"]`, node).textContent = k === "type" ? typeLabel(p.type.label) : k === "priority" ? prioLabel(p.priority.label) : queue(p.queue.label);
    }
    const words = $(".stub-words", node);
    if (p.top_words && p.top_words.length) {
      p.top_words.forEach((w) => { const s = document.createElement("span"); s.className = "word"; s.textContent = w.word; words.append(s); });
    } else {
      words.remove();
    }
    const bars = $(".stub-bars", node);
    p.queue_top3.forEach((q) => {
      const li = document.createElement("li");
      li.innerHTML = `<span></span><span class="bar"><span></span></span><span class="pct"></span>`;
      li.children[0].textContent = queue(q.label);
      li.children[2].textContent = pct(q.confidence);
      li.querySelector(".bar span").dataset.w = String(Math.max(1, q.confidence * 100));
      bars.append(li);
    });
    $(".stub-conf", node).textContent = num(p.queue.confidence, 2);
    $(".meter-fill", node).dataset.w = String(p.queue.confidence * 100);
    $(".meter-mark", node).style.left = `calc(${p.threshold * 100}% - 1px)`;
    $(".stub-thr", node).textContent = t("stub.threshold", { v: num(p.threshold, 2) });
    $(".stamp", node).textContent = review ? t("stamp.review") : t("stamp.auto");
    if (enter && !reduced()) node.classList.add("enter");
    return node;
  }

  function renderMini(p, { code, subjectText }) {
    const node = $("#tpl-mini").content.firstElementChild.cloneNode(true);
    const review = p.needs_review;
    node.classList.toggle("review", review);
    $(".stub-code", node).textContent = code ? `#${code}` : t("stub.example");
    $(".stub-subject", node).textContent = subjectText;
    $(".stub-maybe", node).textContent = review ? t("stub.maybe", { area: queue(p.queue.label) }) : t("stub.sentTo", { area: queue(p.queue.label) });
    $(".stub-why", node).textContent = review
      ? t("stub.below", { v: num(p.queue.confidence, 2), thr: num(p.threshold, 2) })
      : t("stub.above", { v: num(p.queue.confidence, 2), thr: num(p.threshold, 2) });
    $(".stub-conf", node).textContent = num(p.queue.confidence, 2);
    $(".stamp", node).textContent = review ? t("stamp.review") : t("stamp.auto");
    return node;
  }

  function fillBars(root) {
    const go = () => root.querySelectorAll("[data-w]").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
    if (reduced()) go(); else requestAnimationFrame(() => requestAnimationFrame(go));
  }

  function renderResults() {
    const live = $("#result-live");
    stubs.replaceChildren(live);
    if (last && last.batch) {
      stubs.prepend(renderBatch(last.batch));
      return;
    }
    const first = last ? renderStub(last.p, { code: last.code, subjectText: last.subject, enter: last.fresh }) : showcase[0] && renderStub(showcase[0], { subjectText: showcase[0].subject });
    const second = showcase[1] && renderMini(showcase[1], { subjectText: showcase[1].subject });
    if (first) stubs.prepend(first);
    if (second) stubs.append(second);
    fillBars(stubs);
    if (last) last.fresh = false;
  }

  function renderBatch(items) {
    const box = document.createElement("div");
    box.className = "batch-list";
    const rows = items.map((it) => `
      <tr><td>${esc(it.code)}</td><td>${esc(it.subject || t("stub.noSubject"))}</td>
      <td>${esc(queue(it.prediction.queue.label))}</td><td class="mono">${esc(pct(it.prediction.queue.confidence))}</td>
      <td><span class="status status-${it.status}">${esc(it.status === "revision" ? t("stamp.review") : t("stamp.auto"))}</span></td></tr>`).join("");
    box.innerHTML = `<h3></h3><table><thead><tr><th>${esc(t("batch.colId"))}</th><th>${esc(t("batch.colSubject"))}</th><th>${esc(t("batch.colArea"))}</th><th>${esc(t("batch.colConf"))}</th><th>${esc(t("batch.colStatus"))}</th></tr></thead><tbody>${rows}</tbody></table>`;
    const sent = items.filter((i) => i.status === "enviado").length;
    box.querySelector("h3").textContent = t("batch.summary", { n: items.length, auto: sent, review: items.length - sent });
    return box;
  }

  /* ---------- route lines between the form and the agents ---------- */
  const SVGNS = "http://www.w3.org/2000/svg";
  let routes = {};

  function geometry() {
    const W = form.offsetWidth, H = form.offsetHeight;
    const perf = $(".perf", form);
    const perfY = perf && perf.offsetParent ? form.offsetTop + perf.offsetTop : H * 0.45;
    const out = {};
    stage.querySelectorAll(".agent").forEach((fig) => {
      const img = $("img", fig);
      const x = fig.offsetLeft + img.offsetLeft, y = fig.offsetTop + img.offsetTop;
      const w = img.offsetWidth, h = img.offsetHeight, cy = y + h / 2;
      const name = fig.dataset.agent;
      const left = x + w / 2 < W / 2;
      const ys = { ana: perfY, marta: H * 0.8, luis: H * 0.24, diego: H * 0.78 }[name];
      if (left) {
        const xr = x + w, xm = Math.round(xr / 2);
        out[name] = { d: `M 0 ${ys} H ${xm} V ${cy} H ${xr}`, node: [xm, (ys + cy) / 2] };
      } else {
        const xm = Math.round((W + x) / 2);
        out[name] = { d: `M ${W} ${ys} H ${xm} V ${cy} H ${x}`, node: [xm, (ys + cy) / 2] };
      }
    });
    const desk = $(".desk");
    const dx = desk.offsetLeft, dy = desk.offsetTop;
    out.desk = { d: `M ${Math.round(W * 0.22)} ${H} V ${dy + 150} H ${dx + 18}` };
    return out;
  }

  function drawRoutes(animate) {
    const svg = $(".routes");
    if (!wide()) { svg.replaceChildren(); routes = {}; return; }
    routes = geometry();
    const defs = document.createElementNS(SVGNS, "defs");
    const lines = [];
    Object.entries(routes).forEach(([name, r]) => {
      const mask = document.createElementNS(SVGNS, "mask");
      mask.id = `m-${name}`;
      mask.setAttribute("maskUnits", "userSpaceOnUse");
      mask.setAttribute("x", "-2000"); mask.setAttribute("y", "-2000");
      mask.setAttribute("width", "4000"); mask.setAttribute("height", "4000");
      const mp = document.createElementNS(SVGNS, "path");
      mp.setAttribute("d", r.d);
      mp.setAttribute("pathLength", "1");
      mp.setAttribute("class", "route-mask");
      if (!animate || reduced()) mp.style.strokeDashoffset = "0";
      mask.append(mp);
      defs.append(mask);
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", r.d);
      p.setAttribute("class", "route-line");
      p.setAttribute("mask", `url(#m-${name})`);
      p.id = `route-${name}`;
      lines.push(p);
      if (r.node) {
        const n = $(`.node-${name}`);
        if (n) { n.style.left = `${r.node[0] - 16}px`; n.style.top = `${r.node[1] - 16}px`; }
      }
    });
    svg.replaceChildren(defs, ...lines);
    if (animate && !reduced()) requestAnimationFrame(() => svg.classList.add("drawn"));
  }

  function travel(name, review) {
    const path = document.getElementById(`route-${name}`);
    if (!path || reduced()) return Promise.resolve();
    const len = path.getTotalLength();
    const frames = [];
    for (let i = 0; i <= 24; i += 1) {
      const pt = path.getPointAtLength((len * i) / 24);
      frames.push({ transform: `translate(${pt.x}px, ${pt.y}px)` });
    }
    const mini = document.createElement("span");
    mini.className = `mini-ticket${review ? " review" : ""}`;
    mini.setAttribute("aria-hidden", "true");
    stage.append(mini);
    const anim = mini.animate(frames, { duration: 800, easing: "ease-in-out", fill: "forwards" });
    return anim.finished.then(() => wait(120)).then(() => mini.remove());
  }

  function agentFor(label) {
    return [...stage.querySelectorAll(".agent")].find((f) => f.dataset.queues.split("|").includes(label));
  }

  async function typeBubble(text, ms) {
    bubbleMs.textContent = ms == null ? "" : `${num(ms, 1)} ms`;
    if (reduced()) { bubbleText.textContent = text; return; }
    bubbleText.classList.add("typing");
    bubbleText.textContent = "";
    const step = Math.max(8, 900 / text.length);
    for (let i = 1; i <= text.length; i += 1) {
      bubbleText.textContent = text.slice(0, i);
      await wait(step);
    }
    bubbleText.classList.remove("typing");
  }

  /* ---------- single ticket ---------- */
  function updateCounter() { counter.textContent = `${body.value.length} / 5000`; }

  function setError(msg) {
    bodyError.textContent = msg || "";
    body.setAttribute("aria-invalid", msg ? "true" : "false");
  }

  async function submitOne(e) {
    e.preventDefault();
    const text = body.value.trim();
    if (text.length < MIN_BODY) { setError(t("err.bodyShort")); body.focus(); return; }
    setError("");
    const btn = $("#send");
    btn.disabled = true;
    const res = await api("/tickets", { method: "POST", body: { subject: subject.value.trim(), body: text } });
    btn.disabled = false;
    if (!res.ok) { setError(errorText(res)); return; }
    const { code, prediction: p } = res.data;
    codeEl.textContent = `#${code}`;
    last = { p, code, subject: subject.value.trim(), fresh: true };

    const review = p.needs_review;
    const agent = review ? null : agentFor(p.queue.label);
    const routeName = review ? "desk" : agent && agent.dataset.agent;
    stage.querySelectorAll(".agent.hit").forEach((a) => a.classList.remove("hit"));
    const msg = review
      ? t("bubble.review", { v: pct(p.queue.confidence), area: queue(p.queue.label) })
      : t("bubble.auto", { v: pct(p.queue.confidence), area: queue(p.queue.label) });
    if (wide() && routeName) {
      await travel(routeName, review);
    }
    if (agent) agent.classList.add("hit");
    await typeBubble(msg, p.latency_ms);
    renderResults();
    $("#result-live").textContent = msg;
    const target = stubs.querySelector(".stub");
    if (target) {
      await wait(reduced() ? 0 : 250);
      $("#resultado").scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
      target.focus({ preventScroll: true });
    }
  }

  /* ---------- batch ---------- */
  function parseBatch(raw) {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error("json");
      return arr.map((x) => (typeof x === "string" ? { subject: "", body: x } : { subject: String(x.subject || ""), body: String(x.body || "") }));
    }
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf("|");
      return i === -1 ? { subject: "", body: l } : { subject: l.slice(0, i).trim(), body: l.slice(i + 1).trim() };
    });
  }

  async function submitBatch() {
    const box = $("#batch");
    const err = $("#batch-error");
    let items;
    try { items = parseBatch(box.value); } catch (e) { err.textContent = t("err.batchJson"); return; }
    if (!items.length) { err.textContent = t("err.batchEmpty"); return; }
    if (items.length > MAX_BATCH) { err.textContent = t("err.batchMax", { n: MAX_BATCH }); return; }
    const bad = items.findIndex((i) => i.body.length < MIN_BODY);
    if (bad !== -1) { err.textContent = t("err.batchLine", { n: bad + 1 }); return; }
    err.textContent = "";
    const btn = $("#batch-send");
    btn.disabled = true;
    const res = await api("/tickets/batch", { method: "POST", body: { tickets: items } });
    btn.disabled = false;
    if (!res.ok) { err.textContent = errorText(res); return; }
    last = { batch: res.data.map((r, i) => ({ ...r, subject: items[i].subject })) };
    renderResults();
    $("#result-live").textContent = stubs.querySelector(".batch-list h3").textContent;
    $("#resultado").scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
  }

  function setMode(batch) {
    $("#tab-one").setAttribute("aria-selected", String(!batch));
    $("#tab-batch").setAttribute("aria-selected", String(batch));
    $("#tab-one").tabIndex = batch ? -1 : 0;
    $("#tab-batch").tabIndex = batch ? 0 : -1;
    $("#mode-one").hidden = batch;
    $("#mode-batch").hidden = !batch;
    requestAnimationFrame(() => drawRoutes(false));
  }

  /* ---------- split-flap board ---------- */
  function flaps(text, highlight) {
    return `<span class="flaps" aria-hidden="true">${[...text].map((c) => `<span class="flap" data-c="${esc(c)}">${c === " " ? "" : esc(c)}</span>`).join("")}</span><span class="sr-only">${esc(text.trim())}</span>`;
  }
  const pad2 = (n) => String(n).padStart(2, " ");
  function renderBoard(flip) {
    const el = $("#board");
    let data;
    try { data = JSON.parse(el.dataset.board); } catch (e) { return; }
    const tbody = $("#board-rows");
    tbody.innerHTML = data.rows.map((r) => {
      const now = Math.abs(r.threshold - data.threshold) < 0.001;
      const cov = Math.round(r.coverage * 100), acc = r.accuracy == null ? 0 : Math.round(r.accuracy * 100);
      return `<tr class="${now ? "now" : ""}"><td>${flaps(num(r.threshold, 2))}</td><td>${flaps(`${pad2(cov)} %`)}</td><td>${flaps(`${pad2(acc)} %`)}</td></tr>`;
    }).join("");
    if (flip && !reduced()) {
      tbody.querySelectorAll(".flap").forEach((f, i) => { f.style.animationDelay = `${(i % 12) * 35 + Math.floor(i / 12) * 90}ms`; f.classList.add("flip"); });
    }
  }

  /* ---------- init ---------- */
  async function init() {
    await window.ST.ready;
    try { showcase = JSON.parse(stubs.dataset.showcase || "[]"); } catch (e) { showcase = []; }
    renderResults();
    renderBoard(false);

    form.addEventListener("submit", submitOne);
    body.addEventListener("input", () => { updateCounter(); if (bodyError.textContent) setError(""); });
    form.querySelectorAll("[data-example]").forEach((b) => b.addEventListener("click", () => {
      const [s, m] = EXAMPLES[b.dataset.example];
      subject.value = s; body.value = m; updateCounter(); setError(""); body.focus();
    }));
    $("#tab-one").addEventListener("click", () => setMode(false));
    $("#tab-batch").addEventListener("click", () => setMode(true));
    $(".mode-tabs").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const batch = $("#tab-one").getAttribute("aria-selected") === "true";
      setMode(batch);
      (batch ? $("#tab-batch") : $("#tab-one")).focus();
    });
    $("#batch").addEventListener("input", () => {
      const n = $("#batch").value.split(/\r?\n/).filter((l) => l.trim()).length;
      $("#batch-counter").textContent = `${n} / ${MAX_BATCH}`;
    });
    $("#batch-sample").addEventListener("click", () => { $("#batch").value = BATCH_SAMPLE; $("#batch").dispatchEvent(new Event("input")); });
    $("#batch-send").addEventListener("click", submitBatch);
    if (location.hash === "#lote") setMode(true);
    window.addEventListener("hashchange", () => { if (location.hash === "#lote") { setMode(true); $("#batch").focus(); } });

    const draw = () => drawRoutes(false);
    drawRoutes(true);
    if (document.fonts) document.fonts.ready.then(draw);
    let raf = 0;
    window.addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });

    const board = $("#board");
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { renderBoard(true); io.disconnect(); } }, { threshold: 0.4 });
      io.observe(board);
    }

    document.addEventListener("langchange", () => {
      renderResults();
      renderBoard(false);
      if (!last) bubbleText.textContent = t("bubble.idle");
      requestAnimationFrame(draw);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
