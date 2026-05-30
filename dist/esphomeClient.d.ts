/// <reference types="node" resolution-mode="require"/>
import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import { EspHomeEntityState, IEspHomeClient } from './esphomeTransport.js';
/**
 * ESPHome web-server (REST + SSE) client for a single Konnected panel.
 *
 * Konnected's current Alarm Panel Pro firmware is ESPHome-based and exposes:
 *  - GET  /events                         Server-Sent Events stream of all entity states
 *  - GET  /<domain>/<object_id>           current state of one entity
 *  - POST /<domain>/<object_id>/<action>  control (turn_on | turn_off | press)
 *
 * This client maintains a resilient SSE subscription (auto-reconnect with backoff)
 * and re-emits each `event: state` frame as a 'state' event. It replaces the
 * Konnected classic SSDP discovery + /settings provisioning + inbound listener model.
 *
 * Events:
 *  - 'state'      (EspHomeEntityState)  an entity reported a value
 *  - 'connect'    ()                    SSE stream opened
 *  - 'disconnect' (reason: string)      SSE stream closed/errored (will reconnect)
 */
export declare class EspHomeClient extends EventEmitter implements IEspHomeClient {
    private readonly host;
    private readonly log;
    private readonly label;
    private readonly baseUrl;
    private controller;
    private stopped;
    private reconnectDelay;
    private readonly reconnectMax;
    /**
     * @param host   Panel host or IP, e.g. '10.0.0.122' (optionally with ':port').
     * @param log    Homebridge logger.
     * @param label  Human label for log lines (panel name).
     */
    constructor(host: string, log: Logger, label: string);
    /** Open (and keep open) the SSE subscription. */
    start(): void;
    /** Permanently close the SSE subscription. */
    stop(): void;
    /** Turn a switch/light/etc. on. Returns true on HTTP 2xx. */
    turnOn(domain: string, objectId: string): Promise<boolean>;
    /** Turn a switch/light/etc. off. Returns true on HTTP 2xx. */
    turnOff(domain: string, objectId: string): Promise<boolean>;
    /** Press a button entity. Returns true on HTTP 2xx. */
    press(objectId: string): Promise<boolean>;
    /**
     * Send a control action to an entity.
     * @reference ESPHome web_server REST: POST /<domain>/<object_id>/<action>
     */
    command(domain: string, objectId: string, action: string): Promise<boolean>;
    /**
     * Connect once to /events, collect the initial burst of state frames, and
     * resolve with a map of all discovered entities keyed by id. Useful for
     * auto-generating config. Does not keep the connection open.
     *
     * @param settleMs  How long to listen after the first frame before resolving.
     */
    listEntities(settleMs?: number): Promise<Map<string, EspHomeEntityState>>;
    /** Establish and hold the SSE subscription, reconnecting on drop. */
    private connect;
    private scheduleReconnect;
    /**
     * Read an SSE byte stream, parsing `event:`/`data:` frames and invoking
     * `onState` for every `event: state` frame whose data parses as an entity.
     */
    private readStream;
    private handleFrame;
}
//# sourceMappingURL=esphomeClient.d.ts.map