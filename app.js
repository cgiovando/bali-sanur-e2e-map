/* Bali / Sanur E2E Mapping - app.js
   Manifest-driven MapLibre map. Reads the static files baked by
   scripts/build-data.mjs (data/manifest.json + data/*.geojson).
   No live API calls happen here. */

"use strict";

const COLORS = {
  osmNew: "#d73f3f",
  osmEdited: "#4c78a8",
  infra: "#f59e0b",
  inter: "#8b5cf6",
  aoi: "#1f9d8f",
};

const ATTRIB = {
  osm: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  esri: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  oam: 'Drone imagery &copy; <a href="https://openaerialmap.org" target="_blank" rel="noopener">OpenAerialMap</a> / HOTOSM',
  chatmap: 'Field data: <a href="https://chatmap.hotosm.org" target="_blank" rel="noopener">ChatMap</a> / HOTOSM',
};

// Base style: two raster basemaps (OSM visible, Esri hidden). Overlays added after load.
const baseStyle = {
  version: 8,
  sources: {
    "basemap-osm": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: ATTRIB.osm,
    },
    "basemap-esri": {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 21,
      attribution: ATTRIB.esri,
    },
  },
  layers: [
    { id: "basemap-osm", type: "raster", source: "basemap-osm" },
    { id: "basemap-esri", type: "raster", source: "basemap-esri", layout: { visibility: "none" } },
  ],
};

const map = new maplibregl.Map({
  container: "map",
  style: baseStyle,
  center: [115.26, -8.685],
  zoom: 13,
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIB.oam + " | " + ATTRIB.chatmap }),
  "bottom-right"
);

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Boot: load manifest, then wire everything.
// ---------------------------------------------------------------------------
map.on("load", async () => {
  // The sidebar (collapse/expand) must work even if data fails to load.
  wireSidebar();

  let manifest;
  try {
    const res = await fetch("data/manifest.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    manifest = await res.json();
  } catch (err) {
    console.error("Could not load manifest:", err);
    showError("Could not load map data. Run `npm run build:data`, then reload.");
    return;
  }

  if (Array.isArray(manifest.bbox)) {
    map.fitBounds(
      [
        [manifest.bbox[0], manifest.bbox[1]],
        [manifest.bbox[2], manifest.bbox[3]],
      ],
      { padding: 30, duration: 0 }
    );
  }

  try {
    addOamLayers(manifest.oam || []);
    await addDroneAois();
    await addRecentOsm();
    await addChatmap("infrastructure", "data/chatmap-infrastructure.geojson", COLORS.infra);
    await addChatmap("intersections", "data/chatmap-intersections.geojson", COLORS.inter);
    // Intersections start hidden to reduce clutter (checkbox is unchecked).
    setVisibility(["chatmap-intersections"], false);
    wireLayerControls();
  } catch (err) {
    console.error("Layer setup failed:", err);
    showError("Some map layers failed to load. Check the console for details.");
  }

  populateMeta(manifest);
});

// Show a dismissible error banner over the map.
function showError(msg) {
  let el = document.getElementById("map-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "map-error";
    el.className = "map-error";
    el.setAttribute("role", "alert");
    document.getElementById("map").appendChild(el);
  }
  el.textContent = msg;
}

// ---------------------------------------------------------------------------
// OpenAerialMap raster overlays
// ---------------------------------------------------------------------------
const oamLayerIds = [];
function addOamLayers(oam) {
  oam.forEach((cap, i) => {
    const sid = "oam-" + i;
    map.addSource(sid, {
      type: "raster",
      tiles: [cap.tms],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 22,
      bounds: cap.bbox, // restrict requests to the footprint
      attribution: ATTRIB.oam,
    });
    map.addLayer({ id: sid, type: "raster", source: sid, paint: { "raster-fade-duration": 200 } });
    oamLayerIds.push(sid);
  });
  const c = $("#oam-count");
  if (c) c.textContent = oam.length ? `(${oam.length})` : "";
}

// ---------------------------------------------------------------------------
// Drone flight AOIs
// ---------------------------------------------------------------------------
async function addDroneAois() {
  map.addSource("drone-aois", { type: "geojson", data: "data/drone-aois.geojson" });
  map.addLayer({
    id: "drone-aoi-fill",
    type: "fill",
    source: "drone-aois",
    paint: { "fill-color": COLORS.aoi, "fill-opacity": 0.08 },
  });
  map.addLayer({
    id: "drone-aoi-line",
    type: "line",
    source: "drone-aois",
    paint: { "line-color": COLORS.aoi, "line-width": 2, "line-dasharray": [3, 2] },
  });
}

// ---------------------------------------------------------------------------
// Recent OSM (buildings, roads, points) styled new-vs-edited
// ---------------------------------------------------------------------------
async function addRecentOsm() {
  map.addSource("osm", { type: "geojson", data: "data/osm-recent.geojson" });

  const createdColor = ["case", ["get", "_created"], COLORS.osmNew, COLORS.osmEdited];
  const isPoly = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
  const isLine = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];

  map.addLayer({
    id: "osm-buildings-fill",
    type: "fill",
    source: "osm",
    filter: isPoly,
    paint: { "fill-color": createdColor, "fill-opacity": 0.18 },
  });
  map.addLayer({
    id: "osm-buildings-line",
    type: "line",
    source: "osm",
    filter: isPoly,
    paint: { "line-color": createdColor, "line-width": 1.5 },
  });
  map.addLayer({
    id: "osm-roads",
    type: "line",
    source: "osm",
    filter: isLine,
    paint: { "line-color": createdColor, "line-width": 2.5, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "osm-points",
    type: "circle",
    source: "osm",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 4,
      "circle-color": createdColor,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1,
    },
  });

  ["osm-buildings-fill", "osm-roads", "osm-points"].forEach((id) =>
    bindPopup(id, osmPopupHtml)
  );
}

// ---------------------------------------------------------------------------
// ChatMap point datasets
// ---------------------------------------------------------------------------
async function addChatmap(key, url, color) {
  const sid = "chatmap-" + key;
  map.addSource(sid, { type: "geojson", data: url });
  map.addLayer({
    id: sid,
    type: "circle",
    source: sid,
    paint: {
      "circle-radius": 6,
      "circle-color": color,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  bindPopup(sid, chatmapPopupHtml);
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------
function bindPopup(layerId, htmlFn) {
  map.on("click", layerId, (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
      .setLngLat(popupAnchor(f, e.lngLat))
      .setHTML(htmlFn(f))
      .addTo(map);
  });
  map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
}

// For point features, anchor on the actual coordinate; otherwise the click point.
function popupAnchor(f, lngLat) {
  if (f.geometry && f.geometry.type === "Point") return f.geometry.coordinates;
  return lngLat;
}

const INTERNAL_KEYS = new Set([
  "id", "type", "timestamp", "version", "changeset", "uid", "user",
  "_created", "_user", "_timestamp", "_version", "_osmId", "meta",
]);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Field data was collected in Bali (WITA, UTC+8); show times in that zone so
// they don't shift by a day for viewers in other timezones.
const BALI_TZ = "Asia/Makassar";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Format a real UTC instant (ISO string with Z) in Bali local time.
function fmtInstant(iso) {
  try {
    return (
      new Date(iso).toLocaleString(undefined, {
        timeZone: BALI_TZ, year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      }) + " WITA"
    );
  } catch {
    return String(iso);
  }
}

// ChatMap timestamps are wall-clock Bali time without a zone; render the literal
// components so the browser's timezone never shifts them.
function fmtFieldTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || "");
  if (!m) return s ? escapeHtml(s) : "";
  let h = +m[4];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}, ${h}:${m[5]} ${ap} WITA`;
}

// Render ChatMap media: photos as <img>, videos as <video>, anything else a link.
function mediaHtml(url) {
  if (!url) return "";
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  if (["mp4", "webm", "mov", "m4v", "ogg"].includes(ext)) {
    return `<video class="popup-img" src="${escapeHtml(url)}" controls preload="metadata"></video>`;
  }
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return `<img class="popup-img" src="${escapeHtml(url)}" alt="Field photo" loading="lazy" />`;
  }
  return `<a class="popup-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open attachment &nearr;</a>`;
}

function osmPopupHtml(f) {
  const p = f.properties || {};
  const created = p._created === true || p._created === "true";
  const tags = Object.keys(p)
    .filter((k) => !INTERNAL_KEYS.has(k) && p[k] !== "" && p[k] != null)
    .slice(0, 8);

  const title =
    p.name || p.building && "Building" || p.highway && "Road" || p.amenity || p.shop || "OSM feature";

  let rows = tags
    .map((k) => `<tr><td class="k">${escapeHtml(k)}</td><td>${escapeHtml(p[k])}</td></tr>`)
    .join("");

  const osmId = p._osmId || (p.type && p.id ? `${p.type}/${p.id}` : null);
  const osmLink = osmId
    ? `<a class="popup-link" href="https://www.openstreetmap.org/${osmId}" target="_blank" rel="noopener">View on OSM &nearr;</a>`
    : "";

  const badge = created
    ? '<span class="popup-badge badge-new">Created this week</span>'
    : '<span class="popup-badge badge-edited">Edited this week</span>';

  const meta = [];
  if (p._user) meta.push("by " + escapeHtml(p._user));
  if (p._timestamp) meta.push(fmtInstant(p._timestamp));
  if (p._version) meta.push("v" + p._version);

  return (
    `<p class="popup-title">${escapeHtml(title)}</p>` +
    badge +
    (rows ? `<table class="popup-table">${rows}</table>` : "") +
    (meta.length ? `<p class="popup-meta">${meta.join(" &middot; ")}</p>` : "") +
    osmLink
  );
}

function chatmapPopupHtml(f) {
  const p = f.properties || {};
  const media = mediaHtml(p.file);
  const msg = p.message ? `<p class="popup-msg">${escapeHtml(p.message)}</p>` : "";
  const time = p.time ? `<p class="popup-meta">${fmtFieldTime(p.time)}</p>` : "";
  const ds = p.dataset ? `<p class="popup-title">${escapeHtml(p.dataset)}</p>` : "";
  const body = media + msg + time;
  return ds + (body || '<p class="popup-meta">No details recorded.</p>');
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function setVisibility(layerIds, visible) {
  layerIds.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  });
}

const OVERLAY_LAYERS = {
  "lyr-oam": () => oamLayerIds,
  "lyr-osm": () => ["osm-buildings-fill", "osm-buildings-line", "osm-roads", "osm-points"],
  "lyr-infra": () => ["chatmap-infrastructure"],
  "lyr-inter": () => ["chatmap-intersections"],
  "lyr-aoi": () => ["drone-aoi-fill", "drone-aoi-line"],
};

// Basemap + overlay toggles - wired after layers exist.
function wireLayerControls() {
  document.querySelectorAll('input[name="basemap"]').forEach((r) => {
    r.addEventListener("change", () => {
      const osm = r.value === "osm";
      setVisibility(["basemap-osm"], osm);
      setVisibility(["basemap-esri"], !osm);
    });
  });

  Object.entries(OVERLAY_LAYERS).forEach(([inputId, getLayers]) => {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener("change", () => setVisibility(getLayers(), el.checked));
  });
}

// Sidebar collapse/expand - wired first, independent of data load.
function wireSidebar() {
  const sidebar = $("#sidebar");
  const openBtn = $("#sidebar-open");
  $("#sidebar-close").addEventListener("click", () => {
    sidebar.classList.add("collapsed");
    openBtn.classList.remove("hidden");
    setTimeout(() => map.resize(), 260);
  });
  openBtn.addEventListener("click", () => {
    sidebar.classList.remove("collapsed");
    openBtn.classList.add("hidden");
    setTimeout(() => map.resize(), 260);
  });
}

// ---------------------------------------------------------------------------
// Populate counts, links, "last updated"
// ---------------------------------------------------------------------------
function populateMeta(m) {
  const setCount = (sel, n) => {
    const el = $(sel);
    if (el && n != null) el.textContent = `(${n.toLocaleString()})`;
  };
  setCount("#osm-count", m.osm && m.osm.count);
  setCount("#infra-count", m.chatmap && m.chatmap.infrastructure && m.chatmap.infrastructure.count);
  setCount("#inter-count", m.chatmap && m.chatmap.intersections && m.chatmap.intersections.count);
  setCount("#aoi-count", m.drone && m.drone.aoi_count);

  const plan = m.plan || {};
  const planLink = $("#plan-link");
  if (planLink && plan.url) {
    planLink.href = plan.url;
    planLink.textContent = plan.name || "HOT Portal plan";
  }

  if (plan.tm) {
    const li = $("#src-tm");
    if (li)
      li.replaceChildren(
        makeLink(plan.tm.url, "Tasking Manager"),
        document.createTextNode(` - mapathon (${Number(plan.tm.percentMapped) || 0}% mapped)`)
      );
  }
  if (plan.field_tm) {
    const li = $("#src-ftm");
    if (li)
      li.replaceChildren(
        makeLink(plan.field_tm.base_url, "Field-TM"),
        document.createTextNode(" - " + (plan.field_tm.name || ""))
      );
  }

  if (m.generated_at) {
    const upd = $("#updated");
    if (upd)
      upd.textContent = `Data updated ${fmtInstant(m.generated_at)} - rolling ${m.window_days || 7}-day window.`;
  }
}

// Build an anchor with text set safely; only accept http(s) URLs.
function makeLink(href, text) {
  const a = document.createElement("a");
  a.textContent = text;
  if (/^https?:\/\//i.test(href || "")) {
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
  }
  return a;
}
