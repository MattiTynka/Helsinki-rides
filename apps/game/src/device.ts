/** Input capabilities are independent of viewport size and the selected graphics quality. */
export interface DeviceCapabilities {
  readonly maxTouchPoints: number;
  readonly primaryCoarse: boolean;
  readonly primaryFine: boolean;
  readonly primaryHover: boolean;
  readonly anyFine: boolean;
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
}

export function detectDeviceCapabilities(): DeviceCapabilities {
  const matches = (query: string): boolean => typeof matchMedia === 'function' && matchMedia(query).matches;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number };
  return {
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    primaryCoarse: matches('(pointer: coarse)'), primaryFine: matches('(pointer: fine)'),
    primaryHover: matches('(hover: hover)'), anyFine: matches('(any-pointer: fine)'),
    ...(nav?.deviceMemory !== undefined ? { deviceMemory: nav.deviceMemory } : {}),
    ...(nav?.hardwareConcurrency !== undefined ? { hardwareConcurrency: nav.hardwareConcurrency } : {}),
  };
}

/** A touchscreen laptop with a primary mouse remains a desktop; an attached tablet mouse does not raise quality. */
export function isTouchFirstDevice(device: DeviceCapabilities = detectDeviceCapabilities()): boolean {
  return device.primaryCoarse || (device.maxTouchPoints > 0 && !device.primaryFine && !device.primaryHover && !device.anyFine);
}

/** Deliberately conservative before loading: phones do not need memory/core APIs to select Low. */
export function prefersLowGraphics(device: DeviceCapabilities = detectDeviceCapabilities()): boolean {
  return isTouchFirstDevice(device)
    || (Number.isFinite(device.deviceMemory) && device.deviceMemory! > 0 && device.deviceMemory! <= 4)
    || (Number.isFinite(device.hardwareConcurrency) && device.hardwareConcurrency! > 0 && device.hardwareConcurrency! <= 4);
}
