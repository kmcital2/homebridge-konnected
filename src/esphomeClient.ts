import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import fetch from 'node-fetch';
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
export class EspHomeClient extends EventEmitter implements IEspHomeClient {
  private readonly baseUrl: string;
  private controller: AbortController | null = null;
  private stopped = false;
  private reconnectDelay = 1000; // ms, grows with backoff up to reconnectMax
  private readonly reconnectMax = 30000;

  /**
   * @param host   Panel host or IP, e.g. '10.0.0.122' (optionally with ':port').
   * @param log    Homebridge logger.
   * @param label  Human label for log lines (panel name).
   */
  constructor(
    private readonly host: string,
    private readonly log: Logger,
    private readonly label: string,
  ) {
    super();
    // allow host to already include a scheme or port
    const hostPort = /^https?:\/\//i.test(host) ? host : `http://${host}`;
    this.baseUrl = hostPort.replace(/\/+$/, '');
  }

  /** Open (and keep open) the SSE subscription. */
  start(): void {
    this.stopped = false;
    void this.connect();
  }

  /** Permanently close the SSE subscription. */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
  }

  /** Turn a switch/light/etc. on. Returns true on HTTP 2xx. */
  turnOn(domain: string, objectId: string): Promise<boolean> {
    return this.command(domain, objectId, 'turn_on');
  }

  /** Turn a switch/light/etc. off. Returns true on HTTP 2xx. */
  turnOff(domain: string, objectId: string): Promise<boolean> {
    return this.command(domain, objectId, 'turn_off');
  }

  /** Press a button entity. Returns true on HTTP 2xx. */
  press(objectId: string): Promise<boolean> {
    return this.command('button', objectId, 'press');
  }

  /**
   * Send a control action to an entity.
   * @reference ESPHome web_server REST: POST /<domain>/<object_id>/<action>
   */
  async command(domain: string, objectId: string, action: string): Promise<boolean> {
    const url = `${this.baseUrl}/${domain}/${encodeURIComponent(objectId)}/${action}`;
    try {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        this.log.error(`[${this.label}] command ${action} ${domain}/${objectId} failed: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (error) {
      this.log.error(`[${this.label}] command ${action} ${domain}/${objectId} error: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Connect once to /events, collect the initial burst of state frames, and
   * resolve with a map of all discovered entities keyed by id. Useful for
   * auto-generating config. Does not keep the connection open.
   *
   * @param settleMs  How long to listen after the first frame before resolving.
   */
  listEntities(settleMs = 2500): Promise<Map<string, EspHomeEntityState>> {
    return new Promise((resolve) => {
      const entities = new Map<string, EspHomeEntityState>();
      const controller = new AbortController();
      let settleTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        controller.abort();
        resolve(entities);
      };
      const url = `${this.baseUrl}/events`;
      fetch(url, { signal: controller.signal as never })
        .then((res) => {
          if (!res.ok || !res.body) {
            finish();
            return;
          }
          this.readStream(res.body, (entity) => {
            entities.set(entity.id, entity);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(finish, settleMs);
          }).catch(() => finish());
        })
        .catch(() => finish());
      // hard cap in case the panel never sends a frame
      setTimeout(finish, settleMs + 8000);
    });
  }

  /** Establish and hold the SSE subscription, reconnecting on drop. */
  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.controller = new AbortController();
    const url = `${this.baseUrl}/events`;

    try {
      const res = await fetch(url, {
        signal: this.controller.signal as never,
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      this.reconnectDelay = 1000; // reset backoff on a good connection
      this.log.info(`[${this.label}] connected to ESPHome event stream at ${this.baseUrl}`);
      this.emit('connect');

      await this.readStream(res.body, (entity) => this.emit('state', entity));

      // stream ended cleanly (server closed) — fall through to reconnect
      this.scheduleReconnect('stream ended');
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.scheduleReconnect((error as Error).message);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) {
      return;
    }
    this.emit('disconnect', reason);
    const delay = this.reconnectDelay;
    this.log.warn(`[${this.label}] ESPHome stream lost (${reason}); reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMax);
    setTimeout(() => void this.connect(), delay);
  }

  /**
   * Read an SSE byte stream, parsing `event:`/`data:` frames and invoking
   * `onState` for every `event: state` frame whose data parses as an entity.
   */
  private async readStream(
    body: NodeJS.ReadableStream,
    onState: (entity: EspHomeEntityState) => void,
  ): Promise<void> {
    let buffer = '';
    // SSE frames are separated by a blank line, which may use CRLF or LF endings
    const separator = /\r?\n\r?\n/;
    for await (const chunk of body) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      let match: RegExpExecArray | null;
      while ((match = separator.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        this.handleFrame(frame, onState);
      }
    }
  }

  private handleFrame(frame: string, onState: (entity: EspHomeEntityState) => void): void {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (eventName !== 'state' || dataLines.length === 0) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const domain = typeof parsed.domain === 'string' ? parsed.domain : '';
    if (!id || !domain) {
      return;
    }
    const objectId = id.startsWith(domain + '-') ? id.slice(domain.length + 1) : id;
    onState({
      id,
      domain,
      objectId,
      name: typeof parsed.name === 'string' ? parsed.name : id,
      value: parsed.value as boolean | number | string,
      state: typeof parsed.state === 'string' ? parsed.state : '',
    });
  }
}
