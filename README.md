<p align="center">
  <a href="https://konnected.io/?utm_campaign=homebridge" title="Konnected Plugin for Homebridge - Homebridge Verified"><img alt="Konnected Plugin for Homebridge - Homebridge Verified" src="https://raw.githubusercontent.com/mkormendy/homebridge-konnected/master/branding/Konnected_w_Homebridge.svg?sanitize=true" width="500px"></a>
</p>
<span align="center">

# Homebridge Konnected Plugin

[![GitHub Release](https://flat.badgen.net/github/release/mkormendy/homebridge-konnected/master?icon=github)](https://github.com/mkormendy/homebridge-konnected/releases) [![npm Release](https://flat.badgen.net/npm/v/homebridge-konnected?icon=npm)](https://www.npmjs.com/package/homebridge-konnected)

[![Lint & Build](https://flat.badgen.net/github/checks/mkormendy/homebridge-konnected?icon=github&label=lint%20%26%20build)](https://github.com/mkormendy/homebridge-konnected/actions) [![npm Download Total](https://flat.badgen.net/npm/dt/homebridge-konnected?icon=npm)](https://www.npmjs.com/package/homebridge-konnected)

[![Homebridge Verified](https://flat.badgen.net/badge/homebridge/verified/4f4f4f?icon=https://developers.homebridge.io/assets/images/homebridge-color-round.svg&labelColor=57277c)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins) [![HOOBS Certified](https://flat.badgen.net/badge/hoobs/certified/4f4f4f?icon=https://developers.homebridge.io/assets/images/homebridge-color-round.svg&labelColor=ffac10)](https://plugins.hoobs.org/plugin/homebridge-konnected) [![Apple HomeKit](https://flat.badgen.net/badge/apple/homekit/f89f1a?icon=apple)](https://www.apple.com/ios/home/) 

[![Discord Channel](https://flat.badgen.net/badge/discord/homebridge%23konnected/6670f5?icon=discord)](https://discord.gg/YsujtCysZZ) [![Discord Channel](https://flat.badgen.net/badge/reddit/r%2Fkonnected/FF4500?icon=https://www.redditinc.com/assets/images/site/logo01.svg)](https://www.reddit.com/r/konnected/) [![Discussions](https://flat.badgen.net/badge/github/discussions?icon=github&label=repo)](https://github.com/mkormendy/homebridge-konnected/discussions)

[![License: MIT](https://flat.badgen.net/badge/license/MIT/blue)](https://github.com/mkormendy/homebridge-konnected/blob/master/LICENSE)

</span>

## ⚡ ESPHome fork

> **This fork targets Konnected Alarm Panel Pro units running [ESPHome](https://esphome.io) firmware** (Konnected's current firmware), rather than the classic Konnected firmware the upstream plugin was built for. **If your panels run the classic Konnected firmware, use the [upstream plugin](https://github.com/mkormendy/homebridge-konnected) instead** — this fork does not support SSDP discovery / `/settings` provisioning.
>
> Each panel is addressed directly by host. Two ESPHome transports are supported, selectable per panel:
>
> - **Web Server (default)** — subscribes to the `GET /events` Server-Sent Events stream for live state and uses the REST API (`POST /<domain>/<object_id>/<action>`) to actuate. Zero setup.
> - **Native API (`transport: "native"`, port 6053)** — uses ESPHome's protobuf API. More efficient, exposes `device_class` metadata, supports an encryption key. Set `encryptionKey` (or `password`) if your firmware enables it. **Bonus:** omit a zone's `type` and it's auto-detected from the entity's `device_class` (e.g. `window`/`door` → contact, `motion` → motion, `smoke` → smoke, `moisture` → water).
>
> **Status:** zones expose as HomeKit sensors and switches. The plugin-managed HomeKit Security System is opt-in via `advanced.securitySystem` (off by default). See [`DEV.md`](DEV.md) for the local dev setup and architecture.

### Configuration (this fork)

**Zero-config zones:** if a panel has no `zones`, they're **auto-discovered** — every real sensor/switch is exposed, typed from `device_class` and named from the firmware, with diagnostic/utility entities (uptime, Wi-Fi, restart, …) skipped automatically. Auto-typing is most accurate on the **Native API** transport (the web server doesn't expose `device_class`, so binary sensors default to `contact` there). Use `exclude: ["entityId", …]` to drop stray entities, and only add a `zones` list to rename, retype, `invert`, set alarm behavior, or hand-pick.

```jsonc
// minimal: auto-discover everything on a panel
{ "platform": "konnected", "name": "Konnected",
  "panels": [ { "name": "Alarm Panel Pro", "host": "alarm-panel-pro.local", "transport": "native" } ] }
```

For explicit control, each panel is identified by `host` (+ an optional stable `id`), and each zone maps an ESPHome `entityId` to a HomeKit `type`:

```jsonc
{
  "platform": "konnected",
  "name": "Konnected",
  "advanced": { "securitySystem": false },
  "panels": [
    {
      "name": "Alarm Panel Pro",
      "host": "alarm-panel-pro.local",
      "id": "a1b2c3d4e5f6",
      "transport": "webserver",
      "zones": [
        { "entityId": "binary_sensor-front_hall_motion", "type": "motion",  "name": "Front Hall Motion" },
        { "entityId": "binary_sensor-living_room_windows", "type": "contact", "name": "Living Room Windows", "invert": false },
        { "entityId": "switch-alarm1", "type": "siren", "name": "Alarm Siren" }
      ]
    }
  ]
}
```

To list a panel's entity ids: `curl http://<panel-host>/events` — each `event: state` frame's `id` (e.g. `binary_sensor-front_hall_motion`, `switch-alarm1`) is what goes in `entityId`. Valid `type` values: `contact`, `motion`, `glass`, `water`, `smoke`, `temperature`, `humidtemp`, `siren`, `strobe`, `beeper`, `switch`.

## Supported Features

<div align="left">
  <img align="right" width="319" height="692" alt="Screen capture of Konnected accessories in HomeKit via the Konnected Homebridge plugin." src="https://user-images.githubusercontent.com/1437667/128083751-1eb31022-0c44-4954-9b0f-09c5c749d0f4.gif">
  <b>Native HomeKit Security System Control</b>
  <ul>
    <li>Arm/Disarm Security System</li>
    <li>Optional Home/Stay and Night Modes</li>
    <li>Configurable Sensor Security System Triggering</li>
    <li>Configurable Entry Delay Times</li>
    <li>Traditional Alarm System Integration</li>
    <li>Panic Button via Alarm Siren Switch</li>
    <li>Inverting Sensors</li>
    <li>Switch Trigger States (high vs low)</li>
  </ul>
  <b>Sensor States</b>
  <ul>
    <li>Contact</li>
    <li>Motion</li>
    <li>Glass Break</li>
    <li>Temperature</li>
    <li>Humidity</li>
    <li>Smoke</li>
    <li>Water Leak</li>
  </ul>
  <b>Switches/Actuators</b>
  <ul>
    <li>Beeper</li>
    <li>Siren</li>
    <li>Strobe Light</li>
    <li>Generic Switch</li>
  </ul>
</div>

## Upcoming Features

  * Bypass Switch for Sensor Zones
  * Virtual Zones for HomeKit Automation
  * Professional 24/7 smart home monitoring (powered by [Noonlight](https://noonlight.com/))

## Wiki

* **[Installation](https://github.com/mkormendy/homebridge-konnected/wiki/1.-Installation)**
* **[Configuration](https://github.com/mkormendy/homebridge-konnected/wiki/2.-Configuration)**
* **[Particulars](https://github.com/mkormendy/homebridge-konnected/wiki/3.-Particulars)**
* **[Troubleshooting](https://github.com/mkormendy/homebridge-konnected/wiki/4.-Troubleshooting)**

## Contributions & Thanks

Plugin development, maintainance, and forum/ticket support is performed by [Mike Kormendy](https://github.com/mkormendy) in his spare time. If you somehow benefit from using this open source plugin and want to support Mike for his work on it, consider sponsoring him on [Github](https://github.com/sponsors/mkormendy), donate with [PayPal](https://www.paypal.me/mikekormendy), or buy him a coffee with [Ko-fi](https://ko-fi.com/mikekormendy) – any contribution is greatly appreciated.

I'd like to thank the following people for their guidance and help with code reviews, testing, pull requests etc:
- [@bwp91](https://github.com/bwp91)
- [@oznu](https://github.com/oznu) @ Homebridge
- [@northernman54](https://github.com/NorthernMan54) @ Homebridge
- [@mkellsy](https://github.com/mkellsy) @ HOOBS