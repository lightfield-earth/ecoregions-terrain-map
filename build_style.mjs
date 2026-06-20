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
  seaText: "hsl(210, 45%, 42%)",
};

const isRoad      = (l) => l.type === "line" && l["source-layer"] === "transportation";
const isCasing    = (l) => isRoad(l) && /outline|casing/i.test(l.id);
const isMajorRoad = (l) => isRoad(l) && !isCasing(l) && /motorway|trunk|primary|secondary/i.test(l.id) && !/construction/i.test(l.id);
const isWater     = (l) => l.type === "line" && l["source-layer"] === "waterway";
const isGreenLabel = (l) => l.type === "symbol" && (/park|forest|wood|nature|outdoor|sport/i.test(l.id) ||
  (typeof l.paint?.["text-color"] === "string" && /hsl\(\s*(8\d|9\d|1[0-4]\d)\b/.test(l.paint["text-color"])));
const isMinorRoad = (l) => /minor|service|track|path|residential|footway|cycle|steps|bridle|tertiary|street|construction/i.test(l.id);
const scaleW = (w, f) => typeof w === "number" ? w * f
  : (w && Array.isArray(w.stops) ? { base: w.base ?? 1, stops: w.stops.map(([z, v]) => [z, v * f]) } : w);
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
const rest = base.layers.slice(1);

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
    if (l["source-layer"] === "water_name" && /ocean|sea|gulf|bay|marine/i.test(l.id)) l.paint["text-color"] = D.seaText;
  }
  out.push(l);
}

const style = {
  version: 8,
  name: "EPA Ecoregions of the Conterminous United States",
  metadata: { "lightfield:generated-by": "build_style.mjs" },
  glyphs: base.glyphs, sprite: base.sprite,
  sources: {
    ...base.sources,
    ecoregions: { type: "vector", url: ECO_TILEJSON },
    hillshade:  { type: "raster", tiles: [HILL_TILES], tileSize: 512, minzoom: 0, maxzoom: 12,
                  attribution: "Hillshade: Copernicus GLO-30" },
  },
  layers: [bg, ecoFill, hillshade, ecoOutline, ...out],
};

fs.writeFileSync(HERE + "style.json", JSON.stringify(style, null, 2) + "\n");
console.log(`style.json written: ${style.layers.length} layers, sources: ${Object.keys(style.sources).join(", ")}`);
