# Design System — Neura

## Product Context

- **What this is:** A real-time AI operating system with voice conversation and continuous vision understanding
- **Who it's for:** Developers and power users who want an always-on AI assistant
- **Space/industry:** AI assistants, developer tools, AI operating systems
- **Project type:** Desktop app (Electron), web app, eventually mobile
- **Platforms:** Desktop (macOS, Windows, Linux), web, mobile (future)

## Aesthetic Direction

- **Direction:** Industrial Precision
- **Decoration level:** Minimal — typography and status lighting do the work
- **Mood:** A dark instrument panel that's warm where it touches you, clinical everywhere else. Equipment-grade, not chatbot-friendly. The product should feel like picking up a precision tool for the first time.
- **Anti-slop rules:** No purple gradients. No rainbow gradients. No soft orb backgrounds. No generic assistant sparkles. No 3-column feature card grids. No centered hero with badge-headline-subhead-buttons-screenshot. No decorative AI lattice patterns. No smiling abstract assistant illustrations.

## Brand Identity

### N-Mark Icon

Abstract mark built from two vertical strokes + one diagonal channel, reading simultaneously as the letter N and a neural signal waveform. "Broadcast hardware badge meets stealth software insignia."

- **App icon:** Amber (#D4940A) stroke on rounded-square #0A0A0A field with subtle 1px inset border
- **Tray icon:** Monochrome stencil version with widened counters for menu-bar legibility
- **Favicon:** Core N-mark only, centered, no border
- **Form rules:** Strong silhouette first, detail second. Reads at 16x16 as a bold monogram. Scales to 1024x1024 with inset channeling and optical tension. No glow, no orbit rings, no generic spark/star.

### Wordmark

- Uppercase `NEURA` in Space Grotesk Medium
- letter-spacing: 0.15em
- Tight enough to feel engineered, not luxury fashion

## Typography

- **Display/Wordmark:** Space Grotesk (600) — geometric with quirks, "built for purpose" DNA. For headlines, hero text, wordmark.
- **Body/UI:** Geist (400/500) — clean, modern, purpose-built for interfaces. Free. For all UI labels, body text, controls.
- **Data/Transcripts:** JetBrains Mono (400/500) — developer credibility, distinct letterforms, tabular-nums. For transcripts, logs, data tables, cost displays.
- **Code:** JetBrains Mono (400)
- **Marketing/Long-form:** IBM Plex Sans (400/500/600) — engineered-tool energy, crisp at small sizes. For docs, marketing pages, long-form content.
- **Loading:** Google Fonts for Space Grotesk, JetBrains Mono, IBM Plex Sans. Vercel CDN for Geist.
- **Scale:**
  - 3xl: 36px / 2.25rem (hero headlines)
  - 2xl: 24px / 1.5rem (section headings)
  - xl: 20px / 1.25rem (subheadings)
  - lg: 16px / 1rem (large body)
  - md: 14px / 0.875rem (default body, UI)
  - sm: 12px / 0.75rem (labels, badges, captions)
  - xs: 11px / 0.6875rem (mono labels, timestamps)
  - 2xs: 10px / 0.625rem (tertiary metadata)

```css
--font-display: 'Space Grotesk', system-ui, sans-serif;
--font-body: 'Geist', system-ui, sans-serif;
--font-mono: 'JetBrains Mono', 'SF Mono', monospace;
--font-marketing: 'IBM Plex Sans', system-ui, sans-serif;
```

## Color

- **Approach:** Restrained — amber is the only warm color, everything else is clinical

### Surfaces (dark mode)

| Token         | Hex       | Usage                                       |
| ------------- | --------- | ------------------------------------------- |
| `--surface-0` | `#050505` | Deepest background, app shell, tray popover |
| `--surface-1` | `#0A0A0A` | Primary canvas                              |
| `--surface-2` | `#111111` | Elevated panels, cards, modals              |
| `--surface-3` | `#1A1A1A` | Hover states, borders, dividers             |
| `--surface-4` | `#242424` | Active/pressed states, input fields         |

### Text

| Token              | Hex       | Usage                                             |
| ------------------ | --------- | ------------------------------------------------- |
| `--text-primary`   | `#E8E4DE` | Primary text — warm cream, not pure white         |
| `--text-secondary` | `#6B6560` | Secondary text — warm gray, readable but recessed |
| `--text-tertiary`  | `#3D3A36` | Disabled text, timestamps, metadata               |

### Accent

| Token             | Hex       | Usage                                                                      |
| ----------------- | --------- | -------------------------------------------------------------------------- |
| `--accent`        | `#D4940A` | Primary amber — brass, not warning. Actions, active states, brand moments. |
| `--accent-bright` | `#F5B731` | Highlights, focus rings, active indicators                                 |
| `--accent-dim`    | `#7A5500` | Amber backgrounds, badges, subtle emphasis                                 |

### Semantic / Signal

| Token             | Hex       | Usage                                                                               |
| ----------------- | --------- | ----------------------------------------------------------------------------------- |
| `--signal-active` | `#2AD468` | Session active, connected, success                                                  |
| `--signal-vision` | `#3B82F6` | Vision/camera active — cool blue to contrast amber. Hearing = amber, seeing = blue. |
| `--signal-danger` | `#E5484D` | Errors, disconnect, cost warnings                                                   |

### Borders

| Token             | Hex       | Usage                        |
| ----------------- | --------- | ---------------------------- |
| `--border-subtle` | `#1A1A1A` | Card borders, dividers       |
| `--border-focus`  | `#D4940A` | Focus rings, selected states |

### Light mode strategy

Invert surfaces to warm paper tones (#F5F2E8 base, #FFFFFF elevated). Darken accent to #B87A00 for contrast. Reduce signal saturation. Keep the same semantic structure.

## Spacing

- **Base unit:** 4px
- **Density:** Comfortable
- **Scale:**
  - 2xs: 2px
  - xs: 4px
  - sm: 8px
  - md: 16px
  - lg: 24px
  - xl: 32px
  - 2xl: 48px
  - 3xl: 64px

## Layout

- **Approach:** Asymmetric, left-biased
- **Grid:** Single column for app UI, 12-column for marketing
- **Max content width:** 960px (marketing), 480px (app UI)
- **Border radius:**
  - sm: 4px (alerts, inline elements)
  - md: 8px (cards, inputs, panels)
  - lg: 12px (modals, elevated surfaces)
  - full: 9999px (buttons, badges, pills)
- **Layout principles:**
  - Transcripts flush-left, monospace, like terminal output — no chat bubbles
  - Vision context docked right on desktop, pull-down panel on mobile
  - The product should look like it's already doing work when you open it
  - Bias left. Dock controls. Never center by default.

## Motion

- **Approach:** Minimal-functional with mechanical feel
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms)
- **Principles:**
  - No loading spinners — use real telemetry (waveforms, frame scans, state labels)
  - Motion should feel mechanical: fades, wipes, scan sweeps
  - Pulse animation for active mic (amber ring)
  - State transitions only — no decorative animation

## Icon Assets Needed

| Asset               | Size         | Format            | Notes                       |
| ------------------- | ------------ | ----------------- | --------------------------- |
| App icon (macOS)    | 1024x1024    | .icns             | Rounded square with N-mark  |
| App icon (Windows)  | 256x256      | .ico (multi-size) | 16, 32, 48, 256             |
| App icon (Linux)    | 512x512      | .png              | Square with N-mark          |
| Tray icon (macOS)   | 22x22 @2x    | .png template     | Monochrome, Template suffix |
| Tray icon (Windows) | 16x16, 32x32 | .ico              | Monochrome                  |
| Favicon             | 32x32        | .ico + .svg       | N-mark only                 |
| Apple touch icon    | 180x180      | .png              | Rounded square              |
| OG image            | 1200x630     | .png              | For social cards            |
| PWA icons           | 192, 512     | .png              | Maskable + regular          |

## Decisions Log

| Date       | Decision                                                         | Rationale                                                                                           |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-03-30 | Initial design system created                                    | Created by /design-consultation from codebase analysis + Codex + Claude subagent                    |
| 2026-03-30 | Deepened amber from #f59e0b to #D4940A                           | Brass > warning. More refined, less cautionary.                                                     |
| 2026-03-30 | Added blue (#3B82F6) for vision features                         | Creates hearing (amber) vs seeing (blue) semantic distinction matching the product's two modalities |
| 2026-03-30 | Warm cream text (#E8E4DE) instead of pure white                  | Coheres with amber warmth, reduces clinical harshness                                               |
| 2026-03-30 | Space Grotesk for display, Geist for UI, JetBrains Mono for data | Equipment-grade type hierarchy. All free/open source.                                               |
| 2026-03-30 | Asymmetric layout, left-biased                                   | Breaks from centered chat-app pattern. Signals "operating system, not chatbot."                     |
| 2026-03-30 | No loading spinners policy                                       | Real telemetry as aesthetic. Waveforms, frame scans, state labels.                                  |
