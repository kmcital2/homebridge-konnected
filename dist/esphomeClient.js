import { EventEmitter } from 'node:events';
import fetch from 'node-fetch';
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
export class EspHomeClient extends EventEmitter {
    host;
    log;
    label;
    baseUrl;
    controller = null;
    stopped = false;
    reconnectDelay = 1000; // ms, grows with backoff up to reconnectMax
    reconnectMax = 30000;
    /**
     * @param host   Panel host or IP, e.g. '10.0.0.122' (optionally with ':port').
     * @param log    Homebridge logger.
     * @param label  Human label for log lines (panel name).
     */
    constructor(host, log, label) {
        super();
        this.host = host;
        this.log = log;
        this.label = label;
        // allow host to already include a scheme or port
        const hostPort = /^https?:\/\//i.test(host) ? host : `http://${host}`;
        this.baseUrl = hostPort.replace(/\/+$/, '');
    }
    /** Open (and keep open) the SSE subscription. */
    start() {
        this.stopped = false;
        void this.connect();
    }
    /** Permanently close the SSE subscription. */
    stop() {
        this.stopped = true;
        this.controller?.abort();
        this.controller = null;
    }
    /** Turn a switch/light/etc. on. Returns true on HTTP 2xx. */
    turnOn(domain, objectId) {
        return this.command(domain, objectId, 'turn_on');
    }
    /** Turn a switch/light/etc. off. Returns true on HTTP 2xx. */
    turnOff(domain, objectId) {
        return this.command(domain, objectId, 'turn_off');
    }
    /** Press a button entity. Returns true on HTTP 2xx. */
    press(objectId) {
        return this.command('button', objectId, 'press');
    }
    /**
     * Send a control action to an entity.
     * @reference ESPHome web_server REST: POST /<domain>/<object_id>/<action>
     */
    async command(domain, objectId, action) {
        const url = `${this.baseUrl}/${domain}/${encodeURIComponent(objectId)}/${action}`;
        try {
            const res = await fetch(url, { method: 'POST' });
            if (!res.ok) {
                this.log.error(`[${this.label}] command ${action} ${domain}/${objectId} failed: HTTP ${res.status}`);
                return false;
            }
            return true;
        }
        catch (error) {
            this.log.error(`[${this.label}] command ${action} ${domain}/${objectId} error: ${error.message}`);
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
    listEntities(settleMs = 2500) {
        return new Promise((resolve) => {
            const entities = new Map();
            const controller = new AbortController();
            let settleTimer;
            const finish = () => {
                controller.abort();
                resolve(entities);
            };
            const url = `${this.baseUrl}/events`;
            fetch(url, { signal: controller.signal })
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
    async connect() {
        if (this.stopped) {
            return;
        }
        this.controller = new AbortController();
        const url = `${this.baseUrl}/events`;
        try {
            const res = await fetch(url, {
                signal: this.controller.signal,
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
        }
        catch (error) {
            if (this.stopped) {
                return;
            }
            this.scheduleReconnect(error.message);
        }
    }
    scheduleReconnect(reason) {
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
    async readStream(body, onState) {
        let buffer = '';
        // SSE frames are separated by a blank line, which may use CRLF or LF endings
        const separator = /\r?\n\r?\n/;
        for await (const chunk of body) {
            buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            let match;
            while ((match = separator.exec(buffer)) !== null) {
                const frame = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                this.handleFrame(frame, onState);
            }
        }
    }
    handleFrame(frame, onState) {
        let eventName = 'message';
        const dataLines = [];
        for (const rawLine of frame.split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
            }
            else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
            }
        }
        if (eventName !== 'state' || dataLines.length === 0) {
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(dataLines.join('\n'));
        }
        catch {
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
            value: parsed.value,
            state: typeof parsed.state === 'string' ? parsed.state : '',
        });
    }
}
