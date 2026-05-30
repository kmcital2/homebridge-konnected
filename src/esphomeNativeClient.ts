import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import esphomeNativeApi from '@2colors/esphome-native-api';
import { EspHomeEntityState, IEspHomeClient } from './esphomeTransport.js';

const { Client } = esphomeNativeApi;

export interface NativeClientOptions {
  /** Native API port (default 6053). */
  port?: number;
  /** Noise encryption key (api.encryption.key in the ESPHome config), if enabled. */
  encryptionKey?: string;
  /** Legacy API password, if used instead of encryption. */
  password?: string;
}

/**
 * Convert an entity class name to its ESPHome domain.
 * 'BinarySensor' -> 'binary_sensor', 'Switch' -> 'switch', 'TextSensor' -> 'text_sensor'.
 */
function classNameToDomain(name: string): string {
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
export class EspHomeNativeClient extends EventEmitter implements IEspHomeClient {
  private readonly host: string;
  private readonly port: number;
  // the native-api library ships no types; treat the client as untyped
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private stopped = false;
  // `${domain}|${objectId}` -> native entity instance
  private entities: Map<string, { config: { name?: string; deviceClass?: string }; type: string; state?: { state?: unknown };
    setState?: (s: boolean) => void; command?: (d: { state: boolean }) => void; push?: () => void; on: (e: string, cb: (s: unknown) => void) => void }>
    = new Map();

  constructor(
    host: string,
    private readonly log: Logger,
    private readonly label: string,
    private readonly options: NativeClientOptions = {},
  ) {
    super();
    // strip any scheme/port from the host; native API uses a dedicated port
    this.host = host.replace(/^https?:\/\//i, '').replace(/:\d+$/, '');
    this.port = options.port ?? 6053;
  }

  start(): void {
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
      } catch {
        /* ignore */
      }
    };

    this.client.on('newEntity', (entity: never) => this.registerEntity(entity));
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
    this.client.on('error', (error: Error) => {
      this.log.error(`[${this.label}] native API error: ${error?.message ?? String(error)}`);
    });

    this.client.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.client?.disconnect();
    } catch {
      /* ignore */
    }
    this.client = null;
  }

  private registerEntity(entity: never): void {
    const e = entity as unknown as {
      type: string;
      config: { objectId: string; name?: string; deviceClass?: string };
      state?: { state?: unknown };
      on: (event: string, cb: (s: unknown) => void) => void;
      setState?: (s: boolean) => void;
      command?: (d: { state: boolean }) => void;
      push?: () => void;
    };
    const domain = classNameToDomain(e.type);
    const objectId = e.config.objectId;
    if (!objectId) {
      return;
    }
    this.entities.set(`${domain}|${objectId}`, e);

    const emitState = (rawState: unknown) => {
      const value = (rawState as { state?: unknown })?.state;
      this.emit('state', {
        id: `${domain}-${objectId}`,
        domain,
        objectId,
        name: e.config.name ?? objectId,
        value: value as boolean | number | string,
        state: typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value),
        deviceClass: e.config.deviceClass ?? '',
      } as EspHomeEntityState);
    };

    e.on('state', emitState);
    if (e.state) {
      emitState(e.state);
    }
  }

  turnOn(domain: string, objectId: string): Promise<boolean> {
    return Promise.resolve(this.setEntityState(domain, objectId, true));
  }

  turnOff(domain: string, objectId: string): Promise<boolean> {
    return Promise.resolve(this.setEntityState(domain, objectId, false));
  }

  press(objectId: string): Promise<boolean> {
    const entity = this.entities.get(`button|${objectId}`);
    if (!entity || typeof entity.push !== 'function') {
      this.log.error(`[${this.label}] cannot press button '${objectId}': entity not found`);
      return Promise.resolve(false);
    }
    entity.push();
    return Promise.resolve(true);
  }

  private setEntityState(domain: string, objectId: string, state: boolean): boolean {
    const entity = this.entities.get(`${domain}|${objectId}`);
    if (!entity) {
      this.log.error(`[${this.label}] cannot actuate ${domain}/${objectId}: entity not found`);
      return false;
    }
    if (typeof entity.setState === 'function') {
      entity.setState(state);
    } else if (typeof entity.command === 'function') {
      entity.command({ state });
    } else {
      this.log.error(`[${this.label}] entity ${domain}/${objectId} is not commandable`);
      return false;
    }
    return true;
  }
}
