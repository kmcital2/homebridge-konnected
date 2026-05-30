# Local development

This fork is developed on a MacBook Pro and loaded from local files by a
self-contained Homebridge instance — fully isolated from the production
Homebridge running on the Mac mini.

## What this fork does differently

The upstream plugin talks to Konnected's **classic** firmware (SSDP discovery,
`PUT /settings` provisioning, panels POST zone state to a listener). The
Konnected Alarm Panel Pro now ships **ESPHome** firmware, which this fork
targets instead:

- **Transport:** `src/esphomeClient.ts` subscribes to each panel's ESPHome web
  server SSE stream (`GET /events`) for zone state and uses the REST API
  (`POST /<domain>/<object_id>/<action>`) to actuate switches. No SSDP, no
  provisioning — the zones already live in the firmware build.
- **Config model:** each panel has a `host` (+ stable `id`) and a list of
  `zones`, each mapping an ESPHome `entityId` (e.g. `binary_sensor-front_hall_motion`)
  to a HomeKit `type` (`contact`/`motion`/`smoke`/`water`/`siren`/`switch`/…),
  a display `name`, and optional `invert`. See `.dev-homebridge/config.json`.
- **Status:** Milestone 1 (zones as plain sensors + siren as a switch) is
  working. Milestone 2 (the plugin-managed HomeKit Security System) is
  implemented and opt-in via `advanced.securitySystem: true` — arming/disarming,
  entry/exit delays, per-zone `triggerableModes`, and siren actuation. Because
  ESPHome web-server switches don't accept the panel's momentary-pulse params,
  the entry/exit beeper countdown is pulsed plugin-side (best with a `button`
  beeper such as `button-beep-beep`). Live arm/trigger testing will sound the
  siren — verify deliberately.

## Layout

- `src/` — TypeScript source. Compiles to `dist/` (the package `main`).
- `.dev-homebridge/` — a private Homebridge storage dir used only for dev.
  - `config.json` — tracked; a minimal bridge + the `konnected` platform.
  - `persist/`, `accessories/`, `backups/`, `*.log` — gitignored runtime state.

## How the plugin loads from local files

Homebridge is run with `-P .`, which points its plugin search at this repo's
own directory instead of a globally installed copy. Combined with `-U
./.dev-homebridge`, the dev bridge runs against local storage and the local
build. No `npm link` or global install is needed.

## Commands

```bash
npm install        # once
npm run build      # compile src/ -> dist/
npm run dev        # build, then run the dev Homebridge once
npm run watch       # rebuild + restart Homebridge on any src change (nodemon)
```

The dev bridge pairs separately from production. Pairing PIN and setup code are
printed on startup (PIN `031-45-155`); its bridge username/port in
`.dev-homebridge/config.json` are deliberately different from the Mac mini
bridge so they can coexist on the same network.

## Notes

- The MacBook must be on the same LAN as the Konnected panels for SSDP
  discovery to find them.
- Homebridge 1.7.0 officially wants Node 18/20; this repo currently runs on
  Node 24 with a harmless engine warning. The Mac mini may run an older Node —
  match it there when deploying.

## Deploying to the Mac mini

Once a change is working locally, push to the fork and install on the Mac mini
either from the Git URL or by `npm run build` + copying, depending on how that
instance manages plugins.
