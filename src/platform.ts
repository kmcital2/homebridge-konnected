import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { TYPES_TO_ACCESSORIES, ZONE_TYPES } from './constants.js';
import { RuntimeCacheInterface, EspHomePanel, EspHomeZone } from './interfaces.js';
import { KonnectedPlatformAccessory } from './platformAccessory.js';
import { IEspHomeClient, EspHomeEntityState, createEspHomeClient, panelTransport } from './esphomeTransport.js';

type AccessoryType = keyof typeof TYPES_TO_ACCESSORIES;

/**
 * HomebridgePlatform Class
 *
 * Konnected Homebridge platform for Konnected's ESPHome-based Alarm Panel Pro.
 *
 * Transport (this fork): each panel speaks ESPHome — either the web server
 * (REST + SSE, default) or the native API (port 6053), chosen per panel and
 * abstracted behind IEspHomeClient. This replaces the classic Konnected SSDP
 * discovery, /settings provisioning, and inbound listener model.
 *
 * Startup (see startup()):
 * - parse the user config (panels[] of host/transport + zones[])
 * - restore cached accessories from disk
 * - connect each panel, capturing its initial state burst (for device_class
 *   auto-typing of zones that omit `type`)
 * - build/update HomeKit accessories and seed their current state
 * - (optionally) register the plugin-managed Security System
 */
export class KonnectedHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly Accessory: typeof PlatformAccessory;

  // restored Homebridge/HomeKit accessories from the cache
  public readonly accessories: PlatformAccessory[] = [];

  // references to initialized KonnectedPlatformAccessory instances, keyed by HAP UUID
  public readonly konnectedPlatformAccessories = {};

  // non-blocking runtime state for sensors/actuators (see original rationale)
  public accessoriesRuntimeCache: RuntimeCacheInterface[] = [];

  // security system UUID (one security system per homebridge instance)
  private securitySystemUUID: string;
  private securitySystemEnabled: boolean;

  // entry/exit delay defaults (Security System feature)
  private entryTriggerDelay: number;
  private entryTriggerDelayTimerHandle;
  private exitTriggerDelay: number;
  private exitTriggerDelayTimerHandle1;
  // plugin-side beeper countdown (ESPHome web_server switches lack momentary-pulse params,
  // so we pulse the beeper from here instead of delegating timing to the panel)
  private beeperCountdownInterval;
  private beeperCountdownStopHandle;

  // ESPHome clients (web-server or native), keyed by panel id
  private clients: Map<string, IEspHomeClient> = new Map();
  // fast lookup from `${panelId}|${entityId}` to the zone's HAP UUID
  private entityToZoneUUID: Map<string, string> = new Map();
  // entities seen on the stream that aren't in the config (logged once each)
  private loggedUnconfigured: Set<string> = new Set();
  // set during shutdown so async-created clients don't linger
  private stopping = false;

  constructor(public readonly log: Logger, public readonly config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.Accessory = this.api.platformAccessory;

    this.securitySystemUUID = this.api.hap.uuid.generate(String(this.config.platform));
    this.securitySystemEnabled = this.config.advanced?.securitySystem === true;

    this.entryTriggerDelay =
      this.config.advanced?.entryDelaySettings?.delay !== null &&
      typeof this.config.advanced?.entryDelaySettings?.delay !== 'undefined'
        ? Math.round(this.config.advanced?.entryDelaySettings?.delay) * 1000
        : 30000; // zero = instant trigger

    this.exitTriggerDelay =
      this.config.advanced?.exitDelaySettings?.delay !== null &&
      typeof this.config.advanced?.exitDelaySettings?.delay !== 'undefined'
        ? Math.round(this.config.advanced?.exitDelaySettings?.delay) * 1000
        : 30000; // zero = instant arming

    this.log.debug('Finished initializing platform');

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback. Accessories retrieved from cache...');
      void this.startup();
    });

    const cleanup = () => {
      this.stopping = true;
      this.clients.forEach((client) => client.stop());
    };
    process.on('SIGINT', cleanup).on('SIGTERM', cleanup);
  }

  /**
   * Homebridge's startup restoration of cached accessories from disk.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName} (${accessory.context.device.serialNumber})`);
    this.accessories.push(accessory);
  }

  /**
   * Stable identifier for a configured panel (used in HAP UUIDs and serials).
   */
  private panelIdFor(panel: EspHomePanel): string {
    return (panel.id && panel.id.trim() !== '' ? panel.id : panel.host).replace(/[^A-Za-z0-9]/g, '');
  }

  /**
   * Split an ESPHome web_server entity id into its domain and object_id.
   * e.g. 'binary_sensor-great_room_windows' -> { domain: 'binary_sensor', objectId: 'great_room_windows' }
   */
  private splitEntityId(entityId: string): { domain: string; objectId: string } {
    const dash = entityId.indexOf('-');
    if (dash === -1) {
      return { domain: '', objectId: entityId };
    }
    return { domain: entityId.slice(0, dash), objectId: entityId.slice(dash + 1) };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Infer a HomeKit accessory type for a zone whose config omits `type`, using the
   * ESPHome entity domain and (when available, i.e. the native API) its device_class.
   * Returns null when no sensible mapping exists (the zone is then skipped with a warning).
   */
  private inferType(domain: string, deviceClass?: string): string | null {
    const dc = (deviceClass || '').toLowerCase();
    if (domain === 'binary_sensor') {
      if (['motion', 'occupancy', 'presence'].includes(dc)) {
        return 'motion';
      }
      if (dc === 'smoke') {
        return 'smoke';
      }
      if (dc === 'moisture') {
        return 'water';
      }
      // window / door / garage_door / opening / tamper / vibration / (none) -> contact
      return 'contact';
    }
    if (domain === 'switch') {
      return 'switch';
    }
    if (domain === 'sensor') {
      return dc === 'temperature' ? 'temperature' : null;
    }
    // button, text_sensor, light, etc. are not auto-exposed
    return null;
  }

  /**
   * Derive zones from a panel's entity snapshot when no explicit `zones` are configured.
   * Keeps normal-category entities that map to a HomeKit type (binary_sensor/switch/temp),
   * skipping diagnostic/config entities (uptime, wifi, restart, …) and anything excluded.
   * The returned zones carry no `type`/`name` so the normal build path infers them from
   * device_class and the firmware name.
   */
  private autoDiscoverZones(panelLabel: string, snapshot: Map<string, EspHomeEntityState>, exclude: string[]): EspHomeZone[] {
    const discovered: EspHomeZone[] = [];
    const skipped: string[] = [];

    snapshot.forEach((entity) => {
      if (exclude.includes(entity.id)) {
        skipped.push(`${entity.id} (excluded)`);
        return;
      }
      // entity_category: 1 = config, 2 = diagnostic — never real zones
      if (entity.entityCategory === 1 || entity.entityCategory === 2) {
        return;
      }
      // only entities that map to a HomeKit accessory type
      if (!this.inferType(entity.domain, entity.deviceClass)) {
        return;
      }
      discovered.push({ enabled: true, entityId: entity.id });
    });

    this.log.info(
      `[${panelLabel}] Auto-discovered ${discovered.length} zone(s) from the panel (no zones[] configured).` +
        (skipped.length ? ` Skipped: ${skipped.join(', ')}.` : '')
    );
    if (discovered.length === 0 && snapshot.size === 0) {
      this.log.warn(`[${panelLabel}] No entities seen yet — the panel may be unreachable. No zones created.`);
    }
    return discovered;
  }

  /**
   * Orchestrate startup: connect each panel (capturing its initial state burst for
   * type inference), build the accessories, then register the Security System.
   */
  private async startup() {
    await this.connectPanels();
    if (this.securitySystemEnabled) {
      this.registerSecuritySystem();
    }
  }

  /**
   * Build (and reconcile) HomeKit accessories for one panel's configured zones.
   * `snapshot` is the panel's initial entity-state burst, used to infer types for
   * zones that omit `type` (device_class via the native API) and to seed names.
   * Replaces the classic provisioning-driven configureZones().
   */
  buildPanelZones(panel: EspHomePanel, snapshot: Map<string, EspHomeEntityState>) {
    const panelId = this.panelIdFor(panel);
    const panelLabel = panel.name && panel.name !== '' ? panel.name : panel.host;

    // explicit zones if configured, otherwise auto-discover from the panel's entities
    let zones: EspHomeZone[] = Array.isArray(panel.zones) ? panel.zones : [];
    if (zones.length === 0) {
      zones = this.autoDiscoverZones(panelLabel, snapshot, Array.isArray(panel.exclude) ? panel.exclude : []);
    }

    const panelRuntimeZones: RuntimeCacheInterface[] = [];
    const retainedAccessories: PlatformAccessory[] = [];
    const seenUUIDs: string[] = [];

    zones.forEach((zone) => {
      if (zone.enabled === false) {
        return;
      }
      if (!zone.entityId) {
        this.log.warn(`[${panelLabel}] Skipping a zone with no "entityId".`);
        return;
      }

      const { domain, objectId } = this.splitEntityId(zone.entityId);
      const snap = snapshot.get(zone.entityId);

      // resolve the HomeKit type: explicit config wins, otherwise infer it
      let type = zone.type;
      if (!type) {
        const inferred = this.inferType(domain, snap?.deviceClass);
        if (!inferred) {
          this.log.warn(
            `[${panelLabel}] Zone '${zone.entityId}' has no 'type' and one couldn't be inferred ` +
              `(domain '${domain}'${snap?.deviceClass ? `, device_class '${snap.deviceClass}'` : ''}). ` +
              'Set a type explicitly.'
          );
          return;
        }
        type = inferred;
        this.log.info(
          `[${panelLabel}] Auto-typed '${zone.entityId}' as '${type}'` +
            (snap?.deviceClass ? ` (device_class: ${snap.deviceClass}).` : ` (from domain '${domain}').`)
        );
      }

      const accType = TYPES_TO_ACCESSORIES[type as AccessoryType];
      if (!accType) {
        this.log.warn(
          `[${panelLabel}] Zone '${zone.entityId}' has an unknown type '${type}'. ` +
            `Valid types: ${Object.keys(TYPES_TO_ACCESSORIES).join(', ')}.`
        );
        return;
      }

      const zoneUUID = this.api.hap.uuid.generate(panelId + '-' + zone.entityId);

      if (seenUUIDs.includes(zoneUUID)) {
        this.log.warn(`[${panelLabel}] Duplicate zone entityId '${zone.entityId}' in config; ignoring the duplicate.`);
        return;
      }
      seenUUIDs.push(zoneUUID);

      const displayName =
        zone.name && zone.name !== '' ? zone.name : snap?.name && snap.name !== '' ? snap.name : accType[1]!;

      const zoneObject: RuntimeCacheInterface = {
        UUID: zoneUUID,
        displayName,
        enabled: true, // zone.enabled === false already returned above
        type,
        model: (panelLabel ? panelLabel + ' ' : '') + accType[1]!,
        serialNumber: panelId + '-' + zone.entityId,
        panelId,
        entityId: zone.entityId,
        entityDomain: domain,
        entityObjectId: objectId,
      };
      if (zone.invert) {
        zoneObject.invert = zone.invert;
      }
      if (zone.audibleBeep) {
        zoneObject.audibleBeep = zone.audibleBeep;
      }
      if (zone.triggerableModes) {
        zoneObject.triggerableModes = zone.triggerableModes;
      }

      // carry forward previous state from Homebridge's cached accessory
      this.accessories.forEach((accessory) => {
        if (accessory.UUID === zoneUUID) {
          if (typeof accessory.context.device.state !== 'undefined') {
            zoneObject.state = accessory.context.device.state;
          }
          if (typeof accessory.context.device.humi !== 'undefined') {
            zoneObject.humi = accessory.context.device.humi;
          }
          if (typeof accessory.context.device.temp !== 'undefined') {
            zoneObject.temp = accessory.context.device.temp;
          }
        }
      });

      this.accessoriesRuntimeCache.push(zoneObject);
      this.entityToZoneUUID.set(panelId + '|' + zone.entityId, zoneUUID);
      panelRuntimeZones.push(zoneObject);

      const retained = this.accessories.find((accessory) => accessory.UUID === zoneUUID);
      if (typeof retained !== 'undefined') {
        retainedAccessories.push(retained);
      }
    });

    this.registerAccessories(panelId, panelRuntimeZones, retainedAccessories);
  }

  /**
   * Register the plugin-managed Security System accessory.
   * (Disabled by default in this fork; enable with advanced.securitySystem = true.)
   */
  registerSecuritySystem() {
    const securitySystemObject = {
      UUID: this.securitySystemUUID,
      displayName: 'Konnected Alarm',
      type: 'securitysystem',
      model: 'Konnected Security System',
      serialNumber: this.api.hap.uuid.toShortForm(this.securitySystemUUID),
      state: 0,
    };

    const existingSecuritySystem = this.accessories.find((accessory) => accessory.UUID === this.securitySystemUUID);

    if (existingSecuritySystem) {
      this.log.info(
        `Updating existing accessory: ${existingSecuritySystem.displayName} (${existingSecuritySystem.context.device.serialNumber})`
      );
      this.konnectedPlatformAccessories[this.securitySystemUUID] = new KonnectedPlatformAccessory(
        this,
        existingSecuritySystem
      );
      this.api.updatePlatformAccessories([existingSecuritySystem]);
    } else {
      this.log.info(`Adding new accessory: ${securitySystemObject.displayName} (${this.securitySystemUUID})`);
      const newSecuritySystemAccessory = new this.api.platformAccessory('Konnected Alarm', this.securitySystemUUID);
      newSecuritySystemAccessory.context.device = securitySystemObject;
      this.konnectedPlatformAccessories[this.securitySystemUUID] = new KonnectedPlatformAccessory(
        this,
        newSecuritySystemAccessory
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newSecuritySystemAccessory]);
    }
  }

  /**
   * Control the registration of panel zones as accessories in Homebridge (and HomeKit).
   *
   * @param panelId string  Stable id for the panel whose zones are being passed in.
   * @param zoneObjectsArray array  An array of constructed zoneObjects for this panel.
   * @param retainedAccessoriesArray array  Cached accessories to keep.
   */
  registerAccessories(panelId: string, zoneObjectsArray: RuntimeCacheInterface[], retainedAccessoriesArray: PlatformAccessory[]) {
    // remove any stale accessories belonging to this panel that are no longer configured
    const accessoriesToRemoveArray = this.accessories
      .filter((accessory) => accessory.context.device.panelId === panelId)
      .filter((accessory) => !retainedAccessoriesArray.includes(accessory));

    if (Array.isArray(accessoriesToRemoveArray) && accessoriesToRemoveArray.length > 0) {
      accessoriesToRemoveArray.forEach((accessory) => {
        this.log.info(`Removing accessory: ${accessory.displayName} (${accessory.context.device.serialNumber})`);
      });
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemoveArray);
    }

    const accessoriesToUpdateArray: PlatformAccessory[] = [];
    const accessoriesToAddArray: PlatformAccessory[] = [];

    zoneObjectsArray.forEach((panelZoneObject) => {
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === panelZoneObject.UUID);

      if (existingAccessory && existingAccessory.context.device.UUID === panelZoneObject.UUID) {
        this.log.debug(
          `Updating existing accessory: ${existingAccessory.context.device.displayName} (${existingAccessory.context.device.serialNumber})`
        );
        existingAccessory.displayName = panelZoneObject.displayName;
        existingAccessory.context.device = panelZoneObject;
        this.konnectedPlatformAccessories[panelZoneObject.UUID] = new KonnectedPlatformAccessory(this, existingAccessory);
        accessoriesToUpdateArray.push(existingAccessory);
      } else {
        this.log.info(`Adding new accessory: ${panelZoneObject.displayName} (${panelZoneObject.serialNumber})`);
        const newAccessory = new this.api.platformAccessory(panelZoneObject.displayName, panelZoneObject.UUID);
        newAccessory.context.device = panelZoneObject;
        this.konnectedPlatformAccessories[panelZoneObject.UUID] = new KonnectedPlatformAccessory(this, newAccessory);
        accessoriesToAddArray.push(newAccessory);
      }
    });

    if (accessoriesToUpdateArray.length > 0) {
      this.api.updatePlatformAccessories(accessoriesToUpdateArray);
    }
    if (accessoriesToAddArray.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToAddArray);
    }
  }

  /**
   * Open an ESPHome connection for every configured panel and build its accessories.
   */
  async connectPanels() {
    const panels: EspHomePanel[] = Array.isArray(this.config.panels) ? this.config.panels : [];
    const active = panels.filter((p) => p.host);

    if (active.length === 0) {
      this.log.warn('No panels configured. Add panels[] with a "host" and "zones" to your config.');
      return;
    }

    await Promise.all(
      active.map((panel) =>
        this.connectPanel(panel).catch((error: Error) => {
          const label = panel.name && panel.name !== '' ? panel.name : panel.host;
          this.log.error(`[${label}] failed to initialize: ${error.message}`);
        })
      )
    );
  }

  /**
   * Connect a single panel, capture its initial state burst (for type inference and
   * device_class), build its accessories, then route ongoing state changes.
   */
  private async connectPanel(panel: EspHomePanel) {
    const panelId = this.panelIdFor(panel);
    const panelLabel = panel.name && panel.name !== '' ? panel.name : panel.host;

    if (this.clients.has(panelId)) {
      return;
    }

    const client = await createEspHomeClient(panel, this.log, panelLabel);
    if (this.stopping) {
      client.stop();
      return;
    }
    this.clients.set(panelId, client);
    this.log.debug(`[${panelLabel}] using ESPHome '${panelTransport(panel)}' transport`);

    // capture the initial state burst (device_class on the native transport) for type
    // inference; this collector only fills the snapshot — it does not touch HomeKit
    const snapshot = new Map<string, EspHomeEntityState>();
    const collector = (entity: EspHomeEntityState) => snapshot.set(entity.id, entity);
    client.on('state', collector);
    client.on('disconnect', () => this.markPanelEntitiesNoResponse(panelId));
    client.start();
    await this.sleep(3000); // allow connect + the full entity burst
    client.off('state', collector);

    // build this panel's accessories using the snapshot, then route ongoing state
    this.buildPanelZones(panel, snapshot);
    client.on('state', (entity: EspHomeEntityState) => this.handleEntityState(panelId, panelLabel, entity));

    // seed the just-built accessories with the values we already captured
    snapshot.forEach((entity) => this.handleEntityState(panelId, panelLabel, entity, true));
  }

  /**
   * Reflect an ESPHome entity state change into the matching HomeKit accessory.
   */
  handleEntityState(panelId: string, panelLabel: string, entity: EspHomeEntityState, seed = false) {
    const zoneUUID = this.entityToZoneUUID.get(panelId + '|' + entity.id);
    if (!zoneUUID) {
      // diagnostics-only or simply unconfigured entity — log once to aid config
      const key = panelId + '|' + entity.id;
      if (!this.loggedUnconfigured.has(key) && entity.domain !== 'sensor' && entity.domain !== 'text_sensor') {
        this.loggedUnconfigured.add(key);
        this.log.debug(`[${panelLabel}] Unconfigured entity reported: ${entity.id} ('${entity.name}')`);
      }
      return;
    }

    const runtimeCacheAccessory = this.accessoriesRuntimeCache.find((rca) => rca.UUID === zoneUUID);
    if (!runtimeCacheAccessory || !this.konnectedPlatformAccessories[zoneUUID]) {
      return;
    }

    const serviceType = TYPES_TO_ACCESSORIES[runtimeCacheAccessory.type as AccessoryType][0]!;
    const service = this.konnectedPlatformAccessories[zoneUUID].service;

    // numeric environmental sensors
    if (serviceType === 'TemperatureSensor') {
      const temp = Number(entity.value);
      runtimeCacheAccessory.temp = temp;
      service.updateCharacteristic(this.Characteristic.CurrentTemperature, temp);
      return;
    }

    // binary sensors & switches
    let stateValue = entity.value === true || entity.value === 1 || entity.state === 'ON' ? 1 : 0;
    if (runtimeCacheAccessory.invert === true) {
      stateValue = stateValue === 1 ? 0 : 1;
    }
    runtimeCacheAccessory.state = stateValue;

    this.log.debug(
      `[${panelLabel}] ${entity.id} -> ${entity.state} ` +
        `(${runtimeCacheAccessory.displayName} '${runtimeCacheAccessory.type}' = ${stateValue})`
    );

    switch (serviceType) {
      case 'ContactSensor':
        service.updateCharacteristic(this.Characteristic.ContactSensorState, stateValue);
        break;
      case 'MotionSensor':
        service.updateCharacteristic(this.Characteristic.MotionDetected, stateValue === 1);
        break;
      case 'LeakSensor':
        service.updateCharacteristic(this.Characteristic.LeakDetected, stateValue);
        break;
      case 'SmokeSensor':
        service.updateCharacteristic(this.Characteristic.SmokeDetected, stateValue);
        break;
      case 'Switch':
        service.updateCharacteristic(this.Characteristic.On, stateValue === 1);
        break;
      default:
        break;
    }

    // Security System feature (only when enabled): let sensors trigger the alarm / audible beeps.
    // Skipped while seeding initial state so startup can't fire the alarm.
    if (!seed && this.securitySystemEnabled && ZONE_TYPES.sensors.includes(runtimeCacheAccessory.type)) {
      const defaultStateValue = runtimeCacheAccessory.invert === true ? 1 : 0;
      this.processSensorAccessoryActions(runtimeCacheAccessory, defaultStateValue, stateValue);
    }
  }

  /**
   * When a panel's stream drops, mark its zones so HomeKit shows "No Response"
   * rather than silently displaying stale state.
   */
  markPanelEntitiesNoResponse(panelId: string) {
    this.accessoriesRuntimeCache.forEach((rca) => {
      if (rca.panelId !== panelId || !this.konnectedPlatformAccessories[rca.UUID]) {
        return;
      }
      const serviceType = TYPES_TO_ACCESSORIES[rca.type as AccessoryType][0]!;
      const characteristicName = {
        ContactSensor: 'ContactSensorState',
        MotionSensor: 'MotionDetected',
        LeakSensor: 'LeakDetected',
        SmokeSensor: 'SmokeDetected',
        TemperatureSensor: 'CurrentTemperature',
        Switch: 'On',
      }[serviceType];
      if (!characteristicName) {
        return;
      }
      this.konnectedPlatformAccessories[rca.UUID].service.updateCharacteristic(
        this.Characteristic[characteristicName],
        new Error('panel disconnected') as never
      );
    });
  }

  /**
   * Determine if the passed in sensor accessory should trigger the alarm or beep.
   * (Security System feature.)
   */
  processSensorAccessoryActions(accessory: RuntimeCacheInterface, defaultStateValue: number, resultStateValue: number) {
    if (defaultStateValue === resultStateValue) {
      return;
    }
    this.log.debug(
      `[${accessory.displayName}] (${accessory.serialNumber}) as '${accessory.type}' changed from ${defaultStateValue} to ${resultStateValue}`
    );

    const securitySystemAccessory = this.accessories.find((a) => a.UUID === this.securitySystemUUID);

    if (
      accessory.triggerableModes?.includes(String(securitySystemAccessory?.context.device.state)) &&
      typeof this.entryTriggerDelayTimerHandle === 'undefined'
    ) {
      // accessory should trigger the security system; sound an entry-delay countdown then fire
      this.log.info(
        `[${accessory.displayName}] tripped while armed; alarm will trigger in ${Math.round(this.entryTriggerDelay / 1000)}s`
      );
      this.startBeeperCountdown(this.entryTriggerDelay);
      this.entryTriggerDelayTimerHandle = setTimeout(() => {
        this.controlSecuritySystem(4);
      }, this.entryTriggerDelay);
    } else if (['contact', 'motion'].includes(accessory.type) && accessory.audibleBeep) {
      // not arming-relevant — just a single courtesy beep on change
      this.accessoriesRuntimeCache.forEach((beeperAccessory) => {
        if (beeperAccessory.type === 'beeper') {
          this.actuateAccessory(beeperAccessory.UUID, true, null);
        }
      });
    }
  }

  /**
   * Actuate a switch/siren/beeper/button zone via the panel's ESPHome REST API.
   *
   * @param zoneUUID string  HAP UUID for the actuator zone accessory.
   * @param value boolean  Desired on/off state from HomeKit.
   * @param _inboundSwitchSettings object | null  (reserved for pulse/momentary settings — Security System feature)
   */
  actuateAccessory(zoneUUID: string, value: boolean, _inboundSwitchSettings: Record<string, unknown> | null) {
    const runtimeCacheAccessory = this.accessoriesRuntimeCache.find((rca) => rca.UUID === zoneUUID);
    if (!runtimeCacheAccessory) {
      return;
    }

    // reflect state in HomeKit immediately
    if (this.konnectedPlatformAccessories[zoneUUID]) {
      this.konnectedPlatformAccessories[zoneUUID].service.updateCharacteristic(this.Characteristic.On, value);
    }
    runtimeCacheAccessory.state = value ? 1 : 0;

    const client = this.clients.get(runtimeCacheAccessory.panelId);
    if (!client) {
      this.log.error(
        `Cannot actuate [${runtimeCacheAccessory.displayName}]: no ESPHome client for panel '${runtimeCacheAccessory.panelId}'.`
      );
      return;
    }

    const { entityDomain, entityObjectId } = runtimeCacheAccessory;
    this.log.debug(
      `Actuating [${runtimeCacheAccessory.displayName}] (${entityDomain}/${entityObjectId}) -> ${value ? 'on' : 'off'}`
    );

    if (entityDomain === 'button') {
      void client.press(entityObjectId);
    } else if (value) {
      void client.turnOn(entityDomain, entityObjectId);
    } else {
      void client.turnOff(entityDomain, entityObjectId);
    }
  }

  /**
   * Arm/Disarm/Trigger the security system accessory. (Security System feature.)
   *
   * @param value number  0: home, 1: away, 2: night, 3: disarmed, 4: triggered.
   */
  controlSecuritySystem(value: number) {
    clearTimeout(this.exitTriggerDelayTimerHandle1);
    delete this.exitTriggerDelayTimerHandle1;
    this.stopBeeperCountdown();

    const securityService = this.konnectedPlatformAccessories[this.securitySystemUUID]?.service;
    if (!securityService) {
      this.log.warn('controlSecuritySystem called but the Security System accessory is not registered.');
      return;
    }

    if (value < 3) {
      // arming to home (0), away (1) or night (2)
      securityService.updateCharacteristic(this.Characteristic.SecuritySystemTargetState, value);

      const audibleModes = this.config.advanced?.exitDelaySettings?.audibleBeeperModes;
      const audible =
        (typeof audibleModes !== 'undefined' && audibleModes.includes(String(value))) ||
        (typeof audibleModes === 'undefined' && value === 1);

      if (audible && this.exitTriggerDelay > 1000) {
        // sound an audible exit countdown, then arm
        this.startBeeperCountdown(this.exitTriggerDelay);
        this.exitTriggerDelayTimerHandle1 = setTimeout(() => {
          this.stopBeeperCountdown();
          securityService.updateCharacteristic(this.Characteristic.SecuritySystemCurrentState, value);
        }, this.exitTriggerDelay);
      } else {
        securityService.updateCharacteristic(this.Characteristic.SecuritySystemCurrentState, value);
      }
    } else {
      // disarmed (3) or triggered (4)
      securityService.updateCharacteristic(this.Characteristic.SecuritySystemCurrentState, value);
    }

    this.accessories.find((accessory) => {
      if (accessory.UUID === this.securitySystemUUID) {
        accessory.context.device.state = value;
      }
    });

    if (value === 3) {
      // disarmed — cancel any pending trigger and silence all actuators
      clearTimeout(this.entryTriggerDelayTimerHandle);
      delete this.entryTriggerDelayTimerHandle;
      this.accessoriesRuntimeCache.forEach((rca) => {
        if (['beeper', 'siren', 'strobe'].includes(rca.type)) {
          this.actuateAccessory(rca.UUID, false, null);
        }
      });
    }

    if (value === 4) {
      // triggered — silence the beeper, sound sirens/strobes
      this.accessoriesRuntimeCache.forEach((rca) => {
        if (rca.type === 'beeper') {
          this.actuateAccessory(rca.UUID, false, null);
        }
        if (['siren', 'strobe'].includes(rca.type)) {
          this.actuateAccessory(rca.UUID, true, null);
        }
      });
    }
  }

  /**
   * Sound an audible countdown on all beeper zones for `durationMs`, pulsing
   * roughly once per second. ESPHome beepers are typically `button` entities
   * (one beep per press) or simple switches; we drive the cadence here rather
   * than relying on the panel's (absent) momentary-pulse parameters.
   */
  startBeeperCountdown(durationMs: number) {
    this.stopBeeperCountdown();
    const beepers = this.accessoriesRuntimeCache.filter((rca) => rca.type === 'beeper');
    if (beepers.length === 0) {
      return;
    }
    const beep = () => beepers.forEach((b) => this.actuateAccessory(b.UUID, true, null));
    beep();
    this.beeperCountdownInterval = setInterval(beep, 1000);
    this.beeperCountdownStopHandle = setTimeout(() => this.stopBeeperCountdown(), durationMs);
  }

  /** Stop any in-progress beeper countdown and silence switch-style beepers. */
  stopBeeperCountdown() {
    if (this.beeperCountdownInterval) {
      clearInterval(this.beeperCountdownInterval);
      this.beeperCountdownInterval = undefined;
    }
    if (this.beeperCountdownStopHandle) {
      clearTimeout(this.beeperCountdownStopHandle);
      this.beeperCountdownStopHandle = undefined;
    }
    // switch-style beepers latch on; make sure they end up off
    this.accessoriesRuntimeCache.forEach((rca) => {
      if (rca.type === 'beeper' && rca.entityDomain !== 'button') {
        this.actuateAccessory(rca.UUID, false, null);
      }
    });
  }
}
