const PLUGIN_ID = "geolibre-mapterhorn";
const TERRAIN_SOURCE_ID = "geolibre-terrain-dem"; // source id GeoLibre uses for terrain
const PANEL_ID = `${PLUGIN_ID}-panel`;
const MENU_ID = `${PLUGIN_ID}-menu`;

const MAPTERHORN_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const AWS_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const PRESETS = {
  mapterhorn: {
    label: "Mapterhorn",
    url: MAPTERHORN_URL,
    credit: "Mapterhorn",
    encoding: "terrarium",
    tileSize: 512,
    maxZoom: 17,
  },
  aws: {
    label: "AWS Terrarium (GeoLibre default)",
    url: AWS_URL,
    credit: "AWS Open Data Terrain Tiles",
    encoding: "terrarium",
    tileSize: 256,
    maxZoom: 15,
  },
  custom: {
    label: "Custom",
    url: MAPTERHORN_URL,
    credit: "Custom terrain",
    encoding: "terrarium",
    tileSize: 512,
    maxZoom: 17,
  },
};

let settings = { preset: "mapterhorn", ...PRESETS.mapterhorn };
let appApi = null;
let disposers = [];
let mapListener = null;
let mapRef = null;
let retryTimer = null;
let statusEl = null;

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function sanitize(input) {
  const preset = PRESETS[input?.preset] ? input.preset : "mapterhorn";
  const base = PRESETS[preset];
  if (preset !== "custom") return { preset, ...base };
  const tileSize = Number(input.tileSize);
  const maxZoom = Number(input.maxZoom);
  return {
    preset,
    url: typeof input.url === "string" && input.url.trim() ? input.url.trim() : base.url,
    credit: typeof input.credit === "string" ? input.credit : base.credit,
    encoding: input.encoding === "mapbox" ? "mapbox" : "terrarium",
    tileSize: tileSize > 0 ? tileSize : base.tileSize,
    maxZoom: maxZoom > 0 ? maxZoom : base.maxZoom,
    label: base.label,
  };
}

// --- MapLibre -------------------------------------------------------------

function applyMapLibre(map) {
  if (!map.isStyleLoaded?.() && !map.getStyle?.()) return false;
  const terrain = map.getTerrain?.();
  const wasEnabled = Boolean(terrain);
  const exaggeration = terrain?.exaggeration ?? 1;
  const existing = map.getSource(TERRAIN_SOURCE_ID);
  if (existing?.tiles?.[0] === settings.url && existing.encoding === settings.encoding) {
    return true;
  }
  if (wasEnabled) map.setTerrain(null);
  if (existing) map.removeSource(TERRAIN_SOURCE_ID);
  map.addSource(TERRAIN_SOURCE_ID, {
    type: "raster-dem",
    tiles: [settings.url],
    tileSize: settings.tileSize,
    maxzoom: settings.maxZoom,
    encoding: settings.encoding,
    attribution: escapeHtml(settings.credit),
  });
  if (wasEnabled) map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
  return true;
}

function restoreMapLibre(map) {
  const defaults = PRESETS.aws;
  const saved = settings;
  settings = { preset: "aws", ...defaults };
  try {
    applyMapLibre(map);
  } finally {
    settings = saved;
  }
}

// --- Dispatch -------------------------------------------------------------

function detachMapListener() {
  if (mapRef && mapListener) mapRef.off("style.load", mapListener);
  mapRef = null;
  mapListener = null;
}

function apply() {
  clearTimeout(retryTimer);
  if (!appApi) return;
  const renderer = appApi.getMapRenderer?.() ?? "maplibre";
  try {
    if (renderer === "maplibre" || renderer === "mapbox") {
      const map = appApi.getMap?.();
      if (!map) {
        retryTimer = setTimeout(apply, 500);
        return;
      }
      if (mapRef !== map) {
        detachMapListener();
        mapRef = map;
        // A style reload drops our source and GeoLibre re-adds its default.
        mapListener = () => applyMapLibre(map);
        map.on("style.load", mapListener);
      }
      if (!applyMapLibre(map)) {
        retryTimer = setTimeout(apply, 500);
        return;
      }
      setStatus(`${renderer === "mapbox" ? "Mapbox" : "MapLibre"}: ${settings.label} terrain.`);
    } else {
      setStatus(`The ${renderer} renderer is not supported.`);
    }
  } catch (error) {
    console.error("Mapterhorn plugin: failed to apply terrain.", error);
    setStatus(`Error: ${error?.message ?? error}`);
  }
}

// --- UI -------------------------------------------------------------------

function field(labelText, control) {
  const label = document.createElement("label");
  label.append(labelText, control);
  return label;
}

function renderPanel(container) {
  const wrap = document.createElement("div");
  wrap.className = "geolibre-mapterhorn-panel";

  const preset = document.createElement("select");
  for (const [key, value] of Object.entries(PRESETS)) {
    preset.add(new Option(value.label, key));
  }
  const url = document.createElement("input");
  url.type = "text";
  const credit = document.createElement("input");
  credit.type = "text";
  const encoding = document.createElement("select");
  encoding.add(new Option("Terrarium", "terrarium"));
  encoding.add(new Option("Mapbox Terrain-RGB", "mapbox"));
  const tileSize = document.createElement("input");
  tileSize.type = "number";
  tileSize.min = "1";
  const maxZoom = document.createElement("input");
  maxZoom.type = "number";
  maxZoom.min = "1";
  maxZoom.max = "24";

  const fields = [url, credit, encoding, tileSize, maxZoom];
  const sync = () => {
    preset.value = settings.preset;
    url.value = settings.url;
    credit.value = settings.credit;
    encoding.value = settings.encoding;
    tileSize.value = String(settings.tileSize);
    maxZoom.value = String(settings.maxZoom);
    for (const el of fields) el.disabled = settings.preset !== "custom";
  };
  sync();

  preset.addEventListener("change", () => {
    settings = sanitize({ ...settings, preset: preset.value });
    sync();
    apply();
  });

  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.textContent = "Apply";
  applyButton.addEventListener("click", () => {
    settings = sanitize({
      preset: preset.value,
      url: url.value,
      credit: credit.value,
      encoding: encoding.value,
      tileSize: tileSize.value,
      maxZoom: maxZoom.value,
    });
    sync();
    apply();
  });

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.textContent = "Back to default (AWS)";
  resetButton.addEventListener("click", () => {
    settings = sanitize({ preset: "aws" });
    sync();
    apply();
  });

  const actions = document.createElement("div");
  actions.className = "geolibre-mapterhorn-actions";
  actions.append(applyButton, resetButton);

  statusEl = document.createElement("p");
  statusEl.className = "geolibre-mapterhorn-status";

  wrap.append(
    field("Terrain provider", preset),
    field("URL template ({z}/{x}/{y})", url),
    field("Credit", credit),
    field("Encoding", encoding),
    field("Tile size (px)", tileSize),
    field("Max zoom", maxZoom),
    actions,
    statusEl,
  );
  container.appendChild(wrap);
  return () => {
    wrap.remove();
    statusEl = null;
  };
}

function registerUi(app) {
  const keep = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
  };
  keep(
    app.registerFloatingPanel?.({
      id: PANEL_ID,
      title: "Terrain provider",
      defaultWidth: 320,
      render: renderPanel,
    }),
  );
  keep(
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: "Terrain",
      items: [
        {
          id: "open",
          label: "Terrain provider…",
          disabled: !app.openFloatingPanel,
          onSelect: () => app.openFloatingPanel?.(PANEL_ID),
        },
        {
          id: "mapterhorn",
          label: "Use Mapterhorn",
          onSelect: () => {
            settings = sanitize({ preset: "mapterhorn" });
            apply();
          },
        },
        {
          id: "aws",
          label: "Use AWS Terrarium (default)",
          onSelect: () => {
            settings = sanitize({ preset: "aws" });
            apply();
          },
        },
      ],
    }),
  );
}

export const plugin = {
  id: PLUGIN_ID,
  name: "Mapterhorn Terrain",
  version: __PLUGIN_VERSION__,
  engines: ["maplibre", "mapbox"],
  activate(app) {
    appApi = app;
    registerUi(app);
    apply();
  },
  deactivate() {
    clearTimeout(retryTimer);
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        console.error("Mapterhorn plugin cleanup failed.", error);
      }
    }
    const map = mapRef;
    detachMapListener();
    try {
      if (map) restoreMapLibre(map);
    } catch (error) {
      console.warn("Mapterhorn plugin: could not restore MapLibre terrain.", error);
    }
    appApi = null;
  },
  getProjectState() {
    return { ...settings };
  },
  applyProjectState(state) {
    if (state && typeof state === "object") {
      settings = sanitize(state);
      apply();
    }
  },
};

export default plugin;
