"use strict";
/* Self-registration: an access request that an admin approves in Equipo. */
(() => {
  const { t, queue, api, errorText } = window.ST;
  const $ = (s, r = document) => r.querySelector(s);
  const FIELDS = ["name", "email", "area", "password", "confirm"];

  function fillAreas(form) {
    const select = $("#r-area");
    let queues = [];
    try { queues = JSON.parse(form.dataset.queues || "[]"); } catch (e) { queues = []; }
    const current = select.value;
    const placeholder = select.options[0];
    placeholder.textContent = t("register.areaPh");
    select.replaceChildren(placeholder, ...queues
      .map((q) => [q, queue(q)])
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; }));
    select.value = current;
  }

  function setError(name, code) {
    const el = $(`#r-${name}-err`);
    el.textContent = code ? t(`err.${code}`) : "";
    $(`#r-${name}`).setAttribute("aria-invalid", code ? "true" : "false");
  }

  function validate(data) {
    const e = {};
    if (data.name.length < 2) e.name = "name_required";
    if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(data.email)) e.email = "email_invalid";
    if (!data.area) e.area = "area_required";
    if (data.password.length < 10) e.password = "password_short";
    else if (!(/[A-Za-z]/.test(data.password) && /\d/.test(data.password))) e.password = "password_mix";
    else if (data.confirm !== data.password) e.confirm = "password_mismatch";
    return e;
  }

  async function init() {
    const form = $("#register-form");
    if (!form) return;
    await window.ST.ready;
    fillAreas(form);
    document.addEventListener("langchange", () => fillAreas(form));

    form.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => {
      const input = $(`#${btn.dataset.toggle}`);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("#r-confirm").type = input.type;
      btn.setAttribute("aria-pressed", String(show));
      btn.dataset.i18n = show ? "login.hide" : "login.show";
      btn.textContent = t(btn.dataset.i18n);
    }));

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = Object.fromEntries(FIELDS.map((f) => [f, $(`#r-${f}`).value.trim()]));
      data.password = $("#r-password").value;
      data.confirm = $("#r-confirm").value;
      data.website = $("#r-website").value;
      const errors = validate(data);
      FIELDS.forEach((f) => setError(f, errors[f]));
      $("#register-error").textContent = "";
      const first = FIELDS.find((f) => errors[f]);
      if (first) { $(`#r-${first}`).focus(); return; }

      const btn = $("#register-send");
      btn.disabled = true;
      const res = await api("/api/auth/register", { method: "POST", body: data });
      btn.disabled = false;
      if (res.ok) {
        $("#register-fields").hidden = true;
        const done = $("#register-done");
        done.hidden = false;
        done.focus();
        return;
      }
      const server = res.data && res.data.detail && res.data.detail.fields;
      if (server) {
        Object.entries(server).forEach(([f, code]) => setError(f, code));
        const f = FIELDS.find((x) => server[x]);
        if (f) $(`#r-${f}`).focus();
        return;
      }
      $("#register-error").textContent = errorText(res);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
