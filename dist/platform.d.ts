import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { RuntimeCacheInterface, EspHomePanel } from './interfaces.js';
import { EspHomeEntityState } from './esphomeTransport.js';
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
export declare class KonnectedHomebridgePlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly Accessory: typeof PlatformAccessory;
    readonly accessories: PlatformAccessory[];
    readonly konnectedPlatformAccessories: {};
    accessoriesRuntimeCache: RuntimeCacheInterface[];
    private securitySystemUUID;
    private securitySystemEnabled;
    private entryTriggerDelay;
    private entryTriggerDelayTimerHandle;
    private exitTriggerDelay;
    private exitTriggerDelayTimerHandle1;
    private beeperCountdownInterval;
    private beeperCountdownStopHandle;
    private clients;
    private entityToZoneUUID;
    private loggedUnconfigured;
    private stopping;
    constructor(log: Logger, config: PlatformConfig, api: API);
    /**
     * Homebridge's startup restoration of cached accessories from disk.
     */
    configureAccessory(accessory: PlatformAccessory): void;
    /**
     * Stable identifier for a configured panel (used in HAP UUIDs and serials).
     */
    private panelIdFor;
    /**
     * Split an ESPHome web_server entity id into its domain and object_id.
     * e.g. 'binary_sensor-great_room_windows' -> { domain: 'binary_sensor', objectId: 'great_room_windows' }
     */
    private splitEntityId;
    private sleep;
    /**
     * Infer a HomeKit accessory type for a zone whose config omits `type`, using the
     * ESPHome entity domain and (when available, i.e. the native API) its device_class.
     * Returns null when no sensible mapping exists (the zone is then skipped with a warning).
     */
    private inferType;
    /**
     * Orchestrate startup: connect each panel (capturing its initial state burst for
     * type inference), build the accessories, then register the Security System.
     */
    private startup;
    /**
     * Build (and reconcile) HomeKit accessories for one panel's configured zones.
     * `snapshot` is the panel's initial entity-state burst, used to infer types for
     * zones that omit `type` (device_class via the native API) and to seed names.
     * Replaces the classic provisioning-driven configureZones().
     */
    buildPanelZones(panel: EspHomePanel, snapshot: Map<string, EspHomeEntityState>): void;
    /**
     * Register the plugin-managed Security System accessory.
     * (Disabled by default in this fork; enable with advanced.securitySystem = true.)
     */
    registerSecuritySystem(): void;
    /**
     * Control the registration of panel zones as accessories in Homebridge (and HomeKit).
     *
     * @param panelId string  Stable id for the panel whose zones are being passed in.
     * @param zoneObjectsArray array  An array of constructed zoneObjects for this panel.
     * @param retainedAccessoriesArray array  Cached accessories to keep.
     */
    registerAccessories(panelId: string, zoneObjectsArray: RuntimeCacheInterface[], retainedAccessoriesArray: PlatformAccessory[]): void;
    /**
     * Open an ESPHome connection for every configured panel and build its accessories.
     */
    connectPanels(): Promise<void>;
    /**
     * Connect a single panel, capture its initial state burst (for type inference and
     * device_class), build its accessories, then route ongoing state changes.
     */
    private connectPanel;
    /**
     * Reflect an ESPHome entity state change into the matching HomeKit accessory.
     */
    handleEntityState(panelId: string, panelLabel: string, entity: EspHomeEntityState, seed?: boolean): void;
    /**
     * When a panel's stream drops, mark its zones so HomeKit shows "No Response"
     * rather than silently displaying stale state.
     */
    markPanelEntitiesNoResponse(panelId: string): void;
    /**
     * Determine if the passed in sensor accessory should trigger the alarm or beep.
     * (Security System feature.)
     */
    processSensorAccessoryActions(accessory: RuntimeCacheInterface, defaultStateValue: number, resultStateValue: number): void;
    /**
     * Actuate a switch/siren/beeper/button zone via the panel's ESPHome REST API.
     *
     * @param zoneUUID string  HAP UUID for the actuator zone accessory.
     * @param value boolean  Desired on/off state from HomeKit.
     * @param _inboundSwitchSettings object | null  (reserved for pulse/momentary settings — Security System feature)
     */
    actuateAccessory(zoneUUID: string, value: boolean, _inboundSwitchSettings: Record<string, unknown> | null): void;
    /**
     * Arm/Disarm/Trigger the security system accessory. (Security System feature.)
     *
     * @param value number  0: home, 1: away, 2: night, 3: disarmed, 4: triggered.
     */
    controlSecuritySystem(value: number): void;
    /**
     * Sound an audible countdown on all beeper zones for `durationMs`, pulsing
     * roughly once per second. ESPHome beepers are typically `button` entities
     * (one beep per press) or simple switches; we drive the cadence here rather
     * than relying on the panel's (absent) momentary-pulse parameters.
     */
    startBeeperCountdown(durationMs: number): void;
    /** Stop any in-progress beeper countdown and silence switch-style beepers. */
    stopBeeperCountdown(): void;
}
//# sourceMappingURL=platform.d.ts.map