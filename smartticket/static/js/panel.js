"use strict";
/* Staff panel: review inbox, sent / all tickets, threshold, team, contact messages, password. */
(() => {
  const ST = window.ST;
  const { t, queue, api, errorText, pct, num, esc, ago, date, reduced } = ST;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const main = $("#main");
  const section = document.body.dataset.section || "revision";
  const state = { me: null, items: [], selected: null, filter: "todos", q: "", detail: null };

  const typeLabel = (x) => t(`type.${x}`);
  const prioLabel = (x) => t(`priority.${x}`);
  const sourceLabel = (x) => (ST.has(`source.${x}`) ? t(`source.${x}`) : x);
  const h = (html) => { const d = document.createElement("template"); d.innerHTML = html.trim(); return d.content.firstElementChild; };
  const tag = (text, n) => `<span class="tag"><span class="tag-text">${esc(text)}</span>${n == null ? "" : `<span class="tag-num">${esc(n)}</span>`}</span>`;

  function toast(msg, kind = "ok") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = `toast toast-${kind}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  /* ---------- chrome ---------- */
  function renderChrome() {
    const { user, counts } = state.me;
    $("#user-name").textContent = user.name;
    $("#user-role").textContent = [user.area ? queue(user.area) : null, t(`role.${user.role}`)].filter(Boolean).join(" · ");
    $("#avatar").textContent = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
    $(".admin-only").hidden = user.role !== "admin";
    $$(".side-nav a, .side-actions a").forEach((a) => {
      if (a.dataset.sec === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const setCount = (k, v) => $$(`[data-count="${k}"]`).forEach((el) => { el.textContent = v ? String(v) : ""; el.hidden = !v; });
    setCount("revision", counts.revision);
    setCount("enviado", counts.enviado);
    setCount("unread", state.me.unread_messages || 0);
    document.body.classList.toggle("locked", user.must_change_password);
  }

  function initChrome() {
    $("#logout").addEventListener("click", async () => {
      const res = await api("/api/auth/logout", { method: "POST" });
      window.location.assign(res.ok ? res.data.redirect : "/login");
    });
    const side = $("#side");
    const btn = $("#menu-btn");
    const close = () => { side.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", () => { side.classList.add("open"); btn.setAttribute("aria-expanded", "true"); $("#side-close").focus(); });
    $("#side-close").addEventListener("click", () => { close(); btn.focus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && side.classList.contains("open")) { close(); btn.focus(); } });
  }

  /* ---------- ticket lists ---------- */
  const VIEW = { revision: "revision", enviados: "enviados", todos: "todos" };

  function listHeader() {
    const c = state.me.counts;
    const conf = {
      revision: [t("panel.tagReview"), c.revision, t("panel.titleReview"), t("panel.subReview", { n: c.revision })],
      enviados: [t("panel.tagSent"), c.enviado, t("panel.titleSent"), t("panel.subSent", { thr: num(state.me.threshold, 2) })],
      todos: [t("panel.tagAll"), c.total, t("panel.titleAll"), t("panel.subAll")],
    }[section];
    return conf;
  }

  function renderListPage() {
    const [tagText, n, title, sub] = listHeader();
    main.replaceChildren(h(`
      <div class="page">
        <header class="page-head">
          <div>
            ${tag(tagText, n)}
            <h1 class="display page-title">${esc(title)}</h1>
            <p class="page-sub">${esc(sub)}</p>
          </div>
          <label class="search">
            <svg aria-hidden="true"><use href="#i-search"/></svg>
            <span class="sr-only">${esc(t("panel.search"))}</span>
            <input type="search" id="q" placeholder="${esc(t("panel.searchPh"))}" autocomplete="off" value="${esc(state.q)}">
            <kbd>/</kbd>
          </label>
        </header>
        <div class="inbox">
          <section class="list-col" aria-label="${esc(t("panel.listLabel"))}">
            <div class="list-tools">
              <div class="seg" role="radiogroup" aria-label="${esc(t("panel.filter"))}">
                <button type="button" role="radio" data-f="todos">${esc(t("panel.fAll"))} <b data-fc="todos"></b></button>
                <button type="button" role="radio" data-f="urgentes">${esc(t("panel.fUrgent"))} <b data-fc="urgentes"></b></button>
                <button type="button" role="radio" data-f="antiguos">${esc(t("panel.fOldest"))}</button>
              </div>
              <span class="range mono" id="range"></span>
            </div>
            <ul class="tlist" id="tlist" role="listbox" aria-label="${esc(t("panel.listLabel"))}"></ul>
          </section>
          <section class="detail" id="detail" aria-live="polite"></section>
        </div>
      </div>`));
    $$(".seg [data-f]").forEach((b) => b.addEventListener("click", () => { state.filter = b.dataset.f; loadList(); }));
    let timer = 0;
    $("#q").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; loadList(); }, 200); });
    loadList();
  }

  async function loadList(keepId) {
    const params = new URLSearchParams({ view: VIEW[section], filter: state.filter, q: state.q });
    const res = await api(`/api/panel/tickets?${params}`);
    if (!res.ok) return handleError(res);
    state.items = res.data.items;
    state.me.counts = res.data.counts;
    renderChrome();
    $$(".seg [data-f]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.f === state.filter)));
    const fc = { todos: section === "revision" ? res.data.counts.revision : state.items.length, urgentes: section === "revision" ? res.data.counts.urgentes : null };
    $$("[data-fc]").forEach((b) => { const v = fc[b.dataset.fc]; b.textContent = v == null ? "" : String(v); });
    const want = keepId != null ? keepId : state.selected;
    state.selected = state.items.some((x) => x.id === want) ? want : state.items[0] && state.items[0].id;
    renderList();
    if (state.selected != null) loadDetail(state.selected); else renderEmptyDetail();
  }

  function renderList() {
    const ul = $("#tlist");
    if (!state.items.length) {
      ul.innerHTML = `<li class="empty">${esc(state.q ? t("panel.noResults") : t(`panel.empty_${section}`))}</li>`;
      $("#range").textContent = "";
      return;
    }
    $("#range").textContent = t("panel.range", { n: state.items.length });
    ul.innerHTML = state.items.map((x) => {
      const urgent = x.priority.label === "high";
      const right = section === "revision"
        ? `<strong>${esc(pct(x.queue.confidence))}</strong><span class="${urgent ? "urgent" : ""}">${esc(urgent ? t("panel.urgent") : t("panel.confidence"))}</span>`
        : `<span class="status status-${x.status}">${esc(t(`status.${x.status}`))}</span>`;
      const area = x.status === "asignado" ? queue(x.assigned_queue) : queue(x.queue.label);
      return `<li role="option" tabindex="-1" data-id="${x.id}" aria-selected="${x.id === state.selected}">
        <div class="t-main"><span class="t-subject">${esc(x.subject || t("stub.noSubject"))}</span>
        <span class="t-meta mono-ish">${esc(x.code)} <i>·</i> ${esc(ago(x.created_at))} <i>·</i> ${esc(area)}</span></div>
        <div class="t-right">${right}</div></li>`;
    }).join("");
    $$("#tlist li[data-id]").forEach((li) => li.addEventListener("click", () => select(Number(li.dataset.id), true)));
  }

  function select(id, focus) {
    state.selected = id;
    $$("#tlist li[data-id]").forEach((li) => li.setAttribute("aria-selected", String(Number(li.dataset.id) === id)));
    const li = $(`#tlist li[data-id="${id}"]`);
    if (li) { li.scrollIntoView({ block: "nearest" }); if (focus) li.focus({ preventScroll: true }); }
    loadDetail(id);
  }

  function renderEmptyDetail() {
    $("#detail").innerHTML = `<div class="detail-empty"><span class="tag"><span class="tag-text">${esc(t("panel.allClear"))}</span></span><p>${esc(t(`panel.emptyDetail_${section}`))}</p></div>`;
  }

  async function loadDetail(id) {
    const res = await api(`/api/panel/tickets/${id}`);
    if (!res.ok) return handleError(res);
    if (state.selected !== id) return;
    state.detail = res.data;
    renderDetail();
  }

  function renderDetail() {
    const x = state.detail;
    const box = $("#detail");
    const review = x.status === "revision";
    const prio = x.priority.label;
    const words = x.top_words.map((w) => `<span class="word" title="${esc(t("panel.weight", { w: num(w.weight, 3) }))}">${esc(w.word)}</span>`).join("");
    const rows = x.queue_top3.map((q, i) => `
      <li class="${i === 0 ? "top" : ""}" data-q="${esc(q.label)}">
        <span>${esc(queue(q.label))}</span>
        <span class="meter-s"><span class="m-${i}" data-w="${Math.max(1, q.confidence * 100)}"></span></span>
        <span class="mono">${esc(pct(q.confidence))}</span>
      </li>${i === 0 && words ? `<li class="why"><span>${esc(t("stub.words"))}</span>${words}</li>` : ""}`).join("");
    const options = state.me.queues.map((q) => `<option value="${esc(q)}">${esc(queue(q))}</option>`).join("");
    let actions = "";
    if (review) {
      actions = `
        <div class="assign">
          <label for="assign-to">${esc(t("panel.assignTo"))}</label>
          <div class="select-wrap"><select id="assign-to">${options}</select><svg aria-hidden="true"><use href="#i-chevron"/></svg></div>
          <div class="assign-btns">
            <button type="button" class="btn btn-indigo" id="do-assign"><span>${esc(t("panel.assign"))}</span><svg class="btn-arrow" aria-hidden="true"><use href="#i-arrow"/></svg></button>
            <button type="button" class="btn btn-ghost" id="do-defer">${esc(t("panel.later"))}</button>
          </div>
          <p class="note mono">${esc(t("panel.laterNote"))}<br>${esc(t("panel.shortcuts"))}</p>
        </div>`;
    } else if (x.status === "asignado") {
      actions = `<p class="stamped"><span class="status status-asignado">${esc(t("status.asignado"))}</span> ${esc(t("panel.assignedBy", { area: queue(x.assigned_queue), who: x.assigned_by || "—", when: date(x.assigned_at) }))}</p>`;
    } else {
      actions = `<p class="stamped"><span class="status status-enviado">${esc(t("status.enviado"))}</span> ${esc(t("panel.autoNote", { v: num(x.queue.confidence, 2), thr: num(x.threshold, 2) }))}</p>`;
    }
    box.innerHTML = `
      <article class="d-card">
        <header class="d-head">
          <span class="d-code mono">${esc(x.code)}</span>
          <span class="d-src">${esc(sourceLabel(x.source))} · ${esc(ago(x.created_at))}</span>
          <span class="prio prio-${prio}">${esc(t("panel.priorityTag", { p: prioLabel(prio) }))}</span>
        </header>
        <h2 class="d-subject display">${esc(x.subject || t("stub.noSubject"))}</h2>
        <div class="d-body">${esc(x.body)}</div>
        <p class="d-k mono">${esc(t("panel.aiThinks"))}</p>
        <ul class="d-top">${rows}</ul>
        <p class="d-type">${esc(t("panel.typeIs", { type: typeLabel(x.type.label) }))}</p>
        ${actions}
      </article>`;
    requestAnimationFrame(() => $$("[data-w]", box).forEach((el) => { el.style.width = `${el.dataset.w}%`; }));
    if (review) {
      $("#assign-to").value = x.queue.label;
      $("#do-assign").addEventListener("click", assign);
      $("#do-defer").addEventListener("click", defer);
    }
  }

  async function assign() {
    const x = state.detail;
    if (!x || x.status !== "revision") return;
    const q = $("#assign-to").value;
    const btn = $("#do-assign");
    btn.disabled = true;
    const res = await api(`/api/panel/tickets/${x.id}/assign`, { method: "POST", body: { queue: q } });
    btn.disabled = false;
    if (!res.ok) { toast(errorText(res), "err"); return; }
    const card = $(".d-card");
    if (card && !reduced()) {
      card.append(h(`<span class="d-stamp">${esc(queue(q))}</span>`));
      await new Promise((r) => setTimeout(r, 520));
    }
    toast(t("panel.assignedToast", { code: x.code, area: queue(q) }));
    const idx = state.items.findIndex((i) => i.id === x.id);
    const next = state.items[idx + 1] || state.items[idx - 1];
    state.selected = next ? next.id : null;
    loadList(state.selected);
  }

  async function defer() {
    const x = state.detail;
    if (!x) return;
    const res = await api(`/api/panel/tickets/${x.id}/defer`, { method: "POST" });
    if (!res.ok) { toast(errorText(res), "err"); return; }
    toast(t("panel.deferredToast", { code: x.code }));
    const idx = state.items.findIndex((i) => i.id === x.id);
    const next = state.items[idx + 1];
    loadList(next ? next.id : x.id);
  }

  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (!["revision", "enviados", "todos"].includes(section) || e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = e.target.closest("input, textarea, select, [contenteditable]");
      if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); return; }
      if (typing || e.target.closest("button, a, .lang")) return;
      const i = state.items.findIndex((x) => x.id === state.selected);
      if (e.key === "j" || e.key === "J") { e.preventDefault(); const n = state.items[Math.min(i + 1, state.items.length - 1)]; if (n) select(n.id, true); }
      else if (e.key === "k" || e.key === "K") { e.preventDefault(); const n = state.items[Math.max(i - 1, 0)]; if (n) select(n.id, true); }
      else if (["1", "2", "3"].includes(e.key) && state.detail && state.detail.status === "revision") {
        const q = state.detail.queue_top3[Number(e.key) - 1];
        if (q) { $("#assign-to").value = q.label; $$(".d-top li[data-q]").forEach((li) => li.classList.toggle("picked", li.dataset.q === q.label)); }
      } else if (e.key === "Enter" && state.detail && state.detail.status === "revision") { e.preventDefault(); assign(); }
    });
  }

  /* ---------- threshold & areas (admin) ---------- */
  async function renderThreshold() {
    const res = await api("/api/panel/threshold");
    if (!res.ok) return handleError(res);
    const d = res.data;
    let value = d.threshold;
    main.replaceChildren(h(`
      <div class="page">
        <header class="page-head"><div>
          ${tag(t("panel.tagThreshold"), num(value, 2))}
          <h1 class="display page-title">${esc(t("panel.titleThreshold"))}</h1>
          <p class="page-sub">${esc(t("panel.subThreshold"))}</p>
        </div></header>
        <div class="thr-grid">
          <section class="card">
            <h2 class="card-title">${esc(t("panel.thrControl"))}</h2>
            <label class="range-label" for="thr">${esc(t("panel.thrLabel"))} <output id="thr-out" class="mono"></output></label>
            <input type="range" id="thr" min="${d.min}" max="${d.max}" step="0.05" value="${value}">
            <div class="range-ends mono"><span>${esc(num(d.min, 2))} · ${esc(t("panel.thrMoreAuto"))}</span><span>${esc(t("panel.thrSafer"))} · ${esc(num(d.max, 2))}</span></div>
            <div class="mini-board" id="mini-board"></div>
            <p class="note">${esc(t("panel.thrNote"))}</p>
            <div class="row-btns"><button type="button" class="btn btn-indigo" id="thr-save"><span>${esc(t("panel.thrSave"))}</span><svg class="btn-arrow" aria-hidden="true"><use href="#i-arrow"/></svg></button></div>
          </section>
          <section class="card">
            <h2 class="card-title">${esc(t("panel.areasTitle"))}</h2>
            <p class="card-sub">${esc(t("panel.areasSub"))}</p>
            <table class="table"><thead><tr><th scope="col">${esc(t("panel.colArea"))}</th><th scope="col" class="num">${esc(t("status.enviado"))}</th><th scope="col" class="num">${esc(t("status.revision"))}</th><th scope="col" class="num">${esc(t("status.asignado"))}</th></tr></thead>
            <tbody>${d.queues.map((q) => { const a = d.areas[q] || {}; return `<tr><td>${esc(queue(q))}</td><td class="num mono">${a.enviado || 0}</td><td class="num mono">${a.revision || 0}</td><td class="num mono">${a.asignado || 0}</td></tr>`; }).join("")}</tbody></table>
          </section>
        </div>
      </div>`));
    const slider = $("#thr");
    const flapCells = (text) => `<span class="flaps" aria-hidden="true">${[...text].map((c) => `<span class="flap">${c === " " ? "" : esc(c)}</span>`).join("")}</span>`;
    const draw = (flip) => {
      const v = Math.round(value * 100) / 100;
      const live = d.live.find((r) => Math.abs(r.threshold - v) < 0.001) || { auto: 0 };
      const sw = d.sweep.find((r) => Math.abs(r.threshold - v) < 0.001);
      $("#thr-out").textContent = num(v, 2);
      const cells = [
        [t("panel.bThreshold"), num(v, 2), ""],
        [t("panel.bWouldAuto"), `${String(live.auto).padStart(3, " ")}`, t("panel.bOfStored", { n: d.total })],
        [t("panel.bExpected"), sw && sw.accuracy != null ? `${String(Math.round(sw.accuracy * 100)).padStart(3, " ")} %` : " —", t("panel.bOnTest")],
        [t("panel.bReviewNow"), `${String(d.counts.revision).padStart(3, " ")}`, t("panel.bWaiting")],
      ];
      $("#mini-board").innerHTML = cells.map(([k, val, sub]) => `<div class="mb-cell"><span class="mb-k mono">${esc(k)}</span>${flapCells(val)}<span class="sr-only">${esc(val.trim())}</span><span class="mb-sub">${esc(sub)}</span></div>`).join("");
      if (flip && !reduced()) $$("#mini-board .flap").forEach((f, i) => { f.style.animationDelay = `${i * 30}ms`; f.classList.add("flip"); });
    };
    draw(true);
    slider.addEventListener("input", () => { value = Number(slider.value); draw(true); });
    $("#thr-save").addEventListener("click", async () => {
      const r = await api("/api/panel/threshold", { method: "POST", body: { threshold: value } });
      if (!r.ok) { toast(errorText(r), "err"); return; }
      state.me.threshold = r.data.threshold;
      $(".page-head .tag-num").textContent = num(r.data.threshold, 2);
      toast(t("panel.thrSaved", { v: num(r.data.threshold, 2) }));
    });
  }

  /* ---------- team (admin) ---------- */
  async function renderTeam() {
    const res = await api("/api/panel/team");
    if (!res.ok) return handleError(res);
    const { items, me } = res.data;
    const areaOpts = `<option value="">${esc(t("panel.noArea"))}</option>` + state.me.queues.map((q) => `<option value="${esc(q)}">${esc(queue(q))}</option>`).join("");
    main.replaceChildren(h(`
      <div class="page">
        <header class="page-head"><div>
          ${tag(t("panel.tagTeam"), items.filter((u) => u.active).length)}
          <h1 class="display page-title">${esc(t("panel.titleTeam"))}</h1>
          <p class="page-sub">${esc(t("panel.subTeam"))}</p>
        </div></header>
        <div class="team-grid">
          <section class="card">
            <table class="table team-table">
              <thead><tr><th scope="col">${esc(t("panel.colName"))}</th><th scope="col">${esc(t("panel.colRole"))}</th><th scope="col">${esc(t("panel.colLast"))}</th><th scope="col"><span class="sr-only">${esc(t("panel.colActions"))}</span></th></tr></thead>
              <tbody>${items.map((u) => `
                <tr class="${u.active ? "" : "inactive"}">
                  <td><strong>${esc(u.name)}</strong><span class="sub">${esc(u.email)}</span></td>
                  <td>${esc(t(`role.${u.role}`))}${u.area ? `<span class="sub">${esc(queue(u.area))}</span>` : ""}${u.must_change_password && u.active ? `<span class="sub warn">${esc(t("panel.tempPw"))}</span>` : ""}</td>
                  <td>${u.active ? esc(u.last_login_at ? ago(u.last_login_at) : t("panel.never")) : `<span class="status status-off">${esc(t("panel.inactive"))}</span>`}</td>
                  <td class="actions">${u.active && u.id !== me ? `<button type="button" class="link" data-reset="${u.id}">${esc(t("panel.resetPw"))}</button><button type="button" class="link danger" data-off="${u.id}" data-name="${esc(u.name)}">${esc(t("panel.deactivate"))}</button>` : ""}</td>
                </tr>`).join("")}</tbody>
            </table>
          </section>
          <section class="card">
            <h2 class="card-title">${esc(t("panel.addTitle"))}</h2>
            <form id="add-form" class="stack" novalidate>
              <div class="field"><label class="field-label" for="m-name">${esc(t("panel.colName"))}</label><input class="input" id="m-name" required minlength="2" maxlength="80" autocomplete="off"></div>
              <div class="field"><label class="field-label" for="m-email">${esc(t("panel.email"))}</label><input class="input" id="m-email" type="email" required maxlength="254" autocomplete="off"></div>
              <div class="field"><label class="field-label" for="m-role">${esc(t("panel.colRole"))}</label><select class="input" id="m-role"><option value="agente">${esc(t("role.agente"))}</option><option value="admin">${esc(t("role.admin"))}</option></select></div>
              <div class="field"><label class="field-label" for="m-area">${esc(t("panel.area"))}</label><select class="input" id="m-area">${areaOpts}</select></div>
              <p class="field-error" id="add-error" role="alert"></p>
              <button type="submit" class="btn btn-indigo"><span>${esc(t("panel.addBtn"))}</span><svg class="btn-arrow" aria-hidden="true"><use href="#i-arrow"/></svg></button>
            </form>
            <div class="secret" id="secret" hidden></div>
          </section>
        </div>
      </div>`));
    const showSecret = (name, pw) => {
      const box = $("#secret");
      box.hidden = false;
      box.innerHTML = `<p>${esc(t("panel.tempFor", { name }))}</p><code class="mono" id="pw-code">${esc(pw)}</code><button type="button" class="btn btn-ghost" id="copy-pw">${esc(t("panel.copy"))}</button><p class="note">${esc(t("panel.tempNote"))}</p>`;
      $("#copy-pw").addEventListener("click", async () => { try { await navigator.clipboard.writeText(pw); toast(t("panel.copied")); } catch (e) { toast(t("err.generic"), "err"); } });
      box.focus();
    };
    $("#add-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { name: $("#m-name").value.trim(), email: $("#m-email").value.trim(), role: $("#m-role").value, area: $("#m-area").value || null };
      const err = $("#add-error");
      if (body.name.length < 2) { err.textContent = t("err.name_required"); $("#m-name").focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(body.email)) { err.textContent = t("err.email_invalid"); $("#m-email").focus(); return; }
      err.textContent = "";
      const r = await api("/api/panel/team", { method: "POST", body });
      if (!r.ok) { err.textContent = errorText(r); return; }
      await renderTeam();
      showSecret(r.data.user.name, r.data.temp_password);
    });
    $$("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
      const r = await api(`/api/panel/team/${b.dataset.reset}/reset`, { method: "POST" });
      if (!r.ok) { toast(errorText(r), "err"); return; }
      const name = b.closest("tr").querySelector("strong").textContent;
      await renderTeam();
      showSecret(name, r.data.temp_password);
    }));
    $$("[data-off]").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm(t("panel.confirmOff", { name: b.dataset.name }))) return;
      const r = await api(`/api/panel/team/${b.dataset.off}/deactivate`, { method: "POST" });
      if (!r.ok) { toast(errorText(r), "err"); return; }
      toast(t("panel.offToast", { name: b.dataset.name }));
      renderTeam();
    }));
  }

  /* ---------- contact messages (admin) ---------- */
  async function renderMessages() {
    const res = await api("/api/panel/messages");
    if (!res.ok) return handleError(res);
    const items = res.data.items;
    main.replaceChildren(h(`
      <div class="page">
        <header class="page-head"><div>
          ${tag(t("panel.tagMessages"), items.filter((m) => !m.read_at).length)}
          <h1 class="display page-title">${esc(t("panel.titleMessages"))}</h1>
          <p class="page-sub">${esc(t("panel.subMessages"))}</p>
        </div></header>
        <ul class="msgs">${items.length ? items.map((m) => `
          <li class="card msg ${m.read_at ? "" : "unread"}">
            <header><strong>${esc(m.name)}</strong> <a href="mailto:${esc(m.email)}">${esc(m.email)}</a><span class="msg-topic">${esc(t(`contact.topic_${m.topic}`))}</span><time datetime="${esc(m.created_at)}">${esc(date(m.created_at))}</time></header>
            <p>${esc(m.message)}</p>
            ${m.read_at ? "" : `<button type="button" class="link" data-read="${m.id}">${esc(t("panel.markRead"))}</button>`}
          </li>`).join("") : `<li class="card empty">${esc(t("panel.noMessages"))}</li>`}</ul>
      </div>`));
    $$("[data-read]").forEach((b) => b.addEventListener("click", async () => {
      const r = await api(`/api/panel/messages/${b.dataset.read}/read`, { method: "POST" });
      if (!r.ok) { toast(errorText(r), "err"); return; }
      state.me.unread_messages = Math.max(0, (state.me.unread_messages || 1) - 1);
      renderChrome();
      renderMessages();
    }));
  }

  /* ---------- account / password ---------- */
  function renderAccount() {
    const forced = state.me.user.must_change_password;
    main.replaceChildren(h(`
      <div class="page page-narrow">
        <header class="page-head"><div>
          ${tag(t("panel.tagAccount"))}
          <h1 class="display page-title">${esc(t("panel.titleAccount"))}</h1>
          <p class="page-sub">${esc(forced ? t("panel.forcedSub") : t("panel.subAccount"))}</p>
        </div></header>
        <section class="card">
          <form id="pw-form" class="stack" novalidate>
            <div class="field"><label class="field-label" for="pw-cur">${esc(t("panel.pwCurrent"))}</label><input class="input" id="pw-cur" type="password" autocomplete="current-password" required></div>
            <div class="field"><label class="field-label" for="pw-new">${esc(t("panel.pwNew"))}</label><input class="input" id="pw-new" type="password" autocomplete="new-password" required aria-describedby="pw-rules"><p class="hint" id="pw-rules">${esc(t("panel.pwRules"))}</p></div>
            <div class="field"><label class="field-label" for="pw-rep">${esc(t("panel.pwRepeat"))}</label><input class="input" id="pw-rep" type="password" autocomplete="new-password" required></div>
            <p class="field-error" id="pw-error" role="alert"></p>
            <button type="submit" class="btn btn-indigo"><span>${esc(t("panel.pwSave"))}</span><svg class="btn-arrow" aria-hidden="true"><use href="#i-arrow"/></svg></button>
          </form>
        </section>
      </div>`));
    $("#pw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#pw-error");
      const cur = $("#pw-cur").value, nw = $("#pw-new").value, rep = $("#pw-rep").value;
      if (nw !== rep) { err.textContent = t("err.password_mismatch"); $("#pw-rep").focus(); return; }
      const r = await api("/api/auth/password", { method: "POST", body: { current: cur, new: nw } });
      if (!r.ok) { err.textContent = errorText(r); return; }
      err.textContent = "";
      toast(t("panel.pwSaved"));
      if (forced) setTimeout(() => window.location.assign("/panel"), 900);
      else e.target.reset();
    });
  }

  function handleError(res) {
    if (res.status === 401) { window.location.assign("/login"); return; }
    if (res.data && res.data.detail === "password_change_required") { window.location.assign("/panel/cuenta"); return; }
    main.replaceChildren(h(`<div class="page"><p class="card error-card">${esc(errorText(res))}</p></div>`));
  }

  const RENDER = { revision: renderListPage, enviados: renderListPage, todos: renderListPage, umbral: renderThreshold, equipo: renderTeam, mensajes: renderMessages, cuenta: renderAccount };

  async function boot() {
    await ST.ready;
    initChrome();
    const res = await api("/api/panel/me");
    if (!res.ok) return handleError(res);
    state.me = res.data;
    if (state.me.user.must_change_password && section !== "cuenta") { window.location.assign("/panel/cuenta"); return; }
    renderChrome();
    initShortcuts();
    (RENDER[section] || renderListPage)();
    document.addEventListener("langchange", () => { renderChrome(); (RENDER[section] || renderListPage)(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
