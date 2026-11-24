"use strict";

(() => {
  const THRESHOLD = Number(document.querySelector('meta[name="review-threshold"]').content) || 0.5;
  const MAX_BATCH = 10;
  const MIN_BODY = 10;
  const MAX_BODY = 5000;

  const EXAMPLES = [
    {
      key: "billing", subject: "Charged twice for my subscription",
      body: "Hello, I was billed twice for my monthly subscription this month. Both payments show on my credit card statement. Please refund the duplicate payment and confirm my invoice.",
    },
    {
      key: "vpn", subject: "VPN down for the whole office",
      body: "Since this morning none of our staff can connect to the corporate VPN. The client times out during authentication and remote employees cannot access internal systems. This is blocking work.",
    },
    {
      key: "refund", subject: "Refund request for order",
      body: "I would like to request a refund for my last purchase. The product did not meet our expectations and we returned it within the trial period.",
    },
    {
      key: "sales", subject: "Question about enterprise plan",
      body: "We are evaluating your platform for a team of 200 people. Does the enterprise plan include SSO and a dedicated account manager? Could you send pricing details?",
    },
    {
      key: "hr", subject: "Question about parental leave policy",
      body: "Hi, I am expecting a child in March and would like to understand the parental leave policy and how to submit the request to HR.",
    },
  ];

  const I18N = {
    en: {
      skip: "Skip to composer", apiDocs: "API docs",
      headline: "Classify a support ticket, then decide who should see it.",
      lede: "Predicts type, queue and priority with TF-IDF and logistic regression. When queue confidence falls below the review threshold, the ticket goes to a person instead of being guessed.",
      composer: "Ticket", single: "Single", batch: "Batch", subject: "Subject", body: "Message",
      bodyHint: "10 to 5,000 characters. Any language is accepted; the model was trained on English tickets.",
      examples: "Try an example", classify: "Classify", clear: "Clear",
      batchLabel: "Tickets, one per line or a JSON array",
      batchHint: 'Up to 10 tickets. Use "subject | message" on a line to include a subject, or paste JSON such as [{"subject": "...", "body": "..."}].',
      classifyBatch: "Classify batch", loadSamples: "Load samples", result: "Result",
      modelCard: "Model card",
      modelSub: "Held-out test set (20%, stratified). Macro F1 weights every class equally, so rare queues count as much as common ones.",
      legendModel: "Model macro F1", legendBase: "Majority-class baseline", swagger: "Open the Swagger docs",
      chip: { billing: "Double charge", vpn: "VPN outage", refund: "Refund", sales: "Enterprise pricing", hr: "Parental leave" },
      emptyTitle: "Nothing classified yet",
      emptyText: "Write a ticket or pick an example. The model returns three predictions and one routing decision.",
      step1: ["Type, queue and priority", "each with the probability of the top class."],
      step2: ["Queue top 3", "so you can see what the model was choosing between."],
      step3: ["Routing decision", "auto-route when queue confidence is at least the threshold, otherwise a human reviews it."],
      routedKicker: "Auto-routed", routedTitle: (q) => `Sent to ${q}`,
      routedNote: (c, t) => `Queue confidence ${c} is at or above the ${t} threshold.`,
      reviewKicker: "Needs human review", reviewTitle: (q) => `Best guess is ${q}, held for a person`,
      reviewNote: (c, t) => `Queue confidence ${c} is below the ${t} threshold, so the ticket is not auto-routed.`,
      threshold: "threshold", type: "Type", queue: "Queue", priority: "Priority",
      confidence: "confidence", top3: "Queue, top 3", top3Note: "line marks the threshold",
      latency: (ms) => `${ms} ms`,
      errValidation: "The API rejected this ticket", errUnavailable: "Model unavailable",
      errNetwork: "Could not reach the API", errGeneric: "Request failed",
      errNetworkText: "Check that uvicorn is running and try again.",
      batchEmpty: "Add at least one ticket.",
      batchTooMany: (n) => `The demo accepts up to ${MAX_BATCH} tickets; you pasted ${n}.`,
      batchJson: "That looks like JSON but could not be parsed.",
      batchShort: (rows) => `Line${rows.length > 1 ? "s" : ""} ${rows.join(", ")} ${rows.length > 1 ? "are" : "is"} shorter than ${MIN_BODY} characters.`,
      sumTotal: "Tickets", sumAuto: "Auto-routed", sumReview: "To review", sumLatency: "Latency",
      colTicket: "Ticket", colStatus: "Status", auto: "Auto", review: "Review",
      emptyBatchTitle: "Batch results appear here",
      emptyBatchText: "Paste up to 10 tickets on the left. Each row gets a type, queue, priority and a review flag.",
      modelOk: (n) => `model loaded, ${n} tickets`, modelDown: "model not loaded", modelConnecting: "connecting",
      trained: "Trained", tickets: "Tickets", thresholdFact: "Review threshold", classes: (n) => `${n} classes`,
      vsBase: "baseline", acc: "accuracy", lift: (x) => `${x}x baseline`,
      targetNames: { type: "Type", queue: "Queue", priority: "Priority" },
      modelErr: "Model card unavailable: train the model with python -m smartticket.train.",
    },
    es: {
      skip: "Ir al formulario", apiDocs: "Docs de la API",
      headline: "Clasifica un ticket de soporte y decide quién debe verlo.",
      lede: "Predice tipo, cola y prioridad con TF-IDF y regresión logística. Si la confianza de la cola queda por debajo del umbral de revisión, el ticket pasa a una persona en lugar de adivinar.",
      composer: "Ticket", single: "Individual", batch: "Lote", subject: "Asunto", body: "Mensaje",
      bodyHint: "De 10 a 5.000 caracteres. Acepta cualquier idioma; el modelo se entrenó con tickets en inglés.",
      examples: "Prueba un ejemplo", classify: "Clasificar", clear: "Limpiar",
      batchLabel: "Tickets, uno por línea o un arreglo JSON",
      batchHint: 'Hasta 10 tickets. Usa "asunto | mensaje" en una línea para incluir asunto, o pega JSON como [{"subject": "...", "body": "..."}].',
      classifyBatch: "Clasificar lote", loadSamples: "Cargar ejemplos", result: "Resultado",
      modelCard: "Ficha del modelo",
      modelSub: "Conjunto de prueba reservado (20%, estratificado). El macro F1 pesa igual cada clase, así que las colas raras cuentan tanto como las comunes.",
      legendModel: "Macro F1 del modelo", legendBase: "Línea base (clase mayoritaria)", swagger: "Abrir la documentación Swagger",
      chip: { billing: "Cobro doble", vpn: "Caída de VPN", refund: "Reembolso", sales: "Precio enterprise", hr: "Permiso parental" },
      emptyTitle: "Aún no hay clasificación",
      emptyText: "Escribe un ticket o elige un ejemplo. El modelo devuelve tres predicciones y una decisión de enrutamiento.",
      step1: ["Tipo, cola y prioridad", "cada una con la probabilidad de la clase ganadora."],
      step2: ["Top 3 de colas", "para ver entre qué opciones dudaba el modelo."],
      step3: ["Decisión de enrutamiento", "se enruta solo si la confianza de la cola alcanza el umbral; si no, lo revisa una persona."],
      routedKicker: "Enrutado automáticamente", routedTitle: (q) => `Enviado a ${q}`,
      routedNote: (c, t) => `La confianza de la cola (${c}) alcanza el umbral de ${t}.`,
      reviewKicker: "Requiere revisión humana", reviewTitle: (q) => `Mejor opción: ${q}, en espera de una persona`,
      reviewNote: (c, t) => `La confianza de la cola (${c}) está por debajo del umbral de ${t}, así que no se enruta solo.`,
      threshold: "umbral", type: "Tipo", queue: "Cola", priority: "Prioridad",
      confidence: "confianza", top3: "Cola, top 3", top3Note: "la línea marca el umbral",
      latency: (ms) => `${ms} ms`,
      errValidation: "La API rechazó este ticket", errUnavailable: "Modelo no disponible",
      errNetwork: "No se pudo contactar la API", errGeneric: "La solicitud falló",
      errNetworkText: "Verifica que uvicorn esté corriendo e inténtalo de nuevo.",
      batchEmpty: "Agrega al menos un ticket.",
      batchTooMany: (n) => `La demo acepta hasta ${MAX_BATCH} tickets; pegaste ${n}.`,
      batchJson: "Parece JSON pero no se pudo leer.",
      batchShort: (rows) => `${rows.length > 1 ? "Las líneas" : "La línea"} ${rows.join(", ")} ${rows.length > 1 ? "tienen" : "tiene"} menos de ${MIN_BODY} caracteres.`,
      sumTotal: "Tickets", sumAuto: "Enrutados", sumReview: "A revisar", sumLatency: "Latencia",
      colTicket: "Ticket", colStatus: "Estado", auto: "Auto", review: "Revisión",
      emptyBatchTitle: "Aquí aparecen los resultados del lote",
      emptyBatchText: "Pega hasta 10 tickets a la izquierda. Cada fila recibe tipo, cola, prioridad y una marca de revisión.",
      modelOk: (n) => `modelo cargado, ${n} tickets`, modelDown: "modelo no cargado", modelConnecting: "conectando",
      trained: "Entrenado", tickets: "Tickets", thresholdFact: "Umbral de revisión", classes: (n) => `${n} clases`,
      vsBase: "línea base", acc: "exactitud", lift: (x) => `${x}x la línea base`,
      targetNames: { type: "Tipo", queue: "Cola", priority: "Prioridad" },
      modelErr: "Ficha no disponible: entrena el modelo con python -m smartticket.train.",
    },
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    subject: $("#subject"), body: $("#body"), counter: $("#counter"), chips: $("#chips"),
    single: $("#mode-single"), batch: $("#mode-batch"), batchInput: $("#batch-input"), batchCounter: $("#batch-counter"),
    classify: $("#classify"), classifyBatch: $("#classify-batch"), output: $("#output"),
    latency: $("#latency"), latencyValue: $("#latency-value"), metrics: $("#metrics"), facts: $("#facts"),
    status: $("#model-status"), statusText: $("#model-status-text"),
  };

  let lang = (localStorageGet("st-lang") || (navigator.language || "en")).toLowerCase().startsWith("es") ? "es" : "en";
  let mode = "single";
  let lastView = { single: { kind: "empty" }, batch: { kind: "empty" } };
  let modelInfo = null;
  let modelError = false;

  function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  const t = () => I18N[lang];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => `${Math.round(x * 100)}%`;
  const fix2 = (x) => Number(x).toFixed(2);
  const fmtInt = (n) => new Intl.NumberFormat(lang === "es" ? "es-MX" : "en-US").format(n);
  const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

  /* ---------- i18n ---------- */
  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const v = t()[node.dataset.i18n];
      if (typeof v === "string") node.textContent = v;
    });
    document.querySelectorAll(".lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    renderChips();
    updateCounter();
    updateBatchCounter();
    renderStatus();
    renderModel();
    rerender();
  }

  /* ---------- composer ---------- */
  function renderChips() {
    const active = el.chips.querySelector('[aria-pressed="true"]')?.dataset.key;
    el.chips.innerHTML = EXAMPLES.map((ex, i) =>
      `<button type="button" class="chip" data-key="${ex.key}" aria-pressed="${ex.key === active}"><span class="chip-k">0${i + 1}</span>${esc(t().chip[ex.key])}</button>`
    ).join("");
  }

  el.chips.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const ex = EXAMPLES.find((x) => x.key === btn.dataset.key);
    el.subject.value = ex.subject;
    el.body.value = ex.body;
    el.chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === btn)));
    el.body.removeAttribute("aria-invalid");
    updateCounter();
    classifySingle();
  });

  function updateCounter() {
    const n = el.body.value.length;
    el.counter.textContent = `${fmtInt(n)} / ${fmtInt(MAX_BODY)}`;
    el.counter.dataset.state = n > 0 && n < MIN_BODY ? "low" : "";
  }
  el.body.addEventListener("input", () => {
    updateCounter();
    el.body.removeAttribute("aria-invalid");
    el.chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  });
  el.subject.addEventListener("input", () => el.chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false")));

  $("#clear").addEventListener("click", () => {
    el.subject.value = ""; el.body.value = "";
    el.chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    updateCounter();
    lastView.single = { kind: "empty" };
    el.latency.hidden = true;
    rerender();
    el.subject.focus();
  });

  el.single.addEventListener("submit", (e) => { e.preventDefault(); classifySingle(); });
  el.batch.addEventListener("submit", (e) => { e.preventDefault(); classifyBatch(); });
  [el.body, el.subject].forEach((n) => n.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); classifySingle(); }
  }));
  el.batchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); classifyBatch(); }
  });

  /* ---------- tabs ---------- */
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function setMode(next, focus) {
    mode = next;
    tabs.forEach((tab) => {
      const on = tab.id === `tab-${next}`;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    el.single.hidden = next !== "single";
    document.querySelector(".workspace").dataset.mode = next;
    el.batch.hidden = next !== "batch";
    const v = lastView[next];
    el.latency.hidden = !(v && v.ms != null);
    if (v && v.ms != null) el.latencyValue.textContent = t().latency(v.ms);
    rerender();
  }
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.id.replace("tab-", "")));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setMode(mode === "single" ? "batch" : "single", true);
    });
  });

  /* ---------- API ---------- */
  async function call(path, payload) {
    const started = performance.now();
    let res;
    try {
      res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch {
      return { error: { kind: "network" } };
    }
    const ms = Math.max(1, Math.round(performance.now() - started));
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) return { ms, error: { kind: res.status === 422 ? "validation" : res.status === 503 ? "unavailable" : "generic", status: res.status, detail: data?.detail } };
    return { ms, data };
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    el.output.setAttribute("aria-busy", String(busy));
  }

  async function classifySingle() {
    const body = el.body.value.trim();
    const subject = el.subject.value.trim();
    lastView.single = { kind: "loading" };
    el.latency.hidden = true;
    rerender();
    setBusy(el.classify, true);
    const out = await call("/predict", { subject, body });
    setBusy(el.classify, false);
    lastView.single = out.error ? { kind: "error", error: out.error, ms: out.ms } : { kind: "result", data: out.data, ms: out.ms };
    // validation is left to the API so the demo shows its real 422 messages
    if (out.error?.kind === "validation") el.body.setAttribute("aria-invalid", "true");
    showLatency(out.ms);
    rerender();
  }

  function parseBatch(raw) {
    const text = raw.trim();
    if (!text) return { error: t().batchEmpty };
    let tickets;
    if (text.startsWith("[") || text.startsWith("{")) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { error: t().batchJson }; }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tickets) ? parsed.tickets : [parsed];
      tickets = list.map((x) => typeof x === "string" ? { subject: "", body: x } : { subject: String(x.subject || ""), body: String(x.body || "") });
    } else {
      tickets = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const i = line.indexOf(" | ");
        return i > 0 ? { subject: line.slice(0, i).trim(), body: line.slice(i + 3).trim() } : { subject: "", body: line };
      });
    }
    if (tickets.length > MAX_BATCH) return { error: t().batchTooMany(tickets.length) };
    const short = tickets.map((tk, i) => (tk.body.trim().length < MIN_BODY ? i + 1 : 0)).filter(Boolean);
    if (short.length) return { error: t().batchShort(short) };
    return { tickets };
  }

  function updateBatchCounter() {
    const raw = el.batchInput.value.trim();
    let n = 0;
    if (raw) {
      const p = parseBatch(raw);
      n = p.tickets ? p.tickets.length : (raw.startsWith("[") || raw.startsWith("{")) ? 0 : raw.split(/\r?\n/).filter((l) => l.trim()).length;
    }
    el.batchCounter.textContent = `${n} / ${MAX_BATCH}`;
    el.batchCounter.dataset.state = n > MAX_BATCH ? "low" : "";
  }
  el.batchInput.addEventListener("input", updateBatchCounter);

  $("#batch-sample").addEventListener("click", () => {
    el.batchInput.value = [
      ...EXAMPLES.map((ex) => `${ex.subject} | ${ex.body}`),
      "Issue with my account | Something is not working as expected since last week. Could someone look into it and get back to me?",
      "Cannot log in after password reset | I reset my password yesterday and now the login page says my credentials are invalid. I need access to the admin console today.",
    ].join("\n");
    updateBatchCounter();
    el.batchInput.focus();
  });

  async function classifyBatch() {
    const parsed = parseBatch(el.batchInput.value);
    if (parsed.error) {
      lastView.batch = { kind: "error", error: { kind: "client", message: parsed.error } };
      el.latency.hidden = true;
      rerender();
      return;
    }
    lastView.batch = { kind: "loading", count: parsed.tickets.length };
    el.latency.hidden = true;
    rerender();
    setBusy(el.classifyBatch, true);
    const out = await call("/predict/batch", { tickets: parsed.tickets });
    setBusy(el.classifyBatch, false);
    lastView.batch = out.error ? { kind: "error", error: out.error, ms: out.ms } : { kind: "batch", data: out.data, tickets: parsed.tickets, ms: out.ms };
    showLatency(out.ms);
    rerender();
  }

  function showLatency(ms) {
    if (ms == null) { el.latency.hidden = true; return; }
    el.latencyValue.textContent = t().latency(ms);
    el.latency.hidden = false;
  }

  /* ---------- render ---------- */
  function rerender() {
    const v = lastView[mode];
    if (v.kind === "loading") el.output.innerHTML = mode === "batch" ? skeletonBatch(v.count) : skeletonSingle();
    else if (v.kind === "error") el.output.innerHTML = errorView(v.error);
    else if (v.kind === "result") { el.output.innerHTML = resultView(v.data); animateBars(); }
    else if (v.kind === "batch") el.output.innerHTML = batchView(v.data, v.tickets, v.ms);
    else el.output.innerHTML = mode === "batch" ? emptyBatch() : emptySingle();
  }

  function emptySingle() {
    const s = t();
    return `<div class="empty">
      <div><svg class="empty-icon" aria-hidden="true"><use href="#i-inbox"/></svg></div>
      <div><h3>${s.emptyTitle}</h3><p>${s.emptyText}</p></div>
      <ol class="steps">
        ${[s.step1, s.step2, s.step3].map((st, i) => `<li><span class="n">0${i + 1}</span><span><b>${st[0]}</b>, ${st[1]}</span></li>`).join("")}
      </ol>
    </div>`;
  }

  function emptyBatch() {
    const s = t();
    return `<div class="empty">
      <div><svg class="empty-icon" aria-hidden="true"><use href="#i-inbox"/></svg></div>
      <div><h3>${s.emptyBatchTitle}</h3><p>${s.emptyBatchText}</p></div>
    </div>`;
  }

  function skeletonSingle() {
    return `<div class="sk-stack" aria-label="Loading">
      <div class="sk" style="height:128px;border-radius:12px"></div>
      <div class="sk" style="height:84px;border-radius:12px"></div>
      <div style="display:grid;gap:12px">
        <div class="sk" style="height:12px;width:30%"></div>
        <div class="sk" style="height:10px"></div><div class="sk" style="height:10px;width:70%"></div><div class="sk" style="height:10px;width:45%"></div>
      </div>
    </div>`;
  }

  function skeletonBatch(n = 5) {
    return `<div class="sk-stack" aria-label="Loading">
      <div class="sk" style="height:44px;width:60%"></div>
      ${Array.from({ length: Math.min(n || 5, 10) }, () => `<div class="sk" style="height:30px"></div>`).join("")}
    </div>`;
  }

  function errorView(err) {
    const s = t();
    let title = s.errGeneric, body = "";
    if (err.kind === "client") { title = s.errValidation; body = `<p>${esc(err.message)}</p>`; }
    else if (err.kind === "network") { title = s.errNetwork; body = `<p>${s.errNetworkText}</p>`; }
    else if (err.kind === "validation") {
      title = s.errValidation;
      const items = Array.isArray(err.detail) ? err.detail : [];
      body = items.length
        ? `<ul>${items.map((d) => `<li><code>${esc((d.loc || []).slice(1).join("."))}</code> ${esc(d.msg || "")}</li>`).join("")}</ul>`
        : `<p>${esc(typeof err.detail === "string" ? err.detail : "422")}</p>`;
    } else if (err.kind === "unavailable") {
      title = s.errUnavailable;
      body = `<p>${esc(err.detail || "503")}</p>`;
    } else {
      body = `<p>HTTP ${esc(err.status)} ${esc(typeof err.detail === "string" ? err.detail : "")}</p>`;
    }
    return `<div class="error reveal" role="alert">${icon("i-alert")}<div><h3>${title} <span class="mono" style="color:var(--text-3);font-weight:400;font-size:12px">${err.status ? err.status : ""}</span></h3>${body}</div></div>`;
  }

  function resultView(p) {
    const s = t();
    const review = p.needs_review;
    const q = p.queue;
    const kind = review ? "review" : "routed";
    const left = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(2)}%`;
    const prioLevel = { low: 1, medium: 2, high: 3 }[p.priority.label] || 0;
    return `
      <div class="decision reveal" data-kind="${kind}">
        <div class="decision-top">
          <div class="decision-icon">${icon(review ? "i-user" : "i-route")}</div>
          <div>
            <p class="decision-kicker">${review ? s.reviewKicker : s.routedKicker}</p>
            <h3 class="decision-title">${esc(review ? s.reviewTitle(q.label) : s.routedTitle(q.label))}</h3>
            <p class="decision-note">${review ? s.reviewNote(fix2(q.confidence), fix2(THRESHOLD)) : s.routedNote(fix2(q.confidence), fix2(THRESHOLD))}</p>
          </div>
        </div>
        <div class="scale" role="img" aria-label="${esc(`${s.queue} ${s.confidence} ${fix2(q.confidence)}, ${s.threshold} ${fix2(THRESHOLD)}`)}">
          <div class="scale-axis"></div>
          <div class="scale-zone" style="left:${left(THRESHOLD)}"></div>
          <div class="scale-th" style="left:${left(THRESHOLD)}"></div>
          <span class="scale-th-label mono" style="left:${left(THRESHOLD)}">${s.threshold} ${fix2(THRESHOLD)}</span>
          <span class="scale-end mono" style="left:0">0</span>
          <span class="scale-end mono" style="right:0">1</span>
          <div class="scale-dot" data-left="${left(q.confidence)}" style="left:0"></div>
        </div>
      </div>

      <div class="preds reveal reveal-2">
        ${predCell(s.type, esc(p.type.label), p.type.confidence)}
        ${predCell(s.queue, esc(q.label), q.confidence)}
        ${predCell(s.priority, `<span class="prio"><span class="prio-bars" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= prioLevel ? "on" : ""}"></i>`).join("")}</span>${esc(p.priority.label)}</span>`, p.priority.confidence)}
      </div>

      <div class="top3 reveal reveal-3">
        <div class="sub-head"><span class="sub-title">${s.top3}</span><span class="sub-title" style="font-weight:400">${s.top3Note}</span></div>
        <ol class="bars" data-kind="${kind}">
          ${p.queue_top3.map((x) => `
            <li class="bar-row">
              <span class="bar-label">${esc(x.label)}</span>
              <span class="bar-val mono">${pct(x.confidence)}</span>
              <span class="bar-track" aria-hidden="true"><span class="bar-fill" data-w="${left(x.confidence)}"></span><span class="bar-th" style="left:${left(THRESHOLD)}"></span></span>
            </li>`).join("")}
        </ol>
      </div>`;
  }

  function predCell(k, v, c) {
    return `<div class="pred"><p class="pred-k">${k}</p><p class="pred-v">${v}</p><p class="pred-c mono">${pct(c)} <span style="color:var(--text-3)">${t().confidence}</span></p></div>`;
  }

  function animateBars() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.output.querySelectorAll(".bar-fill").forEach((b) => { b.style.width = b.dataset.w; });
      el.output.querySelectorAll(".scale-dot").forEach((d) => { d.style.left = d.dataset.left; });
    }));
  }

  function batchView(rows, tickets, ms) {
    const s = t();
    const review = rows.filter((r) => r.needs_review).length;
    return `
      <dl class="batch-summary reveal">
        <div><dt>${s.sumTotal}</dt><dd>${rows.length}</dd></div>
        <div><dt>${s.sumAuto}</dt><dd style="color:var(--accent)">${rows.length - review}</dd></div>
        <div><dt>${s.sumReview}</dt><dd style="color:var(--warn)">${review}</dd></div>
        <div><dt>${s.thresholdFact}</dt><dd class="mono" style="font-size:17px;padding-top:3px">${fix2(THRESHOLD)}</dd></div>
      </dl>
      <div class="table-wrap reveal reveal-2">
        <table>
          <thead><tr><th>#</th><th>${s.colTicket}</th><th>${s.type}</th><th>${s.queue}</th><th>${s.priority}</th><th>${s.colStatus}</th></tr></thead>
          <tbody>
            ${rows.map((r, i) => {
              const tk = tickets[i];
              const head = tk.subject || tk.body;
              return `<tr class="${r.needs_review ? "is-review" : ""}">
                <td class="num">${String(i + 1).padStart(2, "0")}</td>
                <td><div class="excerpt" title="${esc(tk.body)}">${esc(head)}</div>${tk.subject ? `<div class="excerpt-sub">${esc(tk.body)}</div>` : ""}</td>
                <td>${esc(r.type.label)}</td>
                <td class="queue">${esc(r.queue.label)}<div class="conf">${fix2(r.queue.confidence)}</div></td>
                <td>${esc(r.priority.label)}</td>
                <td><span class="flag ${r.needs_review ? "flag-review" : "flag-auto"}">${r.needs_review ? s.review : s.auto}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  /* ---------- model card ---------- */
  function renderStatus() {
    if (modelInfo) { el.status.dataset.state = "ok"; el.statusText.textContent = t().modelOk(fmtInt(modelInfo.n_tickets)); }
    else if (modelError) { el.status.dataset.state = "down"; el.statusText.textContent = t().modelDown; }
    else { el.status.dataset.state = ""; el.statusText.textContent = t().modelConnecting; }
  }

  function renderModel() {
    const s = t();
    if (modelError) {
      el.facts.innerHTML = "";
      el.metrics.innerHTML = `<div class="metric"><p class="metric-vs">${s.modelErr}</p></div>`;
      return;
    }
    if (!modelInfo) {
      el.metrics.innerHTML = [0, 1, 2].map(() => `<div class="metric"><div class="sk" style="height:14px;width:40%"></div><div class="sk" style="height:30px;width:55%"></div><div class="sk" style="height:20px"></div></div>`).join("");
      return;
    }
    const d = new Date(modelInfo.trained_at);
    const date = isNaN(d) ? modelInfo.trained_at : d.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { year: "numeric", month: "short", day: "numeric" });
    el.facts.innerHTML = `
      <div><dt>${s.trained}</dt><dd>${esc(date)}</dd></div>
      <div><dt>${s.tickets}</dt><dd>${fmtInt(modelInfo.n_tickets)}</dd></div>
      <div><dt>${s.thresholdFact}</dt><dd>${fix2(THRESHOLD)}</dd></div>`;
    const order = ["type", "queue", "priority"].filter((k) => modelInfo.targets[k]);
    el.metrics.innerHTML = order.map((k) => {
      const m = modelInfo.targets[k];
      const lift = m.baseline_macro_f1 > 0 ? (m.macro_f1 / m.baseline_macro_f1).toFixed(1) : "n/a";
      return `<div class="metric">
        <div class="metric-top"><span class="metric-name">${s.targetNames[k] || esc(k)}</span><span class="metric-classes">${s.classes(m.classes.length)}</span></div>
        <div class="metric-nums">
          <span class="metric-f1">${fix2(m.macro_f1)}</span>
          <span class="metric-vs">${s.vsBase} <b>${fix2(m.baseline_macro_f1)}</b></span>
          <span class="metric-lift">${s.lift(lift)}</span>
        </div>
        ${dumbbell(m.baseline_macro_f1, m.macro_f1, `${s.targetNames[k]}: macro F1 ${fix2(m.macro_f1)}, ${s.vsBase} ${fix2(m.baseline_macro_f1)}`)}
        <p class="metric-acc">${s.acc} <span>${fix2(m.accuracy)}</span></p>
      </div>`;
    }).join("");
  }

  function dumbbell(base, model, label) {
    // x from 6 to 294 in a 300-wide viewBox
    const x = (v) => 6 + Math.max(0, Math.min(1, v)) * 288;
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    return `<svg class="dumbbell" viewBox="0 0 300 30" role="img" aria-label="${esc(label)}">
      <line class="ax" x1="6" x2="294" y1="10" y2="10"/>
      ${ticks.map((v) => `<line class="tk" x1="${x(v)}" x2="${x(v)}" y1="6" y2="14"/>`).join("")}
      <text class="tl" x="${x(0)}" y="28" text-anchor="start">0</text>
      <text class="tl" x="${x(0.5)}" y="28" text-anchor="middle">0.5</text>
      <text class="tl" x="${x(1)}" y="28" text-anchor="end">1</text>
      <line class="span" x1="${x(base)}" x2="${x(model)}" y1="10" y2="10"/>
      <circle class="b" cx="${x(base)}" cy="10" r="4"/>
      <circle class="m" cx="${x(model)}" cy="10" r="5"/>
    </svg>`;
  }

  async function loadModelInfo() {
    try {
      const res = await fetch("/model-info");
      if (!res.ok) throw new Error(String(res.status));
      modelInfo = await res.json();
    } catch {
      modelError = true;
    }
    renderStatus();
    renderModel();
  }

  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => {
    lang = b.dataset.lang;
    localStorageSet("st-lang", lang);
    applyLang();
  }));

  applyLang();
  loadModelInfo();
})();
