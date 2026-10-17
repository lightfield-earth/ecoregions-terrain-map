// Dependable resource loading for MapLibre.
//
// MapLibre gives up on a tile after ONE failed request: the tile is marked errored and stays a hole
// until it's evicted (pan/zoom away). This registers a custom protocol that MapLibre routes every
// request through (tiles, TileJSON, glyphs, sprites) and retries transient failures — network
// errors, stalls, 429 and 5xx — with short exponential backoff (capped at 8 s), for as long as
// MapLibre still wants the resource: it aborts requests for tiles that leave the view, which ends
// the retries. So a tile on screen never settles into a hole, and an outage heals by itself once
// the server is back. The happy path is one plain fetch.
//
//   <script src="./tile-retry.js"></script>
//   TileRetry.installInWorkers();          // before new maplibregl.Map(...)
//   style = TileRetry.wrapStyle(style);
(function () {
  const SCHEME = "lfretry";               // lfretry://host/path  ->  https://host/path
  const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];   // + up to 30% jitter; then every ~8 s
  // A *stalled* attempt (no response headers, or no body bytes, for this long) is abandoned and
  // retried. Deliberately not a cap on total duration: on a slow link a big tile can take 20 s+
  // while still progressing, and aborting it would just re-download it from zero.
  const STALL_MS = 15000;
  const WARN_AFTER = 6;                   // attempts before logging that a resource is struggling
  const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

  const toHttps = (url) => "https://" + url.slice(SCHEME.length + 3);
  const wrap = (url) => (typeof url === "string" && url.startsWith("https://") ? SCHEME + "://" + url.slice(8) : url);
  const abortError = () => new Error("AbortError");   // MapLibre recognises this message as a cancel

  // MapLibre-shaped error: `status` 404 tells it the tile doesn't exist (it then over-zooms the parent).
  const httpError = (res) => Object.assign(new Error(`${res.status} ${res.statusText}: ${res.url}`),
    { status: res.status, statusText: res.statusText, url: res.url });

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

  // Read the body chunk by chunk so the stall timer can be reset whenever bytes arrive.
  async function readBody(res, onProgress) {
    if (!res.body) return new ArrayBuffer(0);
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength; onProgress();
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out.buffer;
  }

  async function fetchOnce(url, params, outer) {
    const ctl = new AbortController();                  // aborts on MapLibre cancel OR a stall
    const onAbort = () => ctl.abort();
    outer.addEventListener("abort", onAbort, { once: true });
    let timer;
    const progress = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), STALL_MS); };
    progress();
    try {
      const res = await fetch(url, {
        method: params.method || "GET", headers: params.headers, body: params.body,
        credentials: params.credentials, cache: params.cache, signal: ctl.signal,
      });
      progress();
      if (!res.ok) throw httpError(res);
      const buf = await readBody(res, progress);
      const data = params.type === "json" ? JSON.parse(new TextDecoder().decode(buf))
        : params.type === "string" ? new TextDecoder().decode(buf)
        : buf;                                           // "arrayBuffer" and "image" (MapLibre decodes it)
      return { data, cacheControl: res.headers.get("Cache-Control"), expires: res.headers.get("Expires") };
    } catch (err) {
      if (outer.aborted) throw abortError();             // MapLibre no longer needs it: stop, don't retry
      throw err;                                          // network error / stall / HTTP error
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onAbort);
    }
  }

  const retryable = (err) => err.status === undefined || RETRY_STATUS.has(err.status);

  async function load(params, abortController) {
    const url = toHttps(params.url), signal = abortController.signal;
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await fetchOnce(url, params, signal);
        // TileJSON lists the real tile URLs — route those through the retrying loader too.
        if (params.type === "json" && out.data && Array.isArray(out.data.tiles)) out.data.tiles = out.data.tiles.map(wrap);
        return out;
      } catch (err) {
        if (signal.aborted || err.message === "AbortError") throw abortError();
        if (!retryable(err)) throw err;                  // 404 (no tile here), 403, ...: final
        if (attempt === WARN_AFTER) console.warn(`[tile-retry] still retrying after ${attempt} attempts: ${url}`, err);
        const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        await sleep(base * (1 + 0.3 * Math.random()), signal);
      }
    }
  }

  // Runs both on the page and inside MapLibre's web workers (see installInWorkers). The workers fetch
  // the vector tiles; registering the protocol there keeps those fetches off the main thread
  // (routing them through the page's handler instead cost ~8% load time on a slow link).
  const inWorker = typeof window === "undefined";
  (inWorker ? self.addProtocol : maplibregl.addProtocol)(SCHEME, load);
  if (inWorker) return;

  // Load this same script into MapLibre's workers. Call before creating the map. Workers run from a
  // blob: URL, so they need this script's absolute URL — captured now, while it's still loading.
  const scriptUrl = document.currentScript && document.currentScript.src;
  function installInWorkers() {
    if (scriptUrl) maplibregl.importScriptInWorkers(scriptUrl);
  }

  // Point every https resource in a style at the retrying loader (style.json itself stays standard).
  function wrapStyle(style) {
    const s = JSON.parse(JSON.stringify(style));
    s.glyphs = wrap(s.glyphs);
    if (typeof s.sprite === "string") s.sprite = wrap(s.sprite);
    else if (Array.isArray(s.sprite)) s.sprite = s.sprite.map((sp) => ({ ...sp, url: wrap(sp.url) }));
    for (const src of Object.values(s.sources || {})) {
      if (src.url) src.url = wrap(src.url);
      if (Array.isArray(src.tiles)) src.tiles = src.tiles.map(wrap);
    }
    return s;
  }

  window.TileRetry = { wrapStyle, installInWorkers, SCHEME };
})();
