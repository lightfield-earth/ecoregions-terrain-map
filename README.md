# ecoregions-terrain-map

An interactive map of the **U.S. EPA Level III ecoregions**, colored by Level I
family, over a shaded-relief terrain basemap. Hover over (or tap) any region to
see its Level III and Level I names.

**Live map: https://ecoregions.lightfield.earth**

## What it shows

- EPA **Level III ecoregions** of the conterminous United States, filled by
  **Level I** family (see the on-map legend).
- **Copernicus GLO-30 hillshade** for terrain — it modulates the intensity of the
  ecoregion colors without changing their hue.
- Rivers, lakes, roads, and place labels for orientation.

## Run locally

The map tiles are hosted, so any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

## Sources & license

- **Ecoregions** — U.S. EPA, Level III Ecoregions of the Conterminous United
  States (public domain).
- **Terrain** — hillshade derived from the Copernicus GLO-30 DEM.
- **Basemap** — © OpenMapTiles © OpenStreetMap contributors.
