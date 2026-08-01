export type DeviceOption = { deviceId: string; label: string }

/**
 * Splits enumerateDevices() output into pickable audio inputs and outputs.
 *
 * Two quirks of the browser API are handled here rather than in the UI: before
 * microphone permission is granted the list contains entries with an empty
 * deviceId (unusable), and labels are empty strings (unreadable). Both would
 * otherwise render as blank, unselectable rows.
 */
export function partitionDevices(devices: MediaDeviceInfo[]): {
  inputs: DeviceOption[]
  outputs: DeviceOption[]
} {
  const pick = (kind: MediaDeviceKind, fallback: string): DeviceOption[] =>
    devices
      .filter((device) => device.kind === kind && device.deviceId)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }))

  return {
    inputs: pick('audioinput', 'Microphone'),
    outputs: pick('audiooutput', 'Speaker'),
  }
}
