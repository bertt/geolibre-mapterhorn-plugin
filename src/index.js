const PLUGIN_ID = "geolibre-mapterhorn";
const TERRAIN_SOURCE_ID = "geolibre-terrain-dem"; // source id GeoLibre uses for terrain
const PANEL_ID = `${PLUGIN_ID}-panel`;
const MENU_ID = `${PLUGIN_ID}-menu`;

const PROVIDERS = {
  aws: {
    label: "AWS Terrarium (GeoLibre default)",
    url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    credit: "AWS Open Data Terrain Tiles",
    tileSize: 256,
    maxZoom: 15,
  },
  mapterhorn: {
    label: "Mapterhorn",
    url: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
    credit: "Mapterhorn",
    tileSize: 512,
    maxZoom: 17,
  },
  rearth: {
    label: "Re:Earth Ellipsoid",
    url: "https://terrain.reearth.land/mapterhorn-egm08/terrarium/ellipsoid/{z}/{x}/{y}.webp",
    credit: "Re:Earth terrain",
    tileSize: 512,
    minZoom: 1, // the ellipsoid tile 0/0/0 returns HTTP 500
    maxZoom: 14,
  },
};
const defaultUrls = () =>
  Object.fromEntries(Object.entries(PROVIDERS).map(([key, p]) => [key, p.url]));

let settings = { provider: "aws", urls: defaultUrls() };
const current = () => ({ ...PROVIDERS[settings.provider], url: settings.urls[settings.provider] });let appApi = null;
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
  const urls = defaultUrls();
  for (const key of Object.keys(urls)) {
    const value = input?.urls?.[key];
    if (typeof value === "string" && value.trim()) urls[key] = value.trim();
  }
  return { provider: PROVIDERS[input?.provider] ? input.provider : "aws", urls };
}

// --- MapLibre -------------------------------------------------------------

function applyMapLibre(map) {
  if (!map.isStyleLoaded?.() && !map.getStyle?.()) return false;
  const { url, tileSize, minZoom = 0, maxZoom, credit } = current();
  const terrain = map.getTerrain?.();
  const exaggeration = terrain?.exaggeration ?? 1;
  const existing = map.getSource(TERRAIN_SOURCE_ID);
  if (existing?.tiles?.[0] === url) return true;
  if (terrain) map.setTerrain(null);
  if (existing) map.removeSource(TERRAIN_SOURCE_ID);
  map.addSource(TERRAIN_SOURCE_ID, {
    type: "raster-dem",
    tiles: [url],
    tileSize,
    minzoom: minZoom,
    maxzoom: maxZoom,
    encoding: "terrarium",
    attribution: escapeHtml(credit),
  });
  if (terrain) map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
  return true;
}

function restoreMapLibre(map) {
  const saved = settings;
  settings = { provider: "aws", urls: defaultUrls() };
  try {
    applyMapLibre(map);
  } finally {
    settings = saved;
  }
}
// --- Shared tile decoding -------------------------------------------------

let canvas = null;
let ctx = null;

async function readTile({ url: template, minZoom = 0 }, z, x, y, signal) {
  if (z < minZoom) throw new Error("below min zoom");
  const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const { width, height } = bitmap;
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { width, height, pixels: ctx.getImageData(0, 0, width, height).data };
}

// Samples a grid x grid height array from a Terrarium tile.
function sampleHeights({ width, height, pixels }, grid) {
  const heights = new Float32Array(grid * grid);
  for (let row = 0; row < grid; row++) {
    const py = Math.round((row / (grid - 1)) * (height - 1));
    for (let col = 0; col < grid; col++) {
      const px = Math.round((col / (grid - 1)) * (width - 1));
      const i = (py * width + px) * 4;
      heights[row * grid + col] = pixels[i] * 256 + pixels[i + 1] + pixels[i + 2] / 256 - 32768;
    }
  }
  return heights;
}

// --- Cesium ---------------------------------------------------------------

const CESIUM_GRID = 65;
let cesiumState = null; // { viewer, original, provider, key, remove }

function createCesiumProvider(Cesium, config) {
  const tilingScheme = new Cesium.WebMercatorTilingScheme();
  const levelZeroError = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
    tilingScheme.ellipsoid,
    CESIUM_GRID,
    tilingScheme.getNumberOfXTilesAtLevel(0),
  );
  const terrainData = (buffer) =>
    new Cesium.HeightmapTerrainData({ buffer, width: CESIUM_GRID, height: CESIUM_GRID });

  return {
    errorEvent: new Cesium.Event(),
    credit: new Cesium.Credit(config.credit || "Terrain"),
    tilingScheme,
    ready: true,
    readyPromise: Promise.resolve(true),
    hasWaterMask: false,
    hasVertexNormals: false,
    availability: undefined,
    getLevelMaximumGeometricError: (level) => levelZeroError / (1 << level),
    getTileDataAvailable: (x, y, level) => level <= config.maxZoom,
    loadTileDataAvailability: () => undefined,
    async requestTileGeometry(x, y, level) {
      if (level > config.maxZoom) return undefined;
      try {
        return terrainData(sampleHeights(await readTile(config, level, x, y), CESIUM_GRID));
      } catch {
        return terrainData(new Float32Array(CESIUM_GRID * CESIUM_GRID));
      }
    },
  };
}
function releaseCesium(restore) {
  if (!cesiumState) return;
  const { viewer, original, remove } = cesiumState;
  cesiumState = null;
  try {
    remove?.();
    if (restore && !viewer.isDestroyed?.() && original) viewer.terrainProvider = original;
  } catch (error) {
    console.warn("Mapterhorn plugin: could not restore Cesium terrain.", error);
  }
}

function applyCesium(handle) {
  const { Cesium, viewer, scene } = handle;
  const config = current();
  // GeoLibre's own terrain is AWS Terrarium: leave it alone.
  if (settings.provider === "aws" && config.url === PROVIDERS.aws.url) {
    releaseCesium(true);
    return;
  }
  const key = JSON.stringify(config);
  if (cesiumState?.viewer === viewer && cesiumState.key === key) return;
  const original = cesiumState?.viewer === viewer ? cesiumState.original : viewer.terrainProvider;
  releaseCesium(false);
  const provider = createCesiumProvider(Cesium, config);
  const isOff = (p) => p instanceof Cesium.EllipsoidTerrainProvider;
  const install = () => {
    if (!viewer.isDestroyed?.() && !isOff(viewer.terrainProvider)) {
      viewer.terrainProvider = provider;
    }
  };
  // GeoLibre swaps the provider whenever terrain is toggled; take it over again.
  const remove = scene.terrainProviderChanged.addEventListener((current) => {
    if (current !== provider && !isOff(current)) {
      cesiumState.original = current;
      install();
    }
  });
  cesiumState = { viewer, original, provider, key, remove };
  install();
}

// --- Dispatch -------------------------------------------------------------

function detachMapListener() {
  if (mapRef && mapListener) mapRef.off("style.load", mapListener);
  mapRef = null;
  mapListener = null;
}

function applyFlat(name) {
  const map = appApi.getMap?.() ?? appApi.getMapboxMap?.();
  if (!map) return null;
  if (mapRef !== map) {
    detachMapListener();
    mapRef = map;
    // A style reload drops our source and GeoLibre re-adds its default.
    mapListener = () => applyMapLibre(map);
    map.on("style.load", mapListener);
  }
  return applyMapLibre(map) ? `${name}: ${current().label} terrain.` : null;
}

function apply() {
  clearTimeout(retryTimer);
  if (!appApi) return;
  const renderer = appApi.getMapRenderer?.() ?? "maplibre";
  const flat = renderer === "maplibre" || renderer === "mapbox";
  // Each handler returns a status message, or null when the renderer is not ready yet.
  const handlers = {
    maplibre: () => applyFlat("MapLibre"),
    mapbox: () => applyFlat("Mapbox"),
    cesium: () => {
      const handle = appApi.getCesiumScene?.();
      if (!handle) return null;
      applyCesium(handle);
      return `Cesium: ${current().label} terrain.`;
    },
  };
  try {
    if (renderer !== "cesium") releaseCesium(true);
    if (!flat) detachMapListener();
    if (!handlers[renderer]) {
      setStatus(`The ${renderer} renderer is not supported.`);
      return;
    }
    const message = handlers[renderer]();
    if (message) setStatus(message);
    if (!message) retryTimer = setTimeout(apply, 500);
  } catch (error) {
    console.error("Mapterhorn plugin: failed to apply terrain.", error);
    setStatus(`Error: ${error?.message ?? error}`);
  }
}

// --- UI -------------------------------------------------------------------

function renderPanel(container) {
  const wrap = document.createElement("div");
  wrap.className = "geolibre-mapterhorn-panel";

  const radios = {};
  const inputs = {};
  const rowEls = {};
  const rows = Object.entries(PROVIDERS).map(([key, p]) => {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `${PLUGIN_ID}-provider`;
    radio.value = key;
    const input = document.createElement("input");
    input.type = "text";
    radios[key] = radio;
    inputs[key] = input;
    const label = document.createElement("label");
    const title = document.createElement("span");
    const badge = document.createElement("span");
    badge.className = "geolibre-mapterhorn-badge";
    badge.textContent = "Active";
    title.append(radio, ` ${p.label} `, badge);
    label.append(title, input);
    rowEls[key] = label;
    return label;
  });

  const sync = () => {
    for (const key of Object.keys(PROVIDERS)) {
      radios[key].checked = key === settings.provider;
      rowEls[key].classList.toggle("active", key === settings.provider);
      inputs[key].value = settings.urls[key];
    }
  };
  sync();

  const update = () => {
    settings = sanitize({
      provider: Object.keys(radios).find((key) => radios[key].checked),
      urls: Object.fromEntries(Object.keys(inputs).map((key) => [key, inputs[key].value])),
    });
    sync();
    apply();
  };
  for (const key of Object.keys(PROVIDERS)) {
    radios[key].addEventListener("change", update);
    inputs[key].addEventListener("change", update);
  }

  statusEl = document.createElement("p");
  statusEl.className = "geolibre-mapterhorn-status";

  const version = document.createElement("p");
  version.className = "geolibre-mapterhorn-status";
  version.textContent = `Mapterhorn Terrain plugin v${__PLUGIN_VERSION__}`;

  wrap.append(...rows, statusEl, version);
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
      defaultWidth: 360,
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
        ...Object.entries(PROVIDERS).map(([key, p]) => ({
          id: key,
          label: `Use ${p.label}`,
          onSelect: () => {
            settings = sanitize({ ...settings, provider: key });
            apply();
          },
        })),
      ],
    }),
  );
}
export const plugin = {
  id: PLUGIN_ID,
  name: "Mapterhorn Terrain",
  version: __PLUGIN_VERSION__,
  engines: ["maplibre", "mapbox", "cesium"],
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
    releaseCesium(true);
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
