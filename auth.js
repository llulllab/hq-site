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
        var r = await api("/v1/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan, interval: interval || "monthly" }) });
        var j = await r.json();
        if (j.url) { location.href = j.url; return; }
        alert(j.error === "unknown_plan" ? "That plan is not available yet." : "Could not start checkout. Please try again.");
      } catch (e) { alert("Could not reach checkout. Please try again."); }
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
    "#hq-acct{font-family:'Space Grotesk',system-ui,sans-serif;font-size:.8rem;display:inline-flex;align-items:center;gap:10px}",
    "#hq-acct .cr{color:#a78bfa}",
    "#hq-acct button,#hq-acct a.b{font-family:inherit;font-size:.78rem;background:none;border:1px solid rgba(167,139,250,.28);color:#c8c8c8;border-radius:3px;padding:5px 12px;cursor:pointer;text-decoration:none}",
    "#hq-acct button.primary{background:#a78bfa;color:#17111f;border-color:#a78bfa;font-weight:600}",
    "#hq-acct .em{color:#8a8a90}",
    ".hqm{position:fixed;inset:0;background:rgba(6,6,8,.72);display:none;align-items:center;justify-content:center;z-index:9999}",
    ".hqm.on{display:flex}",
    ".hqm .box{background:#141416;border:1px solid rgba(255,255,255,.12);border-radius:6px;max-width:420px;width:calc(100% - 40px);padding:28px;font-family:'Space Grotesk',system-ui,sans-serif;color:#c8c8c8}",
    ".hqm h3{font-family:'Spectral',Georgia,serif;font-weight:500;color:#f4f4f5;margin:0 0 6px;font-size:1.3rem}",
    ".hqm p{font-size:.86rem;color:#8a8a90;margin:0 0 16px;line-height:1.5}",
    ".hqm input{width:100%;background:#0e0e10;color:#f4f4f5;border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:11px 13px;font-family:inherit;font-size:.9rem}",
    ".hqm .act{display:flex;gap:10px;margin-top:14px}",
    ".hqm button{font-family:inherit;font-weight:600;font-size:.85rem;border:none;border-radius:4px;padding:10px 18px;cursor:pointer}",
    ".hqm .go{background:#a78bfa;color:#17111f}.hqm .x{background:none;color:#8a8a90;border:1px solid rgba(255,255,255,.14)}",
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
      '<button id="hq-out">Sign out</button>';
    if (host.querySelector("#hq-up")) host.querySelector("#hq-up").addEventListener("click", function () { location.href = "/#pricing"; });
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
