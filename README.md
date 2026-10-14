# GeoLibre Mapterhorn Terrain Plugin

A [GeoLibre](https://github.com/opengeos/GeoLibre) plugin that lets you switch 3D terrain between the built-in
AWS Terrarium tiles and [Mapterhorn](https://mapterhorn.com/) terrain tiles, and back again.

GeoLibre Plugin: https://plugins.geolibre.app/catalog/geolibre-mapterhorn/

<img width="953" height="484" alt="image" src="https://github.com/user-attachments/assets/a437ee16-a7ff-4697-b6cc-aed93af4fc7e" />

By default GeoLibre uses Terrarium tiles from
`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. This plugin replaces the terrain
DEM source with Mapterhorn's Terrarium-encoded WebP tiles (or a custom tile source) and restores the default when
you switch back or disable the plugin.

<img width="1918" height="1032" alt="image" src="https://github.com/user-attachments/assets/5733b12a-500a-4159-85d2-37f6141a82d1" />

## How it works in GeoLibre

Using the plugin is a two-stage rocket:

1. **First enable 3D terrain** in GeoLibre: check **Controls → Terrain**. This shows the terrain with the default AWS Terrarium tiles.
2. **Then switch the source in the plugin** from AWS Terrarium to Mapterhorn (via the **Terrain** toolbar menu: **Use Mapterhorn**).

Terrain exaggeration can be adjusted by double-clicking the GeoLibre terrain button.
## Features

- Switch between **Mapterhorn**, **AWS Terrarium (GeoLibre default)** and a **Custom** DEM source.
- Configurable URL template, credit (attribution), encoding (Terrarium or Mapbox Terrain-RGB), tile size and max zoom for custom sources.
- Keeps the terrain on/off state and exaggeration when switching; re-applies after a basemap/style reload.
- Settings are saved in the GeoLibre project file.

## Settings

| Setting | Default (Mapterhorn) | Description |
| --- | --- | --- |
| URL | `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` | Tile URL template with `{z}`, `{x}`, `{y}`. |
| Credit | `Mapterhorn` | Attribution shown on the map. |
| Encoding | `terrarium` | DEM encoding (`terrarium` or `mapbox`). |
| Tile size | `512` | Tile size in pixels. |
| Max zoom | `17` | Highest zoom level served. |

All values except the provider are editable when **Custom** is selected.

## Renderer support

| Renderer | Status |
| --- | --- |
| MapLibre | Supported |
| Cesium | Not yet (may be added later using [cesium-mapterhorn-provider](https://github.com/bertt/cesium-mapterhorn-provider)) |
| Mapbox, ArcGIS | Not supported |

On unsupported renderers GeoLibre suspends the plugin.

## Install

Requires GeoLibre 0.9.0 or newer.

- **From the plugin registry** (once published in [geolibre-plugins](https://github.com/opengeos/geolibre-plugins)):
  open **Plugins → Manage Plugins…**, find *Mapterhorn Terrain* and install it.
- **From a zip file:** download `geolibre-mapterhorn-<version>.zip` from the
  [Releases](https://github.com/bertt/geolibre-mapterhorn-plugin/releases) page, then use
  **Manage Plugins → Settings → Install from file**.
- **For development:** build the plugin (below) and add the `dist/geolibre-mapterhorn` folder under
  **Settings → Plugins** as a development directory.

## Usage

Use the **Terrain** toolbar menu: **Use Mapterhorn**, **Use AWS Terrarium (default)**, or
**Terrain provider…** to open the settings panel. Enable 3D terrain in GeoLibre (Controls → Terrain) first to see the result.

## Build

Requires Node.js 18+.

```bash
npm install
npm run build            # dist/geolibre-mapterhorn/{plugin.json,index.js,style.css}
npm run package:geolibre # also creates dist/geolibre-mapterhorn-<version>.zip and prints its SHA-256
```

## Creating a release

1. Bump the version in `geolibre-plugin/plugin.json` (the build and zip name use this) and in `package.json`.
2. Build and package:
   ```bash
   npm run package:geolibre
   ```
   This creates `dist/geolibre-mapterhorn-<version>.zip` and `.zip.sha256`, and prints the SHA-256.
3. Commit, tag and push:
   ```bash
   git commit -am "Release v<version>"
   git tag v<version>
   git push && git push --tags
   ```
4. Create the GitHub release and attach the zip and checksum:
   ```bash
   gh release create v<version> dist/geolibre-mapterhorn-<version>.zip dist/geolibre-mapterhorn-<version>.zip.sha256 --generate-notes
   ```
5. To publish in the plugin registry, update the entry (download URL and SHA-256) in
   [geolibre-plugins](https://github.com/opengeos/geolibre-plugins).

## Credits

Terrain data: [Mapterhorn](https://mapterhorn.com/). Default GeoLibre terrain:
[AWS Open Data Terrain Tiles](https://registry.opendata.aws/terrain-tiles/).

## License

MIT
