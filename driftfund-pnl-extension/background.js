/* Drift Fund PNL Dashboard — background worker.
   Captures the app's own `/api/*` and Supabase REST responses (the same ones the
   logged-in page makes) using the webRequest API, so no page injection / CSP
   issues. Payloads that look like trades / positions / balances are relayed to
   the content script on the corresponding tab. */
const URLS = [
  "*://driftfund.io/api/*",
  "*://*.driftfund.io/api/*",
  "https://mvalpvdwqrtxfzpbzjgt.supabase.co/rest/v1/*",
];

const NOISE = /\/api\/(prices|fx-prices|broadcast|push\/register)|affiliate\/me|analytics/;
const INTEREST = /trade|position|account|histor|order|stat(istic)?s?|pnl|equity|balance|performance|result|margin|portfolio/;

function looksInteresting(url, obj) {
  if (NOISE.test(url)) return false;
  if (INTEREST.test(url)) return true;
  if (obj == null) return false;
  const hits = [];
  const scan = (v, d) => {
    if (d > 3 || hits.length >= 3) return;
    if (Array.isArray(v)) { v.slice(0, 300).forEach(x => scan(x, d + 1)); return; }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (/pnl|profit|equity|margin|trad|position|order|fill|netResult|realized|balance/.test(k)) hits.push(k);
        scan(v[k], d + 1);
      }
    }
  };
  scan(obj, 0);
  return hits.length > 0;
}

browser.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return {};
  let filter;
  try { filter = browser.webRequest.filterResponseData(details.requestId); }
  catch (e) { return {}; }

  const decoder = new TextDecoder("utf-8");
  let raw = "";
  try {
    filter.ondata = e => {
      raw += decoder.decode(e.data, { stream: true });
      filter.write(e.data);
    };
    filter.onstop = () => {
      raw += decoder.decode();
      filter.disconnect();
      try {
        const obj = JSON.parse(raw);
        if (looksInteresting(details.url, obj)) {
          browser.tabs
            .sendMessage(details.tabId, { __dfx: true, url: details.url, method: details.method || "GET", kind: "webreq", data: obj })
            .catch(() => {});
        }
      } catch (e) {}
    };
    filter.onerror = () => { try { filter.disconnect(); } catch (e2) {} };
  } catch (e) {
    try { filter.disconnect(); } catch (e2) {}
  }
  return {};
}, { urls: URLS }, ["blocking"]);