"use strict";
/* Contact form (the other help pages need only the shared chrome from i18n.js). */
(() => {
  const { t, api, errorText } = window.ST;
  const $ = (s) => document.querySelector(s);

  function init() {
    const form = $("#contact-form");
    if (!form) return;
    const fields = { name: $("#c-name"), email: $("#c-email"), message: $("#c-msg") };
    const status = $("#c-status");
    const fieldErr = (k, code) => {
      const el = $(`#c-${k === "message" ? "msg" : k}-err`);
      el.textContent = code ? t(`err.${code}`) : "";
      fields[k].setAttribute("aria-invalid", code ? "true" : "false");
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      status.textContent = "";
      status.className = "form-status";
      const data = {
        name: fields.name.value.trim(), email: fields.email.value.trim(), message: fields.message.value.trim(),
        topic: $("#c-topic").value, website: $("#c-website").value,
      };
      const errors = {};
      if (data.name.length < 2) errors.name = "name_required";
      if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(data.email)) errors.email = "email_invalid";
      if (data.message.length < 10) errors.message = "message_short";
      Object.keys(fields).forEach((k) => fieldErr(k, errors[k]));
      const first = Object.keys(errors)[0];
      if (first) { fields[first].focus(); return; }

      const btn = $("#c-send");
      btn.disabled = true;
      const res = await api("/api/contact", { method: "POST", body: data });
      btn.disabled = false;
      if (res.ok) {
        form.reset();
        status.textContent = t("contact.sent");
        status.classList.add("ok");
        return;
      }
      const server = res.data && res.data.detail && res.data.detail.fields;
      if (server) { Object.entries(server).forEach(([k, code]) => fieldErr(k, code)); return; }
      status.textContent = errorText(res);
      status.classList.add("err");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
