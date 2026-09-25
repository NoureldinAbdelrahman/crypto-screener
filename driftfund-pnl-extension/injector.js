/* Drift Fund PNL Dashboard — content script.
   Injects hook.js into the page, listens for captured network payloads,
   classifies them into trades / open positions / account snapshots, persists
   to storage, and renders the PNL widget + per-day calendar. */
(() => {
  if (window.__dfxInjectorInstalled) return;
  window.__dfxInjectorInstalled = true;

  /* ---------- inject main-world hook ---------- */
  try {
    const s = document.createElement("script");
    s.src = browser.runtime.getURL("hook.js");
    s.onload = () => s.remove();
    (document.documentElement || document.head || document.body).appendChild(s);
  } catch (e) {}
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      try {
        const s2 = document.createElement("script");
        s2.src = browser.runtime.getURL("hook.js");
        document.documentElement.appendChild(s2);
      } catch (e) {}
    });
  }

  /* ---------- small helpers ---------- */
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const toNum = (v) => typeof v === "string" && v.trim() !== "" && isFinite(+v) ? +v : (isFinite(v) ? +v : null);
  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === "number") return (v > 9999999999) ? v : v * 1000;
    if (typeof v === "string") {
      if (/^\d{10}(\.\d+)?$/.test(v)) return parseFloat(v) * 1000;
      if (/^\d{13}$/.test(v)) return parseFloat(v);
      const n = Date.parse(v); return isFinite(n) ? n : null;
    }
    return null;
  };
  const pick = (o, rx) => { for (const k of Object.keys(o)) if (rx.test(k)) return o[k]; return undefined; };
  const pickNumeric = (o, rx) => { for (const k of Object.keys(o)) { if (rx.test(k) && toNum(o[k]) != null) return toNum(o[k]); } return null; };
  const pickStr = (o, rx) => { for (const k of Object.keys(o)) { const v = o[k]; if (rx.test(k) && (typeof v === "string" || typeof v === "number")) return String(v); } return null; };
  const pickTime = (o) => { for (const k of Object.keys(o)) { if (/time|date|timestamp|at$/.test(k)) { const m = toMs(o[k]); if (m != null) return m; } } return null; };

  const PNL_KEY = /pnl|profit|net_result|netresult|netProfit|realized/;
  const UNREAL_KEY = /^unrealized|floating|open_pnl|openPnl/;
  const SYM_KEY = /^symbol$|^instrument$|^pair$|^ticker$|^asset$|^coin$|^code$|^dfSym$|^df_symbol$|^ctidTicket$|^name$/;
  const BAL_KEY = /^equity|^balance|^margin_balance|^marginBalance|^accountBalance|^availableBalance|^collateral$/;
  const PARENT_POS = /position/i;
  const PARENT_TRADE = /trade|order|closed|history|result|realized/i;

  /* ---------- state ---------- */
  let state = { trades: [], positions: [], account: {}, raw: [] };
  const rawCap = 25;

  function dedupeKey(t) { return t.sym + "|" + t.time + "|" + (t.pnl || 0).toFixed(2); }
  function mergeTrades(arr) {
    const seen = new Set(state.trades.map(dedupeKey));
    for (const t of arr) { const k = dedupeKey(t); if (!seen.has(k)) { seen.add(k); state.trades.push(t); } }
    state.trades.sort((a, b) => a.time - b.time);
  }

  /* ---------- classification ---------- */
  function applyRecord(o, parentKey) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const keys = Object.keys(o).join(",");
    const sym = pickStr(o, SYM_KEY);
    const pnl = pickNumeric(o, PNL_KEY);
    const unreal = pickNumeric(o, UNREAL_KEY);
    const time = pickTime(o);
    const isPosParent = PARENT_POS.test(parentKey || "");
    const isTradeParent = PARENT_TRADE.test(parentKey || "");

    if (unreal != null || isPosParent) {
      if (pnl != null || unreal != null) {
        const rec = { sym: sym || "", time, unreal: unreal != null ? unreal : 0, raw: pickNumeric(o, PNL_KEY) || 0 };
        if (rec.sym) { state.positions = state.positions.filter(p => p.sym !== rec.sym); state.positions.push(rec); }
        else state.positions.push(rec);
      }
      return;
    }
    if (pnl != null && (time != null || isTradeParent)) {
      state.trades.push({ sym: sym || "", time: time || Date.now(), pnl });
      return;
    }
    if (pnl != null && !sym) {
      /* lone pnl with no symbol/time — treat as a realized trade with no time */
      state.trades.push({ sym: "", time: time || Date.now(), pnl });
    }
    /* account snapshot: balance-ish fields */
    const bal = pickNumeric(o, BAL_KEY);
    if (bal != null && !sym) {
      const eq = pickNumeric(o, /^equity/) || bal;
      state.account = { equity: eq, balance: bal, ts: Date.now() };
    }
  }

  function classify(data, out, parentKey) {
    if (data == null) return;
    if (Array.isArray(data)) {
      for (let i = 0; i < Math.min(data.length, 3000); i++) classify(data[i], out, parentKey);
      return;
    }
    if (typeof data === "object") {
      applyRecord(data, parentKey);
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (v && (Array.isArray(v) || typeof v === "object")) classify(v, out, k);
      }
    }
  }

  function summarize(obj) {
    const s = { keys: [], types: {} };
    const scan = (v, d) => {
      if (d > 2) return;
      if (Array.isArray(v)) { if (v.length < 50) v.forEach(x => scan(x, d + 1)); return; }
      if (v && typeof v === "object") {
        for (const k of Object.keys(v)) {
          if (!s.types[k]) { s.types[k] = Array.isArray(v[k]) ? "array[" + v[k].length + "]" : typeof v[k]; s.keys.push(k); }
          scan(v[k], d + 1);
        }
      }
    };
    scan(obj, 0);
    return s;
  }

  function handlePayload(msg) {
    const { url, method = "GET", kind = "fetch", data } = msg;
    if (data == null) return;
    const before = state.trades.length;
    classify(data, state, "");
    if (state.trades.length > before) mergeTrades([]);
    const sum = summarize(data);
    const rawEntry = { ts: Date.now(), url, method, kind, keys: sum.keys.slice(0, 24), types: sum.types };
    if (state.raw.filter(r => r.bodies).length < 4) rawEntry.bodies = data;
    state.raw.push(rawEntry);
    if (state.raw.length > rawCap) state.raw.splice(0, state.raw.length - rawCap);
    persist();
    render();
    /* account for changes */
    onData();
  }

  /* ---------- storage ---------- */
  const KEY = "dfx_state_v1";
  function persist() {
    try {
      const slim = { trades: state.trades, positions: state.positions, account: state.account,
        raw: state.raw.map(({ bodies, ...r }) => r) };
      browser.storage.local.set({ [KEY]: slim }).catch(() => {});
    } catch (e) {}
  }
  (async () => {
    try {
      const got = await browser.storage.local.get(KEY);
      if (got && got[KEY]) state = { trades: [], positions: [], account: {}, raw: [], ...got[KEY] };
    } catch (e) {}
    uiInit();
  })();

  /* ---------- computations ---------- */
  function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function todayStart() { return dayStart(Date.now()); }
  function sumPnl(trades, from, to) { return trades.reduce((a, t) => (t.time >= from && t.time < to ? a + (t.pnl || 0) : a), 0); }
  function realizedOn(from, to) { return sumPnl(state.trades, from, to); }
  function unrealizedNow() { return state.positions.reduce((a, p) => a + (p.unreal || 0), 0); }
  function fmtMoney(v, signed) {
    const n = v || 0;
    const s = (signed && n > 0 ? "+" : n < 0 ? "-" : "");
    const a = Math.abs(n);
    let out;
    if (a >= 1e9) out = (a / 1e9).toFixed(2) + "B";
    else if (a >= 1e6) out = (a / 1e6).toFixed(2) + "M";
    else if (a >= 1000) out = (a / 1e3).toFixed(1) + "K";
    else if (a >= 1) out = Math.round(a).toString();
    else out = a === 0 ? "0" : a.toFixed(2);
    return (s ? s + "$" : "$") + out;
  }

  /* ================================================================
     UI (Shadow DOM)
     ================================================================ */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "Segoe UI", Inter, Roboto, Arial, sans-serif; }
    .card { position: fixed; top: 84px; right: 14px; width: 320px; z-index: 2147483647;
      background: #0b1220f2; border: 1px solid #2a3446; border-radius: 12px; color: #d1d4dc;
      font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.55); user-select: none; overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(135deg,#13203a,#0f1a2e); border-bottom: 1px solid #2a3446; cursor: move; }
    .title { font-weight: 700; color: #fff; letter-spacing: .5px; display: flex; align-items: center; gap: 6px; }
    .title .logo { width: 20px; height: 20px; border-radius: 5px; background: linear-gradient(135deg,#2962ff,#5b7cff);
      display: grid; place-items: center; color: #fff; font-size: 11px; font-weight: 800; }
    .fdot { width: 7px; height: 7px; border-radius: 50%; background: #4a5568; flex: none; transition: background .3s; }
    .fdot.on { background: #26a69a; box-shadow: 0 0 6px #26a69a; }
    .eq { margin-left: auto; color: #9aa4b5; font-size: 11px; font-weight: 600; }
    #fold { background: none; border: none; color: #9aa4b5; font-size: 14px; cursor: pointer; padding: 0 2px; }
    #fold:hover { color: #fff; }
    .body { padding: 10px 12px; }
    .today { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 8px; margin-bottom: 12px; }
    .big { background: #101a2c; border: 1px solid #233049; border-radius: 9px; padding: 8px 10px; }
    .big .v { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .big .l { display: block; color: #7d8798; font-size: 10.5px; letter-spacing: .4px; text-transform: uppercase; margin-top: 2px; }
    .pos  { color: #26a69a; } .neg { color: #ef5350; } .flat { color: #9aa4b5; }
    .hint { font-size: 11px; color: #7d8798; margin-top: -2px; margin-bottom: 10px; }
    .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .cal-head button { background: none; border: 1px solid #2a3446; color: #9aa4b5; width: 24px; height: 22px;
      border-radius: 5px; cursor: pointer; font-size: 13px; line-height: 1; }
    .cal-head button:hover { color: #fff; border-color: #3a4a68; }
    #month { font-weight: 600; color: #fff; font-size: 12px; letter-spacing: .4px; text-transform: uppercase; }
    .dow { display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; margin-bottom: 3px; }
    .dow span { text-align: center; color: #6b7484; font-size: 9px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; }
    .grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; }
    .day { min-height: 30px; border-radius: 6px; border: 1px solid #1e2839; background: #0d1524;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 2px; }
    .day .d { font-size: 9.5px; color: #8b94a5; font-weight: 600; }
    .day .p { font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .day.up { border-color: rgba(38,166,154,.4); background: rgba(38,166,154,.09); }
    .day.up .p { color: #26a69a; }
    .day.dn { border-color: rgba(239,83,80,.4); background: rgba(239,83,80,.09); }
    .day.dn .p { color: #ef5350; }
    .day.today { outline: 2px solid #2962ff; outline-offset: -1px; }
    .day.muted { opacity: .35; }
    .lgd { display: flex; gap: 14px; margin-top: 8px; font-size: 10px; color: #7d8798; }
    .lgd i { width: 8px; height: 8px; border-radius: 3px; display: inline-block; margin-right: 4px; vertical-align: -1px; }
    .dbg { margin-top: 10px; border-top: 1px solid #233049; padding-top: 8px; }
    .dbg summary { cursor: pointer; color: #7d8798; font-size: 11px; }
    .dbg pre { margin-top: 6px; background: #0a0f1a; border: 1px solid #1e2839; border-radius: 6px; max-height: 160px;
      overflow: auto; padding: 6px; font-size: 10px; color: #9aa4b5; white-space: pre-wrap; word-break: break-all; }
    #copy { margin-top: 6px; background: #1b2942; border: 1px solid #2a3446; color: #d1d4dc; border-radius: 5px;
      padding: 4px 8px; font-size: 11px; cursor: pointer; }
    #copy:hover { border-color: #2962ff; color: #fff; }
    .twrap { margin-top: 10px; border-top: 1px solid #233049; padding-top: 8px; max-height: 140px; overflow: auto; }
    .trow { display: flex; justify-content: space-between; padding: 3px 2px; font-size: 11px; border-bottom: 1px solid #141d2e; }
    .trow b { font-variant-numeric: tabular-nums; }
    .nothing { color: #6b7484; font-size: 11px; text-align: center; padding: 8px 0; }
  `;

  let root, els = {}, monthCursor = new Date(), collapsed = false, dragging = false, offX = 0, offY = 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function uiInit() {
    root = document.createElement("div");
    root.id = "dfx-root";
    const sh = root.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${CSS}</style>`;
    const card = el("div", "card");
    card.innerHTML = `
      <div class="head"><span id="dfx-src" class="fdot" title="waiting for data…"></span><span class="title"><span class="logo">D</span> PNL</span>
        <span class="eq" id="eq">EQ —</span><button id="fold" title="Minimize">▾</button></div>
      <div class="body"><div class="today">
          <div class="big"><span class="v" id="vR">—</span><span class="l">Realized today</span></div>
          <div class="big"><span class="v" id="vU">—</span><span class="l">Unrealized</span></div>
        </div>
        <div class="hint" id="hint"></div>
        <div class="cal-head"><button id="prev">‹</button><span id="month">—</span><button id="next">›</button></div>
        <div class="dow">${["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => `<span>${d}</span>`).join("")}</div>
        <div class="grid" id="grid"></div>
        <div class="twrap" id="trades" style="display:none"></div>
        <div class="lgd"><span><i style="background:#26a69a"></i>Realized</span><span><i style="background:#2962ff"></i>Today</span></div>
        <details class="dbg"><summary>Debug · raw capture</summary>
          <pre id="raw">(no captures yet — navigate the trading page; positions/history/trades tabs refresh data)</pre>
          <button id="copy">Copy samples</button>
        </details></div>`;
    sh.appendChild(card);

    els = { eq: sh.getElementById("eq"), vR: sh.getElementById("vR"), vU: sh.getElementById("vU"),
      hint: sh.getElementById("hint"), month: sh.getElementById("month"), grid: sh.getElementById("grid"),
      trades: sh.getElementById("trades"), raw: sh.getElementById("raw"),
      fold: sh.getElementById("fold"), prev: sh.getElementById("prev"), next: sh.getElementById("next"),
      copy: sh.getElementById("copy") };
    /* drag */
    card.querySelector(".head").addEventListener("mousedown", e => {
      if (e.target.closest("#fold")) return;
      dragging = true; offX = e.clientX - card.getBoundingClientRect().left; offY = e.clientY - card.getBoundingClientRect().top;
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      const nx = Math.max(0, Math.min(innerWidth - card.offsetWidth, e.clientX - offX));
      const ny = Math.max(0, Math.min(innerHeight - 40, e.clientY - offY));
      card.style.left = nx + "px"; card.style.top = ny + "px"; card.style.right = "auto";
    });
    window.addEventListener("mouseup", () => dragging = false);
    els.fold.addEventListener("click", () => {
      collapsed = !collapsed;
      card.querySelector(".body").style.display = collapsed ? "none" : "";
      els.fold.textContent = collapsed ? "▸" : "▾";
    });
    els.prev.addEventListener("click", () => { monthCursor.setMonth(monthCursor.getMonth() - 1); render(); });
    els.next.addEventListener("click", () => { monthCursor.setMonth(monthCursor.getMonth() + 1); render(); });
    els.copy.addEventListener("click", copySamples);
    els.grid.addEventListener("click", e => {
      const b = e.target.closest("[data-day]"); if (!b) return;
      showDayTrades(+b.dataset.day);
    });
    (document.body || document.documentElement).appendChild(root);
    render();
  }

  function clsFor(v) { return v > 0 ? "pos" : v < 0 ? "neg" : "flat"; }

  function render() {
    if (!root) return;
    const t0 = todayStart(), t1 = t0 + 86400000;
    const rToday = realizedOn(t0, t1);
    const uNow = unrealizedNow();
    const nToday = state.trades.filter(t => t.time >= t0 && t.time < t1).length;
    const set = (id, v, sign) => { const e = els[id]; e.textContent = fmtMoney(v, sign); e.className = "v " + clsFor(v); };
    set("vR", rToday, true); set("vU", uNow, true);
    els.eq.textContent = "EQ " + fmtMoney(state.account.equity || 0, false) +
      (state.account.balance ? " · BAL " + fmtMoney(state.account.balance, false) : "");
    els.hint.textContent = nToday ? nToday + " trade" + (nToday > 1 ? "s" : "") + " closed today" : "No trades captured yet this session";
    els.month.textContent = monthCursor.toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
    renderCalendar();
    renderRaw();
  }

  function renderCalendar() {
    const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
    const first = new Date(y, m, 1);
    const dow = (first.getDay() + 6) % 7; /* Monday-first */
    const daysIn = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < dow; i++) cells.push(el("div", "day muted", ""));
    for (let d = 1; d <= daysIn; d++) {
      const dayMs = new Date(y, m, d).getTime();
      const from = dayMs, to = dayMs + 86400000;
      const pnl = realizedOn(from, to);
      const cell = el("div", "day " + clsFor(pnl) + ((d === new Date().getDate() && m === new Date().getMonth() && y === new Date().getFullYear()) ? " today" : ""));
      cell.dataset.day = dayMs;
      cell.appendChild(el("span", "d", String(d)));
      if (state.trades.some(t => t.time >= from && t.time < to)) cell.appendChild(el("span", "p", fmtMoney(pnl, true)));
      cells.push(cell);
    }
    els.grid.replaceChildren(...cells);
  }

  function showDayTrades(dayMs) {
    const from = dayMs, to = dayMs + 86400000;
    const list = state.trades.filter(t => t.time >= from && t.time < to);
    els.trades.style.display = list.length ? "" : "none";
    const wrap = els.trades;
    wrap.replaceChildren(...list.slice(-200).reverse().map(t => {
      const r = el("div", "trow");
      r.appendChild(el("span", "", (t.sym || "—") + " · " + new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
      const b = el("b", clsFor(t.pnl), fmtMoney(t.pnl, true)); r.appendChild(b);
      return r;
    }));
  }

  function renderRaw() {
    if (!els || !state.raw.length) return;
    const lines = state.raw.slice(-12).map(r =>
      "[" + method(r.method) + "] " + r.url + "  keys=" + r.keys.slice(0, 12).join(","));
    els.raw.textContent = lines.join("\n");
  }
  const method = (m) => (m || "?").toUpperCase().slice(0, 4);

  function copySamples() {
    const out = state.raw.map(r => ({ url: r.url, method: r.method, keys: r.keys, types: r.types, body: r.bodies }));
    const txt = JSON.stringify(out.filter(x => x.body != null).slice(-6), null, 2);
    try { navigator.clipboard.writeText(txt).then(() => { els.copy.textContent = "Copied!"; setTimeout(() => els.copy.textContent = "Copy samples", 1200); }); }
    catch (e) {}
  }

  let lastRender = 0;
  function renderThrottled() {
    const now = Date.now();
    if (now - lastRender > 250) { render(); lastRender = now; }
  }

  /* ---------- live feed: after first data, refresh calendar/today ---------- */
  let firstDataAt = null;
  function onData() {
    if (!firstDataAt) { firstDataAt = Date.now(); render(); }
    renderThrottled();
  }

  /* ---------- messages from the page hook ---------- */
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || !e.data.__dfx) return;
    handlePayload(e.data);
  });

  /* ---------- messages from the background webRequest capture ---------- */
  try {
    browser.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.__dfx) { srcOn(); handlePayload(msg); }
    });
  } catch (e) {}

  function srcOn() {
    const el = document.getElementById("dfx-src");
    if (el) { el.classList.add("on"); el.title = "live data feed OK"; }
  }
  setInterval(() => { if (state.trades.length || state.positions.length || state.raw.length) srcOn(); }, 2000);

  /* periodic local tick (open positions may keep reporting in later payloads) */
  setInterval(() => { if (state.trades.length || state.positions.length) renderThrottled(); }, 5000);
})();