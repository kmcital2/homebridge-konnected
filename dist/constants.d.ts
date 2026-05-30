/**
 * For Pro Panel
 */
export declare const ZONES: {
    1: string[];
    2: string[];
    3: string[];
    4: string[];
    5: string[];
    6: string[];
    7: string[];
    8: string[];
    9: string[];
    10: string[];
    11: string[];
    12: string[];
    alarm1: string[];
    out1: string[];
    alarm2_out2: string[];
};
/**
 * For V1/V2 Panels
 */
export declare const ZONES_TO_PINS: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
    6: number;
    out: number;
};
/**
 * For Zone Logic
 */
export declare const ZONE_TYPES: {
    sensors: string[];
    dht_sensors: string[];
    ds18b20_sensors: string[];
    actuators: string[];
};
export declare const TYPES_TO_ACCESSORIES: {
    securitysystem: string[];
    contact: string[];
    motion: string[];
    glass: string[];
    water: string[];
    smoke: string[];
    temperature: string[];
    humidtemp: string[];
    beeper: string[];
    siren: string[];
    strobe: string[];
    switch: string[];
};
export declare const ALARM_NAMES_TO_NUMBERS: {
    STAY_ARM: number;
    AWAY_ARM: number;
    NIGHT_ARM: number;
    DISARMED: number;
    ALARM_TRIGGERED: number;
};
export declare const ALARM_VALUES_TO_NAMES: (value: number) => void;
//# sourceMappingURL=constants.d.ts.map