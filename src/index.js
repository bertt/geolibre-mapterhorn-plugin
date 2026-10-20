const PLUGIN_ID = "geolibre-mapterhorn";
const TERRAIN_SOURCE_ID = "geolibre-terrain-dem"; // source id GeoLibre uses for terrain
const PANEL_ID = `${PLUGIN_ID}-panel`;
const MENU_ID = `${PLUGIN_ID}-menu`;

const MAPTERHORN_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const CESIUM_URL = "https://terrain.reearth.land/terrarium/elevation/{z}/{x}/{y}.png";
const CESIUM_MAX_ZOOM = 15;
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

let settings = { preset: "mapterhorn", ...PRESETS.mapterhorn, cesiumUrl: CESIUM_URL, cesiumMaxZoom: CESIUM_MAX_ZOOM };
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
  const cesiumMaxZoom = Number(input?.cesiumMaxZoom);
  const cesium = {
    cesiumUrl:
      typeof input?.cesiumUrl === "string" && input.cesiumUrl.trim()
        ? input.cesiumUrl.trim()
        : CESIUM_URL,
    cesiumMaxZoom: cesiumMaxZoom > 0 ? cesiumMaxZoom : CESIUM_MAX_ZOOM,
  };
  if (preset !== "custom") return { preset, ...base, ...cesium };
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
    ...cesium,
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

// --- Cesium ---------------------------------------------------------------

const CESIUM_GRID = 65;
let cesiumState = null; // { viewer, original, provider, listener, remove }

function decodeHeight(encoding, r, g, b) {
  return encoding === "mapbox"
    ? -10000 + (r * 65536 + g * 256 + b) * 0.1
    : r * 256 + g + b / 256 - 32768;
}

function createCesiumProvider(Cesium, config) {
  const tilingScheme = new Cesium.WebMercatorTilingScheme();
  const levelZeroError = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
    tilingScheme.ellipsoid,
    CESIUM_GRID,
    tilingScheme.getNumberOfXTilesAtLevel(0),
  );
  const errorEvent = new Cesium.Event();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const flat = () =>
    new Cesium.HeightmapTerrainData({
      buffer: new Float32Array(CESIUM_GRID * CESIUM_GRID),
      width: CESIUM_GRID,
      height: CESIUM_GRID,
    });

  return {
    errorEvent,
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
      const url = config.url
        .replace("{z}", level)
        .replace("{x}", x)
        .replace("{y}", y);
      try {
        const response = await fetch(url);
        if (!response.ok) return flat();
        const bitmap = await createImageBitmap(await response.blob(), {
          colorSpaceConversion: "none",
          premultiplyAlpha: "none",
        });
        const { width, height } = bitmap;
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const pixels = ctx.getImageData(0, 0, width, height).data;
        const heights = new Float32Array(CESIUM_GRID * CESIUM_GRID);
        for (let row = 0; row < CESIUM_GRID; row++) {
          const py = Math.round((row / (CESIUM_GRID - 1)) * (height - 1));
          for (let col = 0; col < CESIUM_GRID; col++) {
            const px = Math.round((col / (CESIUM_GRID - 1)) * (width - 1));
            const i = (py * width + px) * 4;
            heights[row * CESIUM_GRID + col] = decodeHeight(
              config.encoding,
              pixels[i],
              pixels[i + 1],
              pixels[i + 2],
            );
          }
        }
        return new Cesium.HeightmapTerrainData({
          buffer: heights,
          width: CESIUM_GRID,
          height: CESIUM_GRID,
        });
      } catch {
        return flat();
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
  if (settings.preset === "aws") {
    releaseCesium(true);
    return;
  }
  const config = {
    url: settings.cesiumUrl,
    maxZoom: settings.cesiumMaxZoom,
    encoding: settings.encoding,
    credit: settings.credit,
  };
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

function apply() {
  clearTimeout(retryTimer);
  if (!appApi) return;
  const renderer = appApi.getMapRenderer?.() ?? "maplibre";
  try {
    if (renderer !== "cesium") releaseCesium(true);
    if (renderer === "maplibre" || renderer === "mapbox") {
      const map = appApi.getMap?.() ?? appApi.getMapboxMap?.();
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
    } else if (renderer === "cesium") {
      detachMapListener();
      const handle = appApi.getCesiumScene?.();
      if (!handle) {
        retryTimer = setTimeout(apply, 500);
        return;
      }
      applyCesium(handle);
      setStatus(
        settings.preset === "aws"
          ? "Cesium: GeoLibre default terrain."
          : `Cesium: terrain from ${settings.cesiumUrl}`,
      );
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

  const cesiumUrl = document.createElement("input");
  cesiumUrl.type = "text";
  const cesiumMaxZoom = document.createElement("input");
  cesiumMaxZoom.type = "number";
  cesiumMaxZoom.min = "1";
  cesiumMaxZoom.max = "24";

  const fields = [url, credit, encoding, tileSize, maxZoom];
  const sync = () => {
    preset.value = settings.preset;
    url.value = settings.url;
    credit.value = settings.credit;
    encoding.value = settings.encoding;
    tileSize.value = String(settings.tileSize);
    maxZoom.value = String(settings.maxZoom);
    cesiumUrl.value = settings.cesiumUrl;
    cesiumMaxZoom.value = String(settings.cesiumMaxZoom);
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
      cesiumUrl: cesiumUrl.value,
      cesiumMaxZoom: cesiumMaxZoom.value,
    });
    sync();
    apply();
  });

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.textContent = "Back to default (AWS)";
  resetButton.addEventListener("click", () => {
    settings = sanitize({ ...settings, preset: "aws" });
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
    field("Cesium terrain URL ({z}/{x}/{y})", cesiumUrl),
    field("Cesium max zoom", cesiumMaxZoom),
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
            settings = sanitize({ ...settings, preset: "mapterhorn" });
            apply();
          },
        },
        {
          id: "aws",
          label: "Use AWS Terrarium (default)",
          onSelect: () => {
            settings = sanitize({ ...settings, preset: "aws" });
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
