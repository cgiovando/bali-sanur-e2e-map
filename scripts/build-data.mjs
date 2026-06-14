// build-data.mjs - bakes live HOT data sources into static GeoJSON + a manifest.
//
// The published map only ever reads the files this script writes into data/.
// We deliberately do NOT hit the live APIs from the browser on every page load:
// it keeps the map fast, immune to Overpass rate limits / API outages, and
// reproducible. Re-run with `npm run build:data` (or the weekly GitHub Action).
//
// Requires Node 18+ (global fetch). Single dependency: osmtogeojson.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import osmtogeojson from "osmtogeojson";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

// --- Constants describing the exercise ------------------------------------
const PLAN_ID = "210951e9-3f1f-492b-91f9-62817b42605e";
const PLAN_URL = `https://portal.hotosm.org/api/plans/shared/${PLAN_ID}`;
const PLAN_PUBLIC_URL = `https://portal.hotosm.org/en/plan/${PLAN_ID}`;

// Sanur area bounding box (south, west, north, east) and the OAM/Overpass forms.
const BBOX = { south: -8.71, west: 115.24, north: -8.66, east: 115.28 };
const OAM_BBOX = `${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`;
const CENTER = [
  (BBOX.west + BBOX.east) / 2,
  (BBOX.south + BBOX.north) / 2,
];

const WINDOW_DAYS = 7;
// Keep OAM captures from roughly the last quarter so the imagery layer keeps
// working as new flights are uploaded, without dragging in years-old coverage.
const OAM_MAX_AGE_DAYS = 120;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// OAM's own tile endpoint (tiles.openaerialmap.org) is a 302 redirect that does
// NOT send CORS headers, so MapLibre's fetch-based raster loader is blocked.
// We instead point MapLibre straight at the TiTiler COG endpoint OAM redirects
// to (titiler.hotosm.org sends `access-control-allow-origin: *`), built from the
// imagery's COG url (the meta `uuid` field).
function titilerTms(cogUrl) {
  return (
    "https://titiler.hotosm.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=" +
    encodeURIComponent(cogUrl)
  );
}

// Known-good OAM captures (COG urls) to fall back on if the meta query is empty.
const OAM_FALLBACK = [
  { _id: "6a27e1512d6b08f9a1076133", title: "Sanur tasks 25, 26, 30, 36, 50, 51", gsd: 0.05, acquisition_end: "2026-06-08T02:17:32.857Z", bbox: [115.256329, -8.689911, 115.267002, -8.677335], uuid: "https://oin-hotosm-temp.s3.us-east-1.amazonaws.com/6a27debb2d6b08f9a1075997/0/6a27debb2d6b08f9a1075998.tif" },
  { _id: "6a262899d8decd50ab134a3a", title: "Sanur tasks 21, 22, 27, 33, 49", gsd: 0.05, acquisition_end: "2026-06-08T02:10:50.147Z", bbox: [115.256751, -8.703765, 115.267596, -8.695604], uuid: "https://oin-hotosm-temp.s3.us-east-1.amazonaws.com/6a26263cd8decd50ab13465d/0/6a26263cd8decd50ab13465e.tif" },
  { _id: "6a2531a6f6c7e0f5d490ebf0", title: "sanur tiny", gsd: 0.05, acquisition_end: "2026-06-07T08:39:29.106Z", bbox: [115.25636, -8.709304, 115.265631, -8.702177], uuid: "https://oin-hotosm-temp.s3.us-east-1.amazonaws.com/6a252f98f6c7e0f5d490e83d/0/6a252f98f6c7e0f5d490e83e.tif" },
].map((o) => ({ ...o, tms: titilerTms(o.uuid) }));

// --- Small helpers ---------------------------------------------------------
// A descriptive User-Agent is required: Overpass (and good API etiquette)
// reject Node's default UA with HTTP 406.
const USER_AGENT =
  "bali-sanur-e2e-map/1.0 (+https://github.com/cgiovando/bali-sanur-e2e-map; data build script)";

function log(...args) {
  console.log("[build-data]", ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, init = {}) {
  const headers = { "User-Agent": USER_AGENT, ...(init.headers || {}) };
  // Bound every live request so a hung source can't stall the (CI) build.
  const signal = init.signal || AbortSignal.timeout(30000);
  const res = await fetch(url, { ...init, headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Keys osmtogeojson copies from OSM element metadata - these are not real tags.
const OSM_META_KEYS = new Set(["id", "type", "timestamp", "version", "changeset", "uid", "user"]);

// True if a feature carries at least one human-meaningful tag (not just metadata).
function hasDisplayTags(props) {
  return Object.keys(props).some((k) => !OSM_META_KEYS.has(k) && !k.startsWith("_"));
}

// Drop continental route relations whose geometry sprawls far beyond the AOI
// (e.g. "Asian Highway 2"). Local Sanur features span well under this threshold.
const MAX_FEATURE_DEG = 0.5;
function featureExtentTooLarge(geom) {
  if (!geom || !geom.coordinates) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else c.forEach(visit);
  };
  visit(geom.coordinates);
  return maxX - minX > MAX_FEATURE_DEG || maxY - minY > MAX_FEATURE_DEG;
}

function writeJSON(name, obj) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  log(`wrote ${name} (${kb} KB)`);
}

function featureCollection(features) {
  return { type: "FeatureCollection", features };
}

// --- 1. Portal plan --------------------------------------------------------
// Returns { plan, droneAois, chatmaps, oamFromPlan } extracted from the plan.
async function fetchPlan() {
  log("fetching portal plan ...");
  const plan = await getJSON(PLAN_URL);
  const projects = plan.projects || [];

  const droneAois = [];
  const chatmaps = [];
  let tm = null;
  let fieldTm = null;

  for (const p of projects) {
    const data = p.data || {};
    if (p.app === "drone-tasking-manager" && data.outline && data.outline.geometry) {
      droneAois.push({
        type: "Feature",
        geometry: data.outline.geometry,
        properties: {
          name: data.name || "Drone flight area",
          gsd_cm_px: data.gsd_cm_px ?? null,
          status: data.status || p.status || null,
          source: "Drone Tasking Manager",
        },
      });
    } else if (p.app === "chatmap" && data.id) {
      chatmaps.push({ id: data.id, name: data.name || "ChatMap dataset" });
    } else if (p.app === "tasking-manager" && data.name) {
      tm = {
        project_id: p.project_id,
        name: data.name,
        url: `https://tasks.hotosm.org/projects/${p.project_id}`,
        percentMapped: data.percentMapped ?? null,
        percentValidated: data.percentValidated ?? null,
        organisationName: data.organisationName || null,
      };
    } else if (p.app === "field-tm" && data.id) {
      fieldTm = { id: data.id, name: data.name, base_url: data.base_url || "https://field.hotosm.org" };
    }
  }

  return { plan, droneAois, chatmaps, tm, fieldTm };
}

// --- 2. OpenAerialMap ------------------------------------------------------
async function fetchOAM() {
  log("fetching OpenAerialMap meta ...");
  const url = `https://api.openaerialmap.org/meta?bbox=${OAM_BBOX}&limit=50&sort=desc&order_by=acquisition_end`;
  let results = [];
  try {
    const data = await getJSON(url);
    results = data.results || [];
  } catch (err) {
    log("OAM meta query failed, using fallback:", err.message);
    return OAM_FALLBACK;
  }
  const cutoff = Date.now() - OAM_MAX_AGE_DAYS * 86400 * 1000;
  const recent = results
    .filter((r) => r.uuid) // COG url, required to build the TiTiler tile URL
    .filter((r) => {
      const t = Date.parse(r.acquisition_end || r.acquisition_start || "");
      return Number.isNaN(t) ? true : t >= cutoff;
    })
    .map((r) => ({
      _id: r._id,
      title: r.title || "Untitled imagery",
      gsd: r.gsd ?? null,
      acquisition_end: r.acquisition_end || r.acquisition_start || null,
      bbox: r.bbox,
      uuid: r.uuid,
      tms: titilerTms(r.uuid),
    }));
  if (recent.length === 0) {
    log("OAM returned no recent captures, using fallback");
    return OAM_FALLBACK;
  }
  log(`OAM: ${recent.length} recent capture(s)`);
  return recent;
}

// --- 3. ChatMap ------------------------------------------------------------
// Each ChatMap response is itself a GeoJSON FeatureCollection (points with a
// `file` photo URL, `message`, `time`). We strip it to a clean collection.
async function fetchChatmap(id, label) {
  log(`fetching ChatMap ${label} (${id}) ...`);
  const data = await getJSON(`https://chatmap.hotosm.org/api/v1/map/${id}`);
  const features = (data.features || []).map((f) => ({
    type: "Feature",
    geometry: f.geometry,
    properties: {
      id: f.properties?.id,
      time: f.properties?.time || null,
      message: f.properties?.message || "",
      file: f.properties?.file || null,
      dataset: data.name || label,
    },
  }));
  return { name: data.name || label, fc: featureCollection(features) };
}

// --- 4. Recent OSM via Overpass -------------------------------------------
async function fetchRecentOSM() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const ql = `[out:json][timeout:90];nwr(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})(newer:"${since}");out geom meta;`;
  log(`fetching recent OSM since ${since} ...`);

  let osm = null;
  let lastErr = null;
  // Try each mirror; retry once with backoff on transient 429/504s.
  outer: for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: "data=" + encodeURIComponent(ql),
          signal: AbortSignal.timeout(120000), // > query timeout (90s) + transfer
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        osm = await res.json();
        log(`Overpass ok via ${endpoint} (${(osm.elements || []).length} elements)`);
        break outer;
      } catch (err) {
        lastErr = err;
        log(`Overpass failed via ${endpoint} (attempt ${attempt}): ${err.message}`);
        if (attempt === 1) await sleep(5000);
      }
    }
  }
  if (!osm) throw lastErr || new Error("All Overpass endpoints failed");

  const raw = osmtogeojson(osm).features;
  // Keep only displayable, on-AOI features:
  //  - drop bare nodes with no tags (way vertices / trivially-touched nodes)
  //    that would otherwise render as meaningless dots and inflate counts;
  //  - drop oversized route relations that sprawl outside the AOI.
  let droppedNodes = 0;
  let droppedBig = 0;
  const features = raw.filter((f) => {
    if (featureExtentTooLarge(f.geometry)) { droppedBig++; return false; }
    if (f.geometry && f.geometry.type === "Point" && !hasDisplayTags(f.properties || {})) {
      droppedNodes++;
      return false;
    }
    return true;
  });
  log(`OSM: kept ${features.length} of ${raw.length} features (dropped ${droppedNodes} untagged nodes, ${droppedBig} oversized relations)`);

  // `newer:` filters by last-edit timestamp, not creation, so a feature here
  // may be brand new OR an old feature that was merely touched. We expose
  // version===1 as a pragmatic "created this week" proxy for styling.
  let created = 0;
  const topUsers = {};
  for (const f of features) {
    const p = f.properties || (f.properties = {});
    const meta = p.meta || {};
    const version = Number(p.version ?? meta.version ?? 0);
    p._created = version === 1;
    if (p._created) created++;
    p._user = p.user || meta.user || null;
    p._timestamp = p.timestamp || meta.timestamp || null;
    p._version = version || null;
    if (p._user) topUsers[p._user] = (topUsers[p._user] || 0) + 1;
    // osm id+type for deep links (id property is like "way/123")
    p._osmId = f.id || (p.type && p.id ? `${p.type}/${p.id}` : null);
  }
  const top = Object.entries(topUsers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([user, count]) => ({ user, count }));

  return {
    fc: featureCollection(features),
    count: features.length,
    created,
    topUsers: top,
    since,
  };
}

// --- Main ------------------------------------------------------------------
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated_at = new Date().toISOString();

  const { plan, droneAois, chatmaps, tm, fieldTm } = await fetchPlan();
  const oam = await fetchOAM();

  // ChatMap UUIDs come from the plan; fall back to the two known ones.
  const cmList = chatmaps.length
    ? chatmaps
    : [
        { id: "e8dd006e-c75d-4829-9405-9621ca93b3fc", name: "Critical infrastructure" },
        { id: "3e101078-3b54-4d37-8db8-841523589384", name: "Intersections" },
      ];
  const infraEntry = cmList.find((c) => /infra/i.test(c.name)) || cmList[0];
  const interEntry = cmList.find((c) => /intersection/i.test(c.name)) || cmList[1] || cmList[0];

  const infra = await fetchChatmap(infraEntry.id, "Critical infrastructure");
  const inter = await fetchChatmap(interEntry.id, "Intersections");
  const osm = await fetchRecentOSM();

  // Write GeoJSON files.
  writeJSON("drone-aois.geojson", featureCollection(droneAois));
  writeJSON("chatmap-infrastructure.geojson", infra.fc);
  writeJSON("chatmap-intersections.geojson", inter.fc);
  writeJSON("osm-recent.geojson", osm.fc);

  // Manifest drives the app (titles, counts, imagery, story panel).
  const manifest = {
    generated_at,
    window_days: WINDOW_DAYS,
    osm_since: osm.since,
    bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
    center: CENTER,
    plan: {
      name: plan.name || "Bali E2E Mapping Exercise",
      url: PLAN_PUBLIC_URL,
      tm,
      field_tm: fieldTm,
    },
    oam,
    chatmap: {
      infrastructure: { id: infraEntry.id, name: infra.name, count: infra.fc.features.length },
      intersections: { id: interEntry.id, name: inter.name, count: inter.fc.features.length },
    },
    osm: {
      count: osm.count,
      created_count: osm.created,
      top_users: osm.topUsers,
    },
    drone: { aoi_count: droneAois.length },
  };
  writeJSON("manifest.json", manifest);

  log("done.");
  log(`  OAM captures: ${oam.length}`);
  log(`  Recent OSM: ${osm.count} features (${osm.created} new)`);
  log(`  ChatMap: ${infra.fc.features.length} infra + ${inter.fc.features.length} intersections`);
  log(`  Drone AOIs: ${droneAois.length}`);
}

main().catch((err) => {
  console.error("[build-data] FAILED:", err);
  process.exit(1);
});
