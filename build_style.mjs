// Bake the EPA Ecoregions × Terrain cartography into a standalone MapLibre style spec.
//
//   node build_style.mjs
//
// Reads base_style.json (the white-canvas OSM basemap) + palette_level1.json, applies every
// design decision from the interactive session, and writes style.json. The app shell (index.html)
// only loads this and adds chrome — style (cartography) and shell (UX) stay cleanly separated.
import fs from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const base    = JSON.parse(fs.readFileSync(HERE + "base_style.json", "utf8"));
const palette = JSON.parse(fs.readFileSync(HERE + "palette_level1.json", "utf8"));

// hosted sources (production)
const ECO_TILEJSON = "https://tiles.lightfield.earth/epa_eco_l3.json";
const HILL_TILES   = "https://tiles.lightfield.earth/hillshade_tiles_planet_z12_webp/{z}/{x}/{y}.webp";

// frozen design values
const D = {
  creamBg: "#eceae4",
  fillOpacity: 0.5,
  roadIntensity: 0.8,
  casingFadeZ: 12,
  roadEdgeColor: "hsl(30, 18%, 50%)",   // lighter warm gray (was a near-black brown at 36% L), so it
  roadEdgeOpacity: 0.40,                 // reads as definition, not a black outline, even at 0.40 opacity
  roadEdgeWidth: 1.8,
  waterEmphasis: 0.6,
  waterFill: "hsl(205, 58%, 68%)",   // inland water POLYGONS (big rivers like the Mississippi, lakes) —
                                     // base style leaves these unfilled, so they vanish; fill them blue
  roadOffWhite: "hsl(40, 8%, 93%)",
  labelHalo: "hsl(42, 15%, 93%)",
  forestGreen: "hsl(132, 34%, 29%)",
  placeLightness: 28,
  adminText: "hsl(30, 8%, 36%)",
  waterText: "hsl(212, 65%, 30%)",       // deep navy — legible on the blue water fill
  trailColor: "hsl(25, 36%, 34%)",       // medium warm brown for hiking paths — reads on both the
                                         // green forest and tan desert ecoregion fills, vs. the
                                         // neon coral/blue/green the base style ships for paths
};

const isRoad      = (l) => l.type === "line" && l["source-layer"] === "transportation";
const isCasing    = (l) => isRoad(l) && /outline|casing/i.test(l.id);
const isMajorRoad = (l) => isRoad(l) && !isCasing(l) && /motorway|trunk|primary|secondary/i.test(l.id) && !/construction/i.test(l.id);
const isWater     = (l) => l.type === "line" && l["source-layer"] === "waterway";
const isGreenLabel = (l) => l.type === "symbol" && (/park|forest|wood|nature|outdoor|sport/i.test(l.id) ||
  (typeof l.paint?.["text-color"] === "string" && /hsl\(\s*(8\d|9\d|1[0-4]\d)\b/.test(l.paint["text-color"])));
const isMinorRoad = (l) => /minor|service|track|path|residential|footway|cycle|steps|bridle|tertiary|street|construction/i.test(l.id);
// hiking trails (footways/paths/steps/cycleways/bridleways) are hidden in the minimal base style;
// match the path LINE layers by id (exclude the *outline casings, which stay hidden) so we can
// re-enable + recolor them below.
const isTrailLine = (l) => /^(Footway|Cycleway|Steps|Bridleway) path$|^(Footway|Cycleway|Bridleway) bridge$|^Pedestrian road$/.test(l.id);
// Bridges: every regular road/rail layer filters OUT brunnel=bridge, and the base style hides every
// bridge layer — so each bridge segment left a gap (no road crossed the Mississippi at St. Louis,
// interchanges broke into fragments). Un-hide them, but take paint/layout/zoom range from the road
// layer each one continues ("twin"): the base bridge layers have their own minzooms, wider widths and
// solid-black casings that would bulge/outline or still gap at some zooms. Only the bridge filter is kept.
// Bridge layers without a twin (Link bridge* — no such class in OpenMapTiles; Path bridge outlines —
// trail casings stay hidden) are left as-is.
const BRIDGE_TWIN = {
  "Street bridge outline": "Minor road outline",
  "Highway link bridge": "Highway road link",
  "Highway link bridge outline": "Highway link outline",
  "Service bridge": "Service road",
  "Service bridge outline": "Service road link outline",
  "Major rail bridge": "Major rail",
  "Major rail bridge hatching": "Major rail hatching",
  "Footway bridge": "Footway path",
  "Cycleway bridge": "Cycleway path",
  "Bridleway bridge": "Bridleway path",
};
const baseById = Object.fromEntries(base.layers.map((l) => [l.id, l]));
const withBridge = (l) => {
  if (l["source-layer"] !== "transportation" || !/ bridge\b/.test(l.id)) return l;
  const twin = baseById[BRIDGE_TWIN[l.id] ?? l.id.replace(" bridge", " road")];
  if (!twin || twin.type !== l.type) return l;
  const { minzoom, maxzoom, ...own } = clone(l);
  // the base's Secondary + Tertiary bridge outlines share one secondary+tertiary filter; with twin
  // colors the later (gray tertiary) casing would paint over secondary bridges, so split them by class
  const cls = l.id.match(/^(Secondary|Tertiary) bridge outline$/)?.[1].toLowerCase();
  if (cls) own.filter = ["all", ["==", "brunnel", "bridge"], ["==", "class", cls]];
  return { ...own, ...(twin.minzoom !== undefined && { minzoom: twin.minzoom }),
           ...(twin.maxzoom !== undefined && { maxzoom: twin.maxzoom }),
           layout: { ...clone(twin.layout || {}), visibility: "visible" }, paint: clone(twin.paint || {}) };
};
// the minimal base style hides every aeroway/aerodrome layer; re-enable airports (runways,
// taxiways, aprons, airport labels) — military landuse is handled separately by id below.
const isAirport   = (l) => l["source-layer"] === "aeroway" || l["source-layer"] === "aerodrome_label";
const scaleW = (w, f) => typeof w === "number" ? w * f
  : (w && Array.isArray(w.stops) ? { base: w.base ?? 1, stops: w.stops.map(([z, v]) => [z, v * f]) } : w);
// Duplicate bay labels: besides one centered English-named point, the tiles carry dozens of coastal
// fragments of Hudson Bay ("Baie d'Hudson", 31 points) and Baffin Bay ("Baie de Baffin", 10), each
// with name:en set, so "Hudson Bay" was printed 8+ times. Verified across all z3 and z5 tiles: these
// are the only heavy repeats worldwide. Drop the fragments by their (French) name.
const DUPLICATE_WATER_NAMES = ["Baie d'Hudson", "Baie de Baffin"];
const waterColor = (e) => `hsl(${208 - e*4}, 72%, ${78 - e*33}%)`;
const isWhite = (s) => typeof s === "string" && (/hsl\([^)]*,\s*(?:99|100)%\s*\)/.test(s) || /^#fff(?:fff)?$/i.test(s) || s === "white");
const deWhite = (c) => typeof c === "string" ? (isWhite(c) ? D.roadOffWhite : c)
  : (c && Array.isArray(c.stops) ? { base: c.base ?? 1, stops: c.stops.map(([z, v]) => [z, isWhite(v) ? D.roadOffWhite : v]) } : c);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ecoregion fill color keyed by Level I
const fillColor = ["match", ["get", "NA_L1CODE"]];
for (const [code, { color }] of Object.entries(palette)) fillColor.push(code, color);
fillColor.push("#cccccc");

const bg = { ...base.layers[0], paint: { ...(base.layers[0].paint || {}), "background-color": D.creamBg } };
const rest = base.layers.slice(1).map(withBridge);   // bridges first, so the [redge] clones below see them visible

const ecoFill = { id: "ecoregion-fill", type: "fill", source: "ecoregions", "source-layer": "ecoregions_l3",
  paint: { "fill-color": fillColor, "fill-opacity": D.fillOpacity } };
const hillshade = { id: "hillshade", type: "raster", source: "hillshade",
  paint: { "raster-opacity": 1, "raster-resampling": "nearest", "raster-fade-duration": 0 } };
const ecoOutline = { id: "ecoregion-outline", type: "line", source: "ecoregions", "source-layer": "ecoregions_l3",
  // desaturated dark WARM gray — distinct from the pink roads and blue rivers; legible structure
  // that reads beneath the rivers rather than competing with them
  paint: { "line-color": "hsl(35, 12%, 30%)", "line-opacity": 0.55,
           "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 8, 0.9, 12, 1.6] } };

const out = [];
for (const l0 of rest) {
  // big rivers + lakes render as water POLYGONS at lower zoom; the base style gives them no fill.
  // Add a blue fill for INLAND water only (rivers, lakes) just beneath the existing water outline.
  // The outline is left untouched — it also draws the OCEAN coastline, which must stay neutral.
  if (l0.id === "Water") {
    out.push({ id: "Water fill", type: "fill", source: "openmaptiles", "source-layer": "water",
      filter: ["all", ["==", "$type", "Polygon"], ["in", "class", "river", "lake", "pond", "dock", "canal"]],
      paint: { "fill-color": D.waterFill } });
    out.push(clone(l0));   // original water outline (neutral) — keeps coastlines subtle
    continue;
  }
  // Military bases: the base "Landuse pattern" hatch (military_red_hatch sprite) is too low-contrast
  // over the warm terrain and can't be recolored/thickened from the style. Instead emit a crisp red
  // boundary line here (z-order preserved at the Landuse-pattern slot); a faint interior tint is added
  // to the Military fill below. Filtered to military only so cemetery/quarry stay omitted.
  if (l0.id === "Landuse pattern") {
    out.push({ id: "Military boundary", type: "line", source: "openmaptiles", "source-layer": "landuse",
      // NB: this tileset only emits the `military` landuse class from z9 (verified against the tiles);
      // it cannot be shown earlier. Fade in across z9->10.5 so it eases in rather than popping at z9.
      minzoom: 8, filter: ["all", ["==", "class", "military"]],
      paint: { "line-color": "hsl(0, 60%, 48%)",
               "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0, 10.5, 0.8],
               "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 12, 1.8] } });
  }
  if (isMajorRoad(l0)) {
    const edge = clone(l0);
    edge.id = l0.id + " [redge]"; edge.paint = edge.paint || {};
    edge.paint["line-color"] = D.roadEdgeColor;
    edge.paint["line-width"] = scaleW(l0.paint?.["line-width"] ?? 1, D.roadEdgeWidth);
    edge.paint["line-opacity"] = ["interpolate", ["linear"], ["zoom"], 11.5, D.roadEdgeOpacity, 12.5, 0];
    out.push(edge);
  }
  const l = clone(l0);
  l.paint = l.paint || {};
  if (isRoad(l) && !isCasing(l)) {
    l.paint["line-color"] = deWhite(l.paint["line-color"]);
    l.paint["line-opacity"] = isMinorRoad(l) ? D.roadIntensity : Math.min(1, D.roadIntensity + 0.25);
  } else if (isCasing(l)) {
    l.paint["line-opacity"] = ["interpolate", ["linear"], ["zoom"], D.casingFadeZ - 0.5, 0, D.casingFadeZ + 0.5, 1];
  } else if (isWater(l)) {
    l.paint["line-color"] = waterColor(D.waterEmphasis);
    l.paint["line-width"] = scaleW(l.paint["line-width"] ?? 1, 1 + D.waterEmphasis * 1.3);
  } else if (l.type === "symbol" && l.paint["text-color"] !== undefined) {
    l.paint["text-halo-color"] = D.labelHalo;
    l.paint["text-halo-blur"] = 0.8;
    const w = l.paint["text-halo-width"];
    if (w === undefined || (typeof w === "number" && w < 1)) l.paint["text-halo-width"] = 1;
    if (isGreenLabel(l)) { l.paint["text-color"] = D.forestGreen; l.paint["text-halo-blur"] = 1; }
    if (l["source-layer"] === "place" && !/state|country/i.test(l.id)) l.paint["text-color"] = `hsl(30, 10%, ${D.placeLightness}%)`;
    if (l["source-layer"] === "place" && /state|country/i.test(l.id)) l.paint["text-color"] = D.adminText;
    // Water labels (lakes, ponds, bays). Both layers live in water_name: "Lakeline labels"
    // (line-placed, big lakes) and the misnamed "Ocean labels" (point-placed inland lakes —
    // its filter excludes oceans). Unify them to a legible deep navy; keep the shared warm
    // cream halo (set above) — a pure white halo glows on the blue water and reads worse.
    if (l["source-layer"] === "water_name") {
      l.filter = [...l.filter, ["!in", "name", ...DUPLICATE_WATER_NAMES]];
      l.paint["text-color"] = D.waterText;
      // the base style sets point-lake labels in thin "Lato Light", which the halo washes out at
      // small sizes — use the heavier "Lato Regular" that the river/big-lake labels already use.
      l.layout["text-font"] = ["Lato Regular", "Noto Sans Regular"];
      // bump point-lake labels 10->11; leave line-placed (Great Lakes) labels at 12
      const sz = l.layout["text-size"];
      if (l.layout["symbol-placement"] !== "line" && typeof sz === "number") l.layout["text-size"] = sz + 1;
    }
  }
  // Hiking trails: un-hide the path lines and recolor them to a subtle warm brown dashed line
  // (overriding the neon coral/blue/green the base ships). Labels already show from z11 via
  // "Road labels"; ease the lines in at z13 so the name no longer floats over an empty trail.
  // Each layer keeps its own line-dasharray + width (so footway/steps/cycleway stay distinct),
  // and the minor-road line-opacity (D.roadIntensity) set above.
  if (isTrailLine(l)) {
    l.layout = { ...(l.layout || {}), visibility: "visible" };
    l.minzoom = Math.max(13, l.minzoom ?? 0);
    l.paint["line-color"] = D.trailColor;
    l.paint["line-opacity"] = 0.95;
    // thicken ~30% over the base so the dashed trail reads clearly under its label
    l.paint["line-width"] = scaleW(l.paint["line-width"] ?? 1, 1.3);
  }
  // re-enable airports (hidden by default in the minimal base style).
  if (isAirport(l)) l.layout = { ...(l.layout || {}), visibility: "visible" };
  // aeroway geometry exists from z10 (verified against the tiles); the base style gates runways/
  // taxiways/aprons at z11. Pull them to z10 and fade in across z10->11.5 so they ease in instead of
  // popping at z11. The airport icon/label (aerodrome_label) already shows earlier, from z8.
  if (l.id === "Runway" || l.id === "Taxiway" || l.id === "Aeroway") {
    l.minzoom = 10;
    const fade = ["interpolate", ["linear"], ["zoom"], 10, 0, 10.8, 1];
    l.paint[l.type === "fill" ? "fill-opacity" : "line-opacity"] = fade;
  }
  // Military area fill: un-hide but knock opacity way down so it reads as a faint pink tint rather
  // than an opaque blanket over the hillshade (Ft. Huachuca, Nevada Test Site). Paired with the crisp
  // "Military boundary" line emitted above.
  if (l.id === "Military") {
    l.minzoom = 8;   // data-limited: military landuse only exists from z9 in this tileset
    l.layout = { ...(l.layout || {}), visibility: "visible" };
    l.paint["fill-color"] = "hsl(0, 55%, 68%)";
    l.paint["fill-opacity"] = ["interpolate", ["linear"], ["zoom"], 9, 0, 10.5, 0.13];
  }
  out.push(l);
}

// Bake each vector source's TileJSON into the style (tiles/zoom range/bounds/attribution). With a
// `url`, MapLibre must fetch the TileJSON — which the tile server builds from the archive's header +
// metadata on B2 — before it can request a single vector tile: ~300 ms on every cold page load.
async function inlineTileJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TileJSON ${url}: HTTP ${res.status}`);
  const tj = await res.json();
  return { type: "vector", tiles: tj.tiles, minzoom: tj.minzoom, maxzoom: tj.maxzoom, bounds: tj.bounds,
           ...(tj.attribution && { attribution: tj.attribution }) };
}
const vectorSources = {};
for (const [id, src] of Object.entries({ ...base.sources, ecoregions: { type: "vector", url: ECO_TILEJSON } })) {
  vectorSources[id] = src.type === "vector" && src.url ? await inlineTileJSON(src.url) : src;
}

// Hidden layers (visibility: none) draw nothing but are still parsed, validated and carried in every
// style.json download; drop them from the built style (base_style.json keeps them for editing).
const isHidden = (l) => l.layout?.visibility === "none";

const style = {
  version: 8,
  name: "EPA Ecoregions of the Conterminous United States",
  metadata: { "lightfield:generated-by": "build_style.mjs" },
  glyphs: base.glyphs, sprite: base.sprite,
  sources: {
    ...vectorSources,
    hillshade:  { type: "raster", tiles: [HILL_TILES], tileSize: 512, minzoom: 0, maxzoom: 12,
                  attribution: "Hillshade: Copernicus GLO-30" },
  },
  layers: [bg, ecoFill, hillshade, ecoOutline, ...out].filter((l) => !isHidden(l)),
};

fs.writeFileSync(HERE + "style.json", JSON.stringify(style, null, 2) + "\n");
console.log(`style.json written: ${style.layers.length} layers, sources: ${Object.keys(style.sources).join(", ")}`);
