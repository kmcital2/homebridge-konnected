import { PLATFORM_NAME } from './settings.js';
import { KonnectedHomebridgePlatform } from './platform.js';
export default (api) => {
    api.registerPlatform(PLATFORM_NAME, KonnectedHomebridgePlatform);
};
