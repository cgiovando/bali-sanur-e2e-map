// check-data.mjs - lightweight validation of the baked data/ outputs.
// Runs in CI after build:data so a bad bake fails loudly instead of shipping
// broken/bloated data. No dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const errors = [];
const fail = (m) => errors.push(m);

function read(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) {
    fail(`missing ${name}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${name} is not valid JSON: ${e.message}`);
    return null;
  }
}

function featureBboxExtent(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === "number") {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else c.forEach(visit);
  };
  if (geom && geom.coordinates) visit(geom.coordinates);
  return [maxX - minX, maxY - minY];
}

const META_KEYS = new Set(["id", "type", "timestamp", "version", "changeset", "uid", "user"]);
const hasTags = (p = {}) => Object.keys(p).some((k) => !META_KEYS.has(k) && !k.startsWith("_"));

// --- manifest ---
const manifest = read("manifest.json");
if (manifest) {
  for (const k of ["generated_at", "bbox", "center", "oam", "chatmap", "osm"]) {
    if (manifest[k] == null) fail(`manifest missing "${k}"`);
  }
  if (!Array.isArray(manifest.oam) || manifest.oam.length === 0) fail("manifest.oam empty");
  (manifest.oam || []).forEach((o, i) => {
    if (!/^https?:\/\//.test(o.tms || "")) fail(`oam[${i}].tms not a URL`);
  });
}

// --- recent OSM ---
const osm = read("osm-recent.geojson");
if (osm) {
  if (osm.type !== "FeatureCollection") fail("osm-recent.geojson not a FeatureCollection");
  const feats = osm.features || [];
  const untaggedPts = feats.filter(
    (f) => f.geometry && f.geometry.type === "Point" && !hasTags(f.properties)
  ).length;
  if (untaggedPts > 0) fail(`osm-recent has ${untaggedPts} untagged point(s) (should be filtered out)`);
  const oversized = feats.filter((f) => {
    const [w, h] = featureBboxExtent(f.geometry);
    return w > 0.5 || h > 0.5;
  }).length;
  if (oversized > 0) fail(`osm-recent has ${oversized} oversized off-AOI feature(s)`);
  if (manifest && manifest.osm && manifest.osm.count !== feats.length) {
    fail(`manifest.osm.count (${manifest.osm.count}) != feature count (${feats.length})`);
  }
}

// --- ChatMap files ---
for (const name of ["chatmap-infrastructure.geojson", "chatmap-intersections.geojson"]) {
  const cm = read(name);
  if (cm && cm.type !== "FeatureCollection") fail(`${name} not a FeatureCollection`);
}

// --- drone AOIs ---
read("drone-aois.geojson");

if (errors.length) {
  console.error("[check-data] FAILED:\n - " + errors.join("\n - "));
  process.exit(1);
}
console.log("[check-data] OK - all baked data passed validation.");
