/// <reference types="node" resolution-mode="require"/>
import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import { IEspHomeClient } from './esphomeTransport.js';
export interface NativeClientOptions {
    /** Native API port (default 6053). */
    port?: number;
    /** Noise encryption key (api.encryption.key in the ESPHome config), if enabled. */
    encryptionKey?: string;
    /** Legacy API password, if used instead of encryption. */
    password?: string;
}
/**
 * ESPHome native API (port 6053) client for a single Konnected panel.
 *
 * Implements the same surface as the web-server client (IEspHomeClient) so the
 * platform is transport-agnostic. Uses the protobuf native API via
 * @2colors/esphome-native-api, which pushes state changes, auto-reconnects, and
 * exposes device_class metadata the web server's SSE stream does not.
 */
export declare class EspHomeNativeClient extends EventEmitter implements IEspHomeClient {
    private readonly log;
    private readonly label;
    private readonly options;
    private readonly host;
    private readonly port;
    private client;
    private stopped;
    private entities;
    constructor(host: string, log: Logger, label: string, options?: NativeClientOptions);
    start(): void;
    stop(): void;
    private registerEntity;
    turnOn(domain: string, objectId: string): Promise<boolean>;
    turnOff(domain: string, objectId: string): Promise<boolean>;
    press(objectId: string): Promise<boolean>;
    private setEntityState;
}
//# sourceMappingURL=esphomeNativeClient.d.ts.map