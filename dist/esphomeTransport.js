/** Resolve the transport for a panel (default: web server). */
export function panelTransport(panel) {
    return panel.transport === 'native' ? 'native' : 'webserver';
}
/**
 * Build the appropriate ESPHome client for a panel based on its configured transport.
 * Implementations are imported lazily so the native-API dependency is only loaded
 * when a panel actually uses it.
 */
export async function createEspHomeClient(panel, log, label) {
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
