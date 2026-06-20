# ecoregions-terrain-map

A published interactive map integrating the **U.S. EPA Level III ecoregions**
into the LightField terrain basemap, with the Copernicus GLO-30 hillshade
modulating the intensity of the ecoregion colors (hue preserved, shadows only).

## Architecture

The map is two clean artifacts — **cartography** and **shell** — plus hosted tiles.
No Marimo/leafmap; the style spec and app shell are authored directly.

```
build_style.mjs   ──>  style.json        the cartography (a MapLibre style spec)
                                          baked from base_style.json + palette
index.html        ──>  loads style.json  the app shell: controls, legend,
                                          hover info, logo, attribution
```

All tiles are served from `tiles.lightfield.earth`:
- ecoregions — `https://tiles.lightfield.earth/epa_eco_l3.json` (TileJSON; vector)
- hillshade  — `https://tiles.lightfield.earth/hillshade_tiles_planet_z12_webp/{z}/{x}/{y}.webp`
- basemap    — `https://tiles.lightfield.earth/2026-05-01-planet-osm.json` (OpenMapTiles)

## Files

| File | Role |
| --- | --- |
| `build_style.mjs` | Bakes `style.json` from `base_style.json` + `palette_level1.json`. Holds every design decision in a single `D = {...}` block. |
| `style.json` | The generated cartography (committed; regenerate with the build). |
| `index.html` | App shell — loads `style.json`, adds chrome. The deployable entry point. |
| `palette_level1.json` | Level I ecoregion earth-tone palette (code → name + hex). |
| `lightfield-logo.png` | Logo (transparent). |
| `base_style.json` | Upstream terrain basemap (white-canvas OSM); a build input only. |

Deployable bundle: `index.html`, `style.json`, `palette_level1.json`,
`lightfield-logo.png`. (`build_style.mjs` and `base_style.json` are build inputs.)

## Build & preview

```sh
node build_style.mjs            # (re)generate style.json after editing design values
python3 -m http.server 8000     # serve this directory
# open http://localhost:8000/index.html
```

Tiles are hosted, so no local tile server is needed.

### Tuning

`index.html` is clean by default. Append **`?tune=1`** to reveal live knobs
(currently the road edge). When a value feels right, set it in `build_style.mjs`
(e.g. `D.roadEdgeOpacity`) and re-run `node build_style.mjs` to re-bake. Tune in
the shell, bake to the spec.

## Design summary (locked)

- Cream paper background (`#eceae4`) — cohesive in and out of CONUS, no stark white.
- Ecoregion fill: Level I earth tones at 0.5 opacity; hillshade at 1.0 (intensity only).
- Roads: light fills, intensity 0.8; base casings fade in at z12; major roads get a
  soft warm legibility edge (`hsl(30,18%,50%)` @ 0.40) that fades out by z12.
- Water deepened for presence over the colored base.
- Labels: one warm soft halo for all; muted forest green for natural features;
  dark warm-gray settlement tier; lighter admin tier; deepened blue seas.
- Typography: Open Sans / Lato, matching the basemap glyphs.

## Deploy

Static hosting (GitHub Pages, matching the sibling published maps): publish the
bundle, add a `CNAME` for the chosen subdomain. Tiles are already live, so the
ecoregion source needs no change.

## Source & license

U.S. EPA Level III Ecoregions (public domain) · Hillshade derived from Copernicus
GLO-30 · Basemap © OpenMapTiles © OpenStreetMap contributors.
