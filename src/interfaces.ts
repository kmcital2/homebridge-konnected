import { PlatformConfig } from 'homebridge';

/**
 * Common object structure for the Konnected platform Homebridge config.
 *
 * NOTE: This fork targets Konnected's ESPHome-based Alarm Panel Pro firmware.
 * Panels are addressed directly by host (no SSDP discovery / provisioning), and
 * each zone maps an ESPHome web_server entity id to a HomeKit accessory type.
 */
export interface ConfigPlatformInterface extends PlatformConfig {
  advanced?: {
    /** Enable the plugin-managed HomeKit Security System accessory + arming logic. */
    securitySystem?: boolean;
    /**
     * Default armed modes a sensor zone triggers the alarm in, applied to every zone
     * unless overridden per-zone. '0'=Home/Stay, '1'=Away, '2'=Night. Defaults to ['1'].
     * Set a zone's triggerableModes to [] to make it non-triggering.
     */
    defaultTriggerableModes?: string[];
    entryDelaySettings?: {
      delay?: number;
      pulseDuration?: number;
    };
    exitDelaySettings?: {
      delay?: number;
      audibleBeeperModes?: string[];
    };
  };
  panels?: EspHomePanel[];
}

/**
 * A Konnected (ESPHome) panel as defined in the plugin config.
 */
export interface EspHomePanel {
  /** Friendly name for the panel, used in accessory model strings and logs. */
  name?: string;
  /** Host or IP of the panel's ESPHome device, e.g. '10.0.0.122' or '10.0.0.122:80'. */
  host: string;
  /** Optional stable identifier for HAP UUIDs; defaults to the host if omitted. */
  id?: string;
  /** Which ESPHome transport to use. 'webserver' (REST + SSE, default) or 'native' (API on port 6053). */
  transport?: 'webserver' | 'native';
  /** Native API port (default 6053). Only used when transport is 'native'. */
  port?: number;
  /** Native API noise encryption key, if the firmware enables api.encryption. */
  encryptionKey?: string;
  /** Native API legacy password, if used instead of encryption. */
  password?: string;
  /** Set false to disable auto-discovery and use only the explicit `zones` below. Default true. */
  autoDiscover?: boolean;
  /**
   * Zone overrides, layered on top of auto-discovery and matched by `entityId`. Each entry
   * customizes a discovered zone (rename, retype, invert, alarm behavior) or adds an
   * explicit one; set `enabled: false` to drop a discovered zone. Fields left unset keep
   * their auto-discovered/default values.
   */
  zones?: EspHomeZone[];
  /** entityIds to skip during auto-discovery (for stray entities that aren't real zones). */
  exclude?: string[];
}

/**
 * A single zone (ESPHome entity) mapped to a HomeKit accessory.
 */
export interface EspHomeZone {
  /** Whether to expose this zone in HomeKit. */
  enabled?: boolean;
  /** ESPHome web_server entity id, e.g. 'binary_sensor-great_room_windows' or 'switch-alarm1'. */
  entityId: string;
  /**
   * HomeKit accessory type — a key of TYPES_TO_ACCESSORIES (contact, motion, smoke, water,
   * glass, siren, switch, ...). Optional: when omitted it's auto-detected from the entity's
   * device_class (native API) or domain.
   */
  type?: string;
  /** Display name in HomeKit; falls back to the ESPHome entity name. */
  name?: string;
  /** Invert the reported binary state (e.g. firmware reports ON for closed). */
  invert?: boolean;
  /** Security modes (as string codes) this sensor may trigger the alarm in (Security System feature). */
  triggerableModes?: string[];
  /** Sound the beeper momentarily when this sensor changes (Security System feature). */
  audibleBeep?: boolean;
}

/**
 * Common object structure for the zone runtime cache.
 */
export interface RuntimeCacheInterface {
  // the following are referenced from config
  UUID: string;
  displayName: string;
  enabled: boolean;
  type: string;
  model: string;
  serialNumber: string;
  /** ESPHome transport coordinates for this zone. */
  panelId: string;
  entityId: string;
  entityDomain: string;
  entityObjectId: string;
  invert?: boolean;
  audibleBeep?: boolean;
  trigger?: string;
  triggerableModes?: string[];
  // the following are actively updated
  state?: boolean | number;
  humi?: number;
  temp?: number;
}
