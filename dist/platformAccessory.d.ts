import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KonnectedHomebridgePlatform } from './platform.js';
/**
 * Platform Accessory
 * An instance of this class is created for each accessory registered
 */
export declare class KonnectedPlatformAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    private accessoryServiceType;
    private temperatureSensorService;
    private validSecuritySystemCurrentStates;
    constructor(platform: KonnectedHomebridgePlatform, accessory: PlatformAccessory);
    /**
     * Handle the "GET" & "SET" requests from HomeKit
     */
    getSecuritySystemCurrentState(): Promise<CharacteristicValue>;
    getSecuritySystemTargetState(): Promise<CharacteristicValue>;
    setSecuritySystemTargetState(value: CharacteristicValue): Promise<void>;
    getContactSensorState(): Promise<CharacteristicValue>;
    getMotionSensorState(): Promise<CharacteristicValue>;
    getLeakSensorState(): Promise<CharacteristicValue>;
    getSmokeSensorState(): Promise<CharacteristicValue>;
    getTemperatureSensorValue(): Promise<CharacteristicValue>;
    getHumiditySensorValue(): Promise<CharacteristicValue>;
    getSwitchState(): Promise<CharacteristicValue>;
    setSwitchState(value: CharacteristicValue): Promise<void>;
    getSecuritySystemState(characteristic: string): number;
    setSecuritySystemState(characteristic: string, value: number): number;
    getAccessoryState(type: string): number | boolean | undefined;
    setAccessoryState(type: string, value: boolean): boolean;
}
//# sourceMappingURL=platformAccessory.d.ts.map