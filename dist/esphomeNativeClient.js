import { EventEmitter } from 'node:events';
import esphomeNativeApi from '@2colors/esphome-native-api';
const { Client } = esphomeNativeApi;
/**
 * Convert an entity class name to its ESPHome domain.
 * 'BinarySensor' -> 'binary_sensor', 'Switch' -> 'switch', 'TextSensor' -> 'text_sensor'.
 */
function classNameToDomain(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
/**
 * ESPHome native API (port 6053) client for a single Konnected panel.
 *
 * Implements the same surface as the web-server client (IEspHomeClient) so the
 * platform is transport-agnostic. Uses the protobuf native API via
 * @2colors/esphome-native-api, which pushes state changes, auto-reconnects, and
 * exposes device_class metadata the web server's SSE stream does not.
 */
export class EspHomeNativeClient extends EventEmitter {
    log;
    label;
    options;
    host;
    port;
    // the native-api library ships no types; treat the client as untyped
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client = null;
    stopped = false;
    // `${domain}|${objectId}` -> native entity instance
    entities = new Map();
    constructor(host, log, label, options = {}) {
        super();
        this.log = log;
        this.label = label;
        this.options = options;
        // strip any scheme/port from the host; native API uses a dedicated port
        this.host = host.replace(/^https?:\/\//i, '').replace(/:\d+$/, '');
        this.port = options.port ?? 6053;
    }
    start() {
        this.stopped = false;
        this.client = new Client({
            host: this.host,
            port: this.port,
            reconnect: true,
            reconnectInterval: 15000,
            clientInfo: 'homebridge-konnected',
            password: this.options.password ?? '',
            encryptionKey: this.options.encryptionKey,
        });
        // one state listener is registered per entity on the shared connection; raise the cap
        const raiseMaxListeners = () => {
            try {
                this.client?.connection?.setMaxListeners?.(0);
            }
            catch {
                /* ignore */
            }
        };
        this.client.on('newEntity', (entity) => this.registerEntity(entity));
        this.client.on('connected', raiseMaxListeners);
        this.client.on('initialized', () => {
            raiseMaxListeners();
            this.log.info(`[${this.label}] connected to ESPHome native API at ${this.host}:${this.port}`);
            this.emit('connect');
        });
        this.client.on('disconnected', () => {
            if (!this.stopped) {
                this.emit('disconnect', 'native API disconnected');
            }
        });
        this.client.on('error', (error) => {
            this.log.error(`[${this.label}] native API error: ${error?.message ?? String(error)}`);
        });
        this.client.connect();
    }
    stop() {
        this.stopped = true;
        try {
            this.client?.disconnect();
        }
        catch {
            /* ignore */
        }
        this.client = null;
    }
    registerEntity(entity) {
        const e = entity;
        const domain = classNameToDomain(e.type);
        const objectId = e.config.objectId;
        if (!objectId) {
            return;
        }
        this.entities.set(`${domain}|${objectId}`, e);
        const emitState = (rawState) => {
            const value = rawState?.state;
            this.emit('state', {
                id: `${domain}-${objectId}`,
                domain,
                objectId,
                name: e.config.name ?? objectId,
                value: value,
                state: typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value),
                deviceClass: e.config.deviceClass ?? '',
            });
        };
        e.on('state', emitState);
        if (e.state) {
            emitState(e.state);
        }
    }
    turnOn(domain, objectId) {
        return Promise.resolve(this.setEntityState(domain, objectId, true));
    }
    turnOff(domain, objectId) {
        return Promise.resolve(this.setEntityState(domain, objectId, false));
    }
    press(objectId) {
        const entity = this.entities.get(`button|${objectId}`);
        if (!entity || typeof entity.push !== 'function') {
            this.log.error(`[${this.label}] cannot press button '${objectId}': entity not found`);
            return Promise.resolve(false);
        }
        entity.push();
        return Promise.resolve(true);
    }
    setEntityState(domain, objectId, state) {
        const entity = this.entities.get(`${domain}|${objectId}`);
        if (!entity) {
            this.log.error(`[${this.label}] cannot actuate ${domain}/${objectId}: entity not found`);
            return false;
        }
        if (typeof entity.setState === 'function') {
            entity.setState(state);
        }
        else if (typeof entity.command === 'function') {
            entity.command({ state });
        }
        else {
            this.log.error(`[${this.label}] entity ${domain}/${objectId} is not commandable`);
            return false;
        }
        return true;
    }
}
