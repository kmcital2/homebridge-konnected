import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import { EspHomePanel } from './interfaces.js';

/**
 * A single ESPHome entity state, normalized across transports (web server & native API).
 */
export interface EspHomeEntityState {
  /** Full web_server-style id, e.g. 'binary_sensor-great_room_windows'. */
  id: string;
  /** Entity domain, e.g. 'binary_sensor', 'switch', 'sensor', 'button'. */
  domain: string;
  /** Object id (id with the leading '<domain>-' removed), e.g. 'great_room_windows'. */
  objectId: string;
  /** Friendly name. */
  name: string;
  /** Raw value (booleans for binary_sensor & switch, numbers for sensors). */
  value: boolean | number | string;
  /** Human-readable state string, e.g. 'ON' / 'OFF'. */
  state: string;
  /** ESPHome device_class when known (native API exposes this; the web server does not). */
  deviceClass?: string;
}

/**
 * Common surface every ESPHome transport implements, so the platform is
 * transport-agnostic. Both implementations are EventEmitters that emit:
 *  - 'state'      (EspHomeEntityState)
 *  - 'connect'    ()
 *  - 'disconnect' (reason: string)
 */
export interface IEspHomeClient extends EventEmitter {
  /** Open (and keep open) the connection / subscription. */
  start(): void;
  /** Permanently close the connection / subscription. */
  stop(): void;
  /** Turn an entity on. Resolves true on success. */
  turnOn(domain: string, objectId: string): Promise<boolean>;
  /** Turn an entity off. Resolves true on success. */
  turnOff(domain: string, objectId: string): Promise<boolean>;
  /** Press a button entity. Resolves true on success. */
  press(objectId: string): Promise<boolean>;
}

export type TransportKind = 'webserver' | 'native';

/** Resolve the transport for a panel (default: web server). */
export function panelTransport(panel: EspHomePanel): TransportKind {
  return panel.transport === 'native' ? 'native' : 'webserver';
}

/**
 * Build the appropriate ESPHome client for a panel based on its configured transport.
 * Implementations are imported lazily so the native-API dependency is only loaded
 * when a panel actually uses it.
 */
export async function createEspHomeClient(panel: EspHomePanel, log: Logger, label: string): Promise<IEspHomeClient> {
  if (panelTransport(panel) === 'native') {
    const { EspHomeNativeClient } = await import('./esphomeNativeClient.js');
    return new EspHomeNativeClient(panel.host, log, label, {
      port: panel.port,
      encryptionKey: panel.encryptionKey,
      password: panel.password,
    });
  }
  const { EspHomeClient } = await import('./esphomeClient.js');
  return new EspHomeClient(panel.host, log, label);
}
