/* Drift Fund PNL — main-world hook.
   Runs in the page's own JS context and watches the requests the app makes,
   so the extension sees exactly what the logged-in session sees.
   Captured payloads are relayed to the extension content script via postMessage. */
(() => {
  if (window.__dfxHookInstalled) return;
  window.__dfxHookInstalled = true;

  const send = (url, method, kind, data) => {
    try { window.postMessage({ __dfx: true, url, method, kind, data }, "*"); } catch (e) {}
  };

  /* --- filter: only keep payloads that are interesting --- */
  const NOISE = /\/api\/(prices|fx-prices|broadcast|push\/register)|affiliate/;
  const INTEREST = /trade|position|account|histor|order|stat(istic)?s?|pnl|equity|balance|performance|result|margin/;

  const parseBody = (t) => {
    if (t == null || t === "") return null;
    if (typeof t === "string") { try { return JSON.parse(t); } catch (e) { return null; } }
    return t;
  };

  const looksInteresting = (url, obj) => {
    if (NOISE.test(url)) return false;
    if (INTEREST.test(url)) return true;
    /* heuristics on the payload: any pnl/profit/trade-ish key */
    if (obj == null) return false;
    const hits = [];
    const scan = (v, d) => {
      if (d > 3 || hits.length >= 3) return;
      if (Array.isArray(v)) { v.slice(0, 200).forEach(x => scan(x, d + 1)); return; }
      if (v && typeof v === "object") {
        for (const k of Object.keys(v)) {
          if (/pnl|profit|equity|margin|trad|position|order|fill|netResult|realized/.test(k)) hits.push(k);
          scan(v[k], d + 1);
        }
      }
    };
    scan(obj, 0);
    return hits.length > 0;
  };

  /* --- capture fetch --- */
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    const method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
    const p = origFetch.apply(this, args);
    if (url && (url.indexOf(location.origin) === 0 || url.indexOf("/") === 0 || url.indexOf("supabase.co/rest") > -1)) {
      p.then(r => {
        if (!r) return;
        const c = r.clone();
        c.text().then(t => {
          const obj = parseBody(t);
          if (looksInteresting(url, obj)) send(url, method, "fetch", obj);
        }).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  /* --- capture XHR --- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dfxUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener("loadend", () => {
      try {
        const url = this.__dfxUrl || "";
        if (!url || this.status < 200 || this.status >= 300) return;
        if (url.indexOf(location.origin) !== 0 && url.indexOf("/") !== 0 && url.indexOf("supabase.co/rest") === -1) return;
        const obj = parseBody(this.responseText);
        if (looksInteresting(url, obj)) send(url, (this.__dfxMethod || "GET"), "xhr", obj);
      } catch (e) {}
    });
    this.__dfxMethod = arguments.length && typeof arguments[0] === "string" ? arguments[0] : "GET";
    return origSend.apply(this, a);
  };

  /* --- capture Supabase Realtime frames (live trade pushes) --- */
  if (window.WebSocket) {
    const OrigWS = window.WebSocket;
    const WSPatch = function (url, ...rest) {
      const self = new OrigWS(url, ...rest);
      if (typeof url === "string" && url.indexOf("supabase.co/realtime") > -1) {
        self.addEventListener("message", ev => {
          try {
            const frame = parseBody(ev.data);
            if (!frame) return;
            const payload = frame.payload != null ? frame.payload : frame;
            if (looksInteresting(url, payload)) send(url, "WS", "realtime", payload);
          } catch (e) {}
        });
      }
      return self;
    };
    WSPatch.prototype = OrigWS.prototype;
    WSPatch.CONNECTING = OrigWS.CONNECTING;
    WSPatch.OPEN = OrigWS.OPEN;
    WSPatch.CLOSING = OrigWS.CLOSING;
    WSPatch.CLOSED = OrigWS.CLOSED;
    window.WebSocket = WSPatch;
  }
})();