# Sanur E2E Mapping

An interactive web map of the **Bali / Sanur end-to-end mapping exercise** - a HOT
(Humanitarian OpenStreetMap Team) workflow run over one week in Sanur, Bali, for
**BPBD tsunami-evacuation planning**. It brings the whole pipeline onto one map:

1. **Fly** - community drones capture 5 cm imagery.
2. **Publish** - imagery is uploaded to OpenAerialMap.
3. **Map** - buildings and roads are traced into OpenStreetMap (AI-assisted + a mapathon).
4. **Collect** - field teams log critical infrastructure with ChatMap.
5. **Plan** - the data feeds evacuation planning in Field-TM.

![Sanur E2E map](docs/preview.jpg)

## Layers

| Layer | Source | Notes |
| --- | --- | --- |
| Drone imagery (5 cm) | [OpenAerialMap](https://openaerialmap.org) via [TiTiler](https://titiler.hotosm.org) | June 2026 captures over Sanur |
| Recent OSM (7 days) | [OpenStreetMap](https://www.openstreetmap.org) via [Overpass](https://overpass-api.de) | New (red) vs edited (blue) features |
| ChatMap: infrastructure | [ChatMap](https://chatmap.hotosm.org) | Field points with photos |
| ChatMap: intersections | ChatMap | Field points |
| Drone flight areas | [HOT Portal](https://portal.hotosm.org) plan | Drone Tasking Manager AOIs |
| Satellite basemap | Esri World Imagery | Optional basemap |

The exercise is coordinated through a single
[HOT Portal plan](https://portal.hotosm.org/en/plan/210951e9-3f1f-492b-91f9-62817b42605e),
which also links a Tasking Manager mapathon and a Field-TM project.

## How it works

The page is a static site (MapLibre GL JS, no framework, no build step). It reads
**baked static data** from `data/` - it never calls the live APIs on page load. A
build script fetches and normalises everything into GeoJSON + a manifest:

```
data/
├── manifest.json                    # layer config, counts, imagery URLs, "last updated"
├── osm-recent.geojson               # recent OSM, new-vs-edited flagged
├── chatmap-infrastructure.geojson
├── chatmap-intersections.geojson
└── drone-aois.geojson
```

Baking (instead of live fetching) keeps the map fast, avoids Overpass rate limits,
and stays up even if a source API is briefly down. A GitHub Action re-bakes the
data weekly.

> Note: "recent OSM" uses each feature's last-edit time (Overpass `newer:`), so a
> few features may be older objects that were merely touched in the window.
> New-vs-edited is inferred from OSM version 1.

## Run locally

```bash
npm install
npm run build:data     # fetch + bake data/ (needs internet; Node 18+)
npm run check:data     # validate the baked output (also: npm test)
npm run serve          # serve at http://localhost:8000
```

Then open <http://localhost:8000>. To refresh the data, re-run `npm run build:data`.
`check:data` guards against regressions (untagged-node clutter, off-AOI
mega-relations, malformed manifest) and runs in CI after every rebuild.

## Deploy

This repo is built for **GitHub Pages** (deploy from `main`, root). The
`.github/workflows/refresh-data.yml` action re-bakes the data weekly (and on
manual dispatch) and commits it, which triggers a Pages rebuild.

## AI-assisted development

> This project was developed with significant assistance from AI coding tools.

- **[Claude Code](https://claude.ai/claude-code)** (Anthropic) - code generation, architecture, debugging, and documentation
- All functionality has been tested and verified to work as intended
- Features and infrastructure choices have been reviewed and approved by the maintainer

This disclosure follows emerging best practices for transparency in AI-assisted software development.

## License

[MIT](LICENSE). Map data and imagery remain under their respective licenses:
OpenStreetMap data &copy; OpenStreetMap contributors (ODbL); imagery &copy;
OpenAerialMap / HOTOSM and Esri; field data via ChatMap / HOTOSM.
