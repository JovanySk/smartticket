"use strict";
/* Login form + the sorting-cabinet loop on the left panel. */
(() => {
  const { t, api, errorText, reduced } = window.ST;
  const $ = (s, r = document) => r.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- form ---------- */
  function initForm() {
    const form = $("#login-form");
    const email = $("#email");
    const pw = $("#password");
    const err = $("#login-error");
    const toggle = $("#pw-toggle");

    toggle.addEventListener("click", () => {
      const show = pw.type === "password";
      pw.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(show));
      toggle.dataset.i18n = show ? "login.hide" : "login.show";
      toggle.textContent = t(toggle.dataset.i18n);
    });
    $("#forgot").addEventListener("click", (e) => {
      const note = $("#forgot-note");
      note.hidden = !note.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!note.hidden));
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      [email, pw].forEach((i) => i.removeAttribute("aria-invalid"));
      if (!email.value.trim() || !pw.value) {
        err.textContent = t("err.loginEmpty");
        (email.value.trim() ? pw : email).setAttribute("aria-invalid", "true");
        (email.value.trim() ? pw : email).focus();
        return;
      }
      const btn = $("#enter");
      btn.disabled = true;
      const res = await api("/api/auth/login", { method: "POST", body: { email: email.value.trim(), password: pw.value, remember: $("#remember").checked } });
      if (res.ok) {
        window.location.assign(res.data.must_change_password ? "/panel/cuenta" : res.data.redirect || "/panel");
        return;
      }
      btn.disabled = false;
      err.textContent = errorText(res);
      pw.value = "";
      pw.focus();
    });
  }

  /* ---------- cabinet loop (~12 s): drop, glow, stamp, slide to cubby, fade; x3 then pause ---------- */
  const CUBBY_X = { 1: 0.178, 2: 0.5, 3: 0.824 };
  const LANE_TOP = 0.255;
  const CUBBY_TOP = 0.56;

  async function runTicket(el, box) {
    const W = box.clientWidth, H = box.clientHeight;
    const dx = (CUBBY_X[el.dataset.to] - 0.5) * W;
    const dy = (CUBBY_TOP - LANE_TOP) * H;
    const stamp = $(".fly-stamp", el);
    const base = "translate(-50%, 0)";
    el.classList.remove("glow");
    stamp.style.opacity = "0";
    // 1. drop from the intake slot into the empty lane, then settle
    await el.animate([
      { transform: "translate(-50%, -70%) scale(.96)", opacity: 0, clipPath: "inset(70% 0 0 0)" },
      { transform: "translate(-50%, 6%)", opacity: 1, clipPath: "inset(0 0 0 0)" },
    ], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished;
    await el.animate([{ transform: "translate(-50%, 6%)", opacity: 1 }, { transform: base, opacity: 1 }], { duration: 140, easing: "ease-out", fill: "forwards" }).finished;
    // 2. teal border glow (no scan line across the text)
    el.classList.add("glow");
    await wait(420);
    el.classList.remove("glow");
    // 3. stamp lands
    await stamp.animate([
      { transform: "rotate(-6deg) scale(1.7)", opacity: 0 },
      { transform: "rotate(-6deg) scale(1)", opacity: 1 },
    ], { duration: 200, easing: "ease-in", fill: "forwards" }).finished;
    await wait(380);
    // 4. slide into its cubby, 5. shrink and fade inside
    await el.animate([{ transform: base }, { transform: `translate(calc(-50% + ${dx}px), ${dy}px)` }],
      { duration: 600, easing: "ease-in-out", fill: "forwards" }).finished;
    await el.animate([
      { transform: `translate(calc(-50% + ${dx}px), ${dy}px) scale(1)`, opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), ${dy + H * 0.04}px) scale(.45)`, opacity: 0 },
    ], { duration: 280, easing: "ease-in", fill: "forwards" }).finished;
    el.getAnimations().forEach((a) => a.cancel());
    stamp.getAnimations().forEach((a) => a.cancel());
    el.style.opacity = "0";
    await wait(700);
  }

  async function loop(box, tickets) {
    for (;;) {
      for (const el of tickets) {
        if (document.hidden) { await wait(500); continue; }
        await runTicket(el, box);
      }
      await wait(1800);
    }
  }

  function initCabinet() {
    const box = $(".cabinet");
    if (!box || box.offsetParent === null) return; // hidden on small screens
    const tickets = [...box.querySelectorAll(".flying")];
    if (reduced() || !Element.prototype.animate) {
      tickets[0].classList.add("rest");
      return;
    }
    loop(box, tickets);
  }

  document.addEventListener("DOMContentLoaded", () => { initForm(); initCabinet(); });
})();
