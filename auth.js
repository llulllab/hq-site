// HQ shared auth + account UI. Self-mounts a header account chip (#hq-acct) and a
// sign-in modal. All API calls are credentialed (cookie session set by the gate).
(function () {
  "use strict";
  var API = "https://api.h-q.io";
  var listeners = [];

  // client-side mirror of the gate's cost logic (display only; server is authoritative)
  function estTokens(t) { return Math.ceil((t ? t.length : 0) / 4); }
  function estCredits(panel, text) { var b = Math.max(1, Math.ceil(estTokens(text) / 10000)); return panel === "chamber" ? b * 2 : b; }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    return fetch(API + path, opts);
  }

  var HQ = {
    API: API, account: null,
    estCredits: estCredits,
    onChange: function (cb) { listeners.push(cb); if (this._loaded) cb(this.account); },
    async refresh() {
      try {
        var r = await api("/v1/account");
        this.account = r.ok ? await r.json() : null;
      } catch (e) { this.account = null; }
      this._loaded = true; render(); listeners.forEach(function (cb) { cb(HQ.account); });
      return this.account;
    },
    promptSignin: function (msg) { openModal(msg); },
    async signout() { try { await api("/v1/logout", { method: "POST" }); } catch (e) {} this.account = null; render(); listeners.forEach(function (cb) { cb(null); }); },
    async checkout(plan, interval) {
      if (!this.account) { openModal("Sign in first, then choose a plan."); return; }
      try {
        // record per-product Terms acceptance first (server is authoritative for the version)
        var cr = await api("/v1/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: "hq", email: this.account.email, accepted: true, locale: (navigator.language || "").slice(0, 5) }) });
        var cj = await cr.json().catch(function () { return {}; });
        if (!cj.consent_id) { alert("Could not record your acceptance of the Terms. Please try again."); return; }
        var r = await api("/v1/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan, interval: interval || "monthly", consent_id: cj.consent_id }) });
        var j = await r.json();
        if (j.url) { location.href = j.url; return; }
        alert((j.error && j.error.indexOf("consent") === 0) ? "Please accept the Terms of Service to continue." : (j.error === "unknown_plan" ? "That plan is not available yet." : "Could not start checkout. Please try again."));
      } catch (e) { alert("Could not reach checkout. Please try again."); }
    },
    async portal() {
      if (!this.account) { openModal(); return; }
      try {
        var r = await api("/v1/portal", { method: "POST" });
        var j = await r.json().catch(function () { return {}; });
        if (j.url) { location.href = j.url; return; }
        alert("Could not open the billing portal. Please try again.");
      } catch (e) { alert("Could not reach the billing portal. Please try again."); }
    },
    async sendLink(email) {
      var r = await api("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email }) });
      return r.json().catch(function () { return { error: "bad_response" }; }).then(function (j) { return { ok: r.ok, j: j }; });
    }
  };
  window.HQ = HQ;

  // ---- styles ----
  var css = document.createElement("style");
  css.textContent = [
    "#hq-acct{font-family:'Inter',system-ui,sans-serif;font-size:.8rem;display:inline-flex;align-items:center;gap:10px}",
    "#hq-acct .cr{color:#9B7CFF;font-family:'IBM Plex Mono',monospace;font-size:.72rem}",
    "#hq-acct button,#hq-acct a.b{font-family:inherit;font-size:.78rem;background:none;border:1px solid rgba(155,124,255,.30);color:#C6C9CE;border-radius:5px;padding:5px 12px;cursor:pointer;text-decoration:none}",
    "#hq-acct button.primary{background:#9B7CFF;color:#120b22;border-color:#9B7CFF;font-weight:600}",
    "#hq-acct .em{color:#8A8F98}",
    ".hqm{position:fixed;inset:0;background:rgba(4,5,7,.74);display:none;align-items:center;justify-content:center;z-index:9999}",
    ".hqm.on{display:flex}",
    ".hqm .box{background:#111318;border:1px solid #2A2E38;border-radius:8px;max-width:420px;width:calc(100% - 40px);padding:28px;font-family:'Inter',system-ui,sans-serif;color:#C6C9CE}",
    ".hqm h3{font-weight:600;letter-spacing:-.01em;color:#F2F3F5;margin:0 0 6px;font-size:1.2rem}",
    ".hqm p{font-size:.86rem;color:#8A8F98;margin:0 0 16px;line-height:1.5}",
    ".hqm input{width:100%;background:#08090B;color:#F2F3F5;border:1px solid #2A2E38;border-radius:5px;padding:11px 13px;font-family:inherit;font-size:.9rem}",
    ".hqm .act{display:flex;gap:10px;margin-top:14px}",
    ".hqm button{font-family:inherit;font-weight:600;font-size:.85rem;border:none;border-radius:5px;padding:10px 18px;cursor:pointer}",
    ".hqm .go{background:#9B7CFF;color:#120b22}.hqm .x{background:none;color:#8A8F98;border:1px solid #2A2E38}",
    ".hqm .note{font-size:.82rem;margin-top:12px;min-height:1.1em}",
    ".hqm .note.ok{color:#8fc7a0}.hqm .note.err{color:#e08b8b}"
  ].join("");
  document.head.appendChild(css);

  // ---- modal ----
  var modal;
  function buildModal() {
    modal = document.createElement("div");
    modal.className = "hqm";
    modal.innerHTML =
      '<div class="box"><h3>Sign in to HQ</h3>' +
      '<p id="hqm-msg">Enter your email and we will send you a one-time sign-in link. No password.</p>' +
      '<input id="hqm-email" type="email" placeholder="you@work.com" autocomplete="email">' +
      '<div class="act"><button class="go" id="hqm-send">Email me a link</button><button class="x" id="hqm-cancel">Cancel</button></div>' +
      '<div class="note" id="hqm-note"></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.classList.remove("on"); });
    modal.querySelector("#hqm-cancel").addEventListener("click", function () { modal.classList.remove("on"); });
    modal.querySelector("#hqm-send").addEventListener("click", doSend);
    modal.querySelector("#hqm-email").addEventListener("keydown", function (e) { if (e.key === "Enter") doSend(); });
  }
  async function doSend() {
    var email = modal.querySelector("#hqm-email").value.trim();
    var note = modal.querySelector("#hqm-note");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { note.className = "note err"; note.textContent = "Enter a valid email."; return; }
    note.className = "note"; note.textContent = "Sending...";
    var res = await HQ.sendLink(email);
    if (res.ok) { note.className = "note ok"; note.textContent = "Check your inbox for the sign-in link. It expires in 15 minutes."; }
    else {
      note.className = "note err";
      note.textContent = res.j && res.j.error === "disposable_email" ? "Please use a real work or personal email."
        : res.j && res.j.error === "signup_rate_limited" ? "Too many attempts. Try again later."
        : "Could not send the link. Check the address and try again.";
    }
  }
  function openModal(msg) {
    if (!modal) buildModal();
    modal.querySelector("#hqm-msg").textContent = msg || "Enter your email and we will send you a one-time sign-in link. No password.";
    modal.querySelector("#hqm-note").textContent = "";
    modal.classList.add("on");
    setTimeout(function () { modal.querySelector("#hqm-email").focus(); }, 30);
  }

  // ---- header chip ----
  function render() {
    var host = document.getElementById("hq-acct");
    if (!host) return;
    var a = HQ.account;
    if (!a) { host.innerHTML = '<button id="hq-signin">Sign in</button>'; host.querySelector("#hq-signin").addEventListener("click", function () { openModal(); }); return; }
    var plan = a.plan === "trial" ? "trial" : a.plan;
    host.innerHTML = '<span class="em">' + esc(a.email) + '</span><span class="cr">' + a.credits + ' cr</span>' +
      (a.plan === "pro" ? "" : '<button class="primary" id="hq-up">Upgrade</button>') +
      (a.manageable ? '<button id="hq-manage">Manage</button>' : "") +
      '<button id="hq-out">Sign out</button>';
    if (host.querySelector("#hq-up")) host.querySelector("#hq-up").addEventListener("click", function () { location.href = "/#pricing"; });
    if (host.querySelector("#hq-manage")) host.querySelector("#hq-manage").addEventListener("click", function () { HQ.portal(); });
    host.querySelector("#hq-out").addEventListener("click", function () { HQ.signout(); });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- boot ----
  function boot() {
    HQ.refresh();
    // if we just returned from a magic link, clean the URL
    var p = new URLSearchParams(location.search);
    if (p.get("signin") === "ok") { history.replaceState({}, "", location.pathname + location.hash); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
