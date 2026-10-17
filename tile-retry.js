// Dependable resource loading for MapLibre.
//
// MapLibre gives up on a tile after ONE failed request: the tile is marked errored and stays a hole
// until it's evicted (pan/zoom away). This registers a custom protocol that MapLibre routes every
// request through (tiles, TileJSON, glyphs, sprites) and retries transient failures — network
// errors, stalls, 429 and 5xx — with short exponential backoff. The happy path is one plain fetch.
//
//   <script src="./tile-retry.js"></script>
//   style = TileRetry.wrapStyle(style);   // before new maplibregl.Map({ style })
(function () {
  const SCHEME = "lfretry";               // lfretry://host/path  ->  https://host/path
  const MAX_ATTEMPTS = 6;                 // first try + 5 retries
  const BACKOFF_MS = [250, 500, 1000, 2000, 4000];   // + up to 30% jitter; ~8 s of waiting in all
  const ATTEMPT_TIMEOUT_MS = 12000;       // a stalled connection is abandoned and retried
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

  async function fetchOnce(url, params, outer) {
    const ctl = new AbortController();                  // aborts on MapLibre cancel OR attempt timeout
    const onAbort = () => ctl.abort();
    outer.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: params.method || "GET", headers: params.headers, body: params.body,
        credentials: params.credentials, cache: params.cache, signal: ctl.signal,
      });
      if (!res.ok) throw httpError(res);
      const data = params.type === "json" ? await res.json()
        : params.type === "string" ? await res.text()
        : await res.arrayBuffer();                       // "arrayBuffer" and "image" (MapLibre decodes it)
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
        if (attempt >= MAX_ATTEMPTS || !retryable(err)) throw err;
        const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        await sleep(base * (1 + 0.3 * Math.random()), signal);
      }
    }
  }

  maplibregl.addProtocol(SCHEME, load);

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

  window.TileRetry = { wrapStyle, SCHEME };
})();
