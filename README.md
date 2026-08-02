<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="OmniLauncher icon">
</p>

<h1 align="center">OmniLauncher</h1>

<p align="center">A third party open source game launcher for Linux.</p>

---

OmniLauncher brings your Steam, GOG, Epic Games, and Amazon Games libraries together in a
single, unified interface. It doesn't replace those clients — it drives them: Steam directly,
and GOG/Epic/Amazon through [Heroic Games Launcher](https://heroicgameslauncher.com/)'s bundled
backends (`gogdl`, `legendary`, `nile`).

## Features

- **One library, every store** — Steam, GOG, Epic, and Amazon games in a single grid, filterable
  by store or installed status.
- **Install, launch, and uninstall from one place** — no store client window getting in the way.
  Confirmation dialogs Steam requires (install/uninstall) are handled and backgrounded
  automatically once they're no longer needed.
- **Real progress, always** — install progress is read live from each backend, including Steam's
  own on-disk state, so the UI never lies about what's actually happening.
- **In-app store login** — log in to GOG, Epic, and Amazon without leaving the app; the
  authorization code is captured automatically, no copy-pasting required. Steam login stays in
  the Steam client itself, where it actually lives.
- **Cover art** — fetched from [SteamGridDB](https://www.steamgriddb.com/) and cached locally, so
  art never depends on a live connection to the store's own CDN.
- **Controller-first navigation** — full gamepad support with D-pad/stick navigation, shoulder
  buttons to cycle library tabs, and automatic input lockout while a game is running so a
  controller input never accidentally lands on the launcher instead of your game.
- **TV-friendly UI scaling** — a display scale setting for couch/TV use, independent of your
  desktop's own scaling.

## Installation

Download the latest AppImage from the Releases page, make it executable, and run it:

```bash
chmod +x OmniLauncher-*.AppImage
./OmniLauncher-*.AppImage
```

## Building from source

```bash
npm install
npm run build:linux
```

The AppImage is written to `dist/`.

## Development

```bash
npm install
npm run dev
```

## How it works

OmniLauncher detects your installed clients and their libraries by reading the same local files
Steam and Heroic themselves use — `appmanifest_*.acf` for Steam, and Heroic's own cache/config
directories for GOG/Epic/Amazon. Installs, launches, and uninstalls are dispatched through each
store's real CLI or URI scheme; nothing is scraped, reverse-engineered, or run through an
unofficial API. Your credentials for GOG, Epic, and Amazon never pass through OmniLauncher — the
in-app login flow is a normal browser-based OAuth login rendered in an app-controlled window, the
same as any other Electron app that embeds a login page.

## Disclaimer

OmniLauncher is an independent, unofficial project and is not affiliated with, endorsed by, or
associated with Valve, GOG, Epic Games, Amazon, or Heroic Games Launcher. All product names,
logos, and brands referenced belong to their respective owners.
