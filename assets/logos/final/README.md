# Logo Assets

Production-ready logo files for Neura and McLean Capital. All SVGs use transparent backgrounds — apply background via containing element.

## Files

| File                        | Use                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `neura-mark.svg`            | Neura flat mark, dark theme (favicon, tray icon, wordmark lockups, README header on dark-mode GitHub) |
| `neura-mark-light.svg`      | Neura flat mark, light theme                                                                          |
| `neura-app-icon.svg`        | Neura app icon — rounded dark container + N Mark (desktop dock, apple-touch-icon, PWA, installer)     |
| `neura-app-icon-light.svg`  | Neura app icon, light theme (cream container + dark N for light-mode contexts)                        |
| `mclean-mark.svg`           | McLean Capital square mark (dark theme)                                                               |
| `mclean-mark-light.svg`     | McLean Capital square mark (light theme)                                                              |
| `mclean-wordmark.svg`       | McLean Capital horizontal wordmark (dark theme)                                                       |
| `mclean-wordmark-light.svg` | McLean Capital horizontal wordmark (light theme)                                                      |

## Colors

From `DESIGN.md`:

| Token           | Dark theme | Light theme | Use                       |
| --------------- | ---------- | ----------- | ------------------------- |
| Neutral ink     | `#E8E4DE`  | `#1a1a1a`   | Frame, vertical strokes   |
| Amber (primary) | `#D4940A`  | `#B87A00`   | Accent stroke, brand mark |

## Theme switching in READMEs

Use GitHub's `<picture>` tag to serve the correct variant automatically:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/final/neura-mark.svg" />
  <img alt="Neura" src="assets/logos/final/neura-mark-light.svg" width="80" />
</picture>
```

## Raster exports

Run `npm run logos:export` from the repo root to regenerate PNG variants from these SVG sources. See `tools/logos/export-rasters.mjs` for the list of output sizes and destinations.
