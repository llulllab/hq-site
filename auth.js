// HQ shared auth + account UI. Self-mounts a header account chip (#hq-acct) and a
// sign-in modal. All API calls are credentialed (cookie session set by the gate).
(function () {
  "use strict";
  var API = "https://api.h-q.io";
  var listeners = [];
  var checkoutBusy = false;
  var pendingGo = null, checkoutGen = 0, inflight = [], signingOut = false;
  function httpsUrl(u) { try { var x = new URL(u); return x.protocol === "https:" && (x.hostname === "stripe.com" || x.hostname.slice(-11) === ".stripe.com"); } catch (e) { return false; } }
  function leaveTo(u, delay, gen) {
    pendingGo = setTimeout(function () {
      pendingGo = null;
      if (gen !== checkoutGen) return;
      if (!HQ.account) { checkoutBusy = false; if (noteBox) hideNote(); return; }
      location.href = u;
      setTimeout(function () { if (gen === checkoutGen) { checkoutBusy = false; if (noteBox) hideNote(); } }, 15000);
    }, delay);
  }
  function cancelCheckout() {
    checkoutGen++;
    if (pendingGo) { clearTimeout(pendingGo); pendingGo = null; }
    inflight.forEach(function (c) { try { c.abort(); } catch (e) {} });
    inflight = [];
    if (noteBox) hideNote();
    checkoutBusy = false;
  }
  function timed(opts, ms) { if (typeof AbortController === "undefined") { var t0, dl = new Promise(function (res, rej) { t0 = setTimeout(function () { rej(new Error("timeout")); }, ms); }); dl.catch(function () {}); opts.hqDeadline = dl; return { opts: opts, done: function () { clearTimeout(t0); } }; } var c = new AbortController(); inflight.push(c); var t = setTimeout(function () { c.abort(); }, ms); opts.signal = c.signal; return { opts: opts, done: function () { clearTimeout(t); inflight = inflight.filter(function (x) { return x !== c; }); } }; }

  // client-side mirror of the gate's cost logic (display only; server is authoritative)
  function estTokens(t) { return Math.ceil((t ? t.length : 0) / 4); }
  function estCredits(panel, text) { var b = Math.max(1, Math.ceil(estTokens(text) / 10000)); return panel === "chamber" ? b * 2 : b; }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    var dl = opts.hqDeadline;
    if (!dl) return fetch(API + path, opts);
    delete opts.hqDeadline;
    return Promise.race([fetch(API + path, opts), dl]).then(function (r) { var j = r.json; r.json = function () { return Promise.race([j.call(r), dl]); }; return r; });
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
    async signout() {
      if (signingOut) return; cancelCheckout(); signingOut = true;
      var btn = document.getElementById("hq-out"); if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
      var ok = false, tl = timed({ method: "POST" }, 10000);
      try { var r = await api("/v1/logout", tl.opts); if (r && r.ok) { var jl = await r.json(); ok = !!(jl && jl.ok === true); } } catch (e) { ok = false; } finally { tl.done(); }
      if (!ok) {
        // not confirmed: only the server's own "no session" answer counts as signed out; anything else means still signed in here
        var still = true, ta = timed({}, 5000);
        try { var ra = await api("/v1/account", ta.opts); if (ra.status === 401) { var jb = await ra.json(); if (jb && jb.error === "not_signed_in") still = false; } } catch (e) {} finally { ta.done(); }
        if (still) { signingOut = false; cancelCheckout(); render(); showMsg(SIGNOUT_FAILED); return; }
      }
      signingOut = false; cancelCheckout(); this.account = null; render(); listeners.forEach(function (cb) { cb(null); });
    },
    async checkout(plan, interval) {
      if (!this.account) { openModal("Sign in first, then choose a plan."); return; }
      if (checkoutBusy || signingOut) return;
      checkoutBusy = true;
      var going = false, gen = checkoutGen, self = this, tc = null, tk = null;
      var stale = function () { return gen !== checkoutGen || !self.account || signingOut; };
      try {
        // record per-product Terms acceptance first (server is authoritative for the version)
        tc = timed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: "hq", email: this.account.email, accepted: true, locale: (navigator.language || "").slice(0, 5) }) }, 20000);
        var cr = await api("/v1/consent", tc.opts);
        var cj = await cr.json().catch(function () { return {}; }); tc.done();
        if (stale()) return;
        if (!cj.consent_id) { alert("Could not record your acceptance of the Terms. Please try again."); return; }
        tk = timed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan, interval: interval || "monthly", consent_id: cj.consent_id }) }, 20000);
        var r = await api("/v1/checkout", tk.opts);
        var j = await r.json(); tk.done();
        if (stale()) return;
        if (j.url && !httpsUrl(j.url)) j = { error: "bad_url" };
        if (j.url && j.portal) {
          going = true;
          leaveTo(j.url, 5000, gen);
          try { showNote(gen); } catch (e) {}
          return;
        }
        if (j.url) { going = true; leaveTo(j.url, 0, gen); return; }
        alert((j.error && j.error.indexOf("consent") === 0) ? "Please accept the Terms of Service to continue." : (j.error === "unknown_plan" ? "That plan is not available yet." : "Could not start checkout. Please try again."));
      } catch (e) { if (!stale()) alert("Could not reach checkout. Please try again."); }
      finally { if (tc) tc.done(); if (tk) tk.done(); if (!going && gen === checkoutGen) checkoutBusy = false; }
    },
    async portal() {
      if (signingOut || checkoutBusy) return;
      if (!this.account) { openModal(); return; }
      checkoutBusy = true;
      var going = false, gen = checkoutGen, self = this, tp = timed({ method: "POST" }, 20000);
      var stale = function () { return gen !== checkoutGen || !self.account || signingOut; };
      try {
        var r = await api("/v1/portal", tp.opts);
        var j = await r.json().catch(function () { return {}; });
        if (stale()) return;
        if (j.url && httpsUrl(j.url)) { going = true; location.href = j.url; setTimeout(function () { if (gen === checkoutGen) checkoutBusy = false; }, 15000); return; }
        alert("Could not open the billing portal. Please try again.");
      } catch (e) { if (!stale()) alert("Could not reach the billing portal. Please try again."); }
      finally { tp.done(); if (!going && gen === checkoutGen) checkoutBusy = false; }
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
  var noteBox;
  function showNote(gen) {
    if (!noteBox) {
      noteBox = document.createElement("div");
      noteBox.className = "hqm";
      noteBox.setAttribute("role", "status");
      noteBox.setAttribute("aria-live", "polite");
      noteBox.innerHTML = '<div class="box"><p id="hqn-msg" style="margin:0;color:#C6C9CE;font-size:.95rem"></p></div>';
      document.body.appendChild(noteBox);
    }
    noteBox.classList.add("on");
    setTimeout(function () {
      if (gen !== checkoutGen || !noteBox.classList.contains("on")) return;
      noteBox.querySelector("#hqn-msg").innerHTML = 'You already have an HQ plan. To change it, write to <a href="mailto:contact@llulllab.com" style="color:#9B7CFF">contact@llulllab.com</a>. Opening your billing page.';
    }, 60);
  }
  function hideNote() { noteBox.classList.remove("on"); noteBox.querySelector("#hqn-msg").textContent = ""; }
  var SIGNOUT_FAILED = "We could not sign you out. You are still signed in on this device. Please check your connection and try again. If it keeps failing, clear this site's cookies in your browser settings. Sessions also end on their own after 7 days.";
  var msgBox;
  function showMsg(text) {
    if (!msgBox) {
      msgBox = document.createElement("div");
      msgBox.className = "hqm";
      msgBox.setAttribute("role", "alertdialog");
      msgBox.setAttribute("aria-modal", "true");
      msgBox.setAttribute("aria-labelledby", "hqx-msg");
      msgBox.innerHTML = '<div class="box"><p id="hqx-msg" style="margin:0 0 16px;color:#C6C9CE;font-size:.95rem;line-height:1.5"></p><div class="act"><button class="x" id="hqx-ok">OK</button></div></div>';
      document.body.appendChild(msgBox);
      msgBox.querySelector("#hqx-ok").addEventListener("click", closeMsg);
      msgBox.addEventListener("click", function (e) { if (e.target === msgBox) closeMsg(); });
      // the only control is OK: keep keyboard focus inside the dialog, Escape closes it
      msgBox.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); closeMsg(); }
        else if (e.key === "Tab") { e.preventDefault(); msgBox.querySelector("#hqx-ok").focus(); }
      });
    }
    msgBox.querySelector("#hqx-msg").textContent = text;
    msgBox.classList.add("on");
    [].forEach.call(document.body.children, function (el) { if (el !== msgBox) el.inert = true; });   // background out of reach while the dialog is open
    setTimeout(function () { msgBox.querySelector("#hqx-ok").focus(); }, 30);
  }
  function closeMsg() {
    if (!msgBox) return;
    msgBox.classList.remove("on");
    [].forEach.call(document.body.children, function (el) { el.inert = false; });
    var b = document.getElementById("hq-out"); if (b) b.focus();
  }
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    cancelCheckout();
    if (signingOut) { signingOut = false; render(); }   // a page restored from the back/forward cache must not stay stuck in "signing out"
    if (msgBox && msgBox.classList.contains("on")) closeMsg();
  });
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
