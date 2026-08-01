import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionDevices } from '../audio-devices'

const device = (kind: string, deviceId: string, label = '') =>
  ({ kind, deviceId, label, groupId: '' }) as MediaDeviceInfo

test('inputs and outputs are separated and video is ignored', () => {
  const { inputs, outputs } = partitionDevices([
    device('audioinput', 'mic-1', 'Built-in Mic'),
    device('audiooutput', 'spk-1', 'Built-in Speakers'),
    device('videoinput', 'cam-1', 'Webcam'),
  ])
  assert.deepEqual(inputs, [{ deviceId: 'mic-1', label: 'Built-in Mic' }])
  assert.deepEqual(outputs, [{ deviceId: 'spk-1', label: 'Built-in Speakers' }])
})

test('entries with no deviceId are dropped — they appear before permission', () => {
  const { inputs } = partitionDevices([device('audioinput', ''), device('audioinput', 'mic-2', 'USB')])
  assert.deepEqual(inputs, [{ deviceId: 'mic-2', label: 'USB' }])
})

test('unlabelled devices get a positional fallback, not a blank row', () => {
  const { inputs, outputs } = partitionDevices([
    device('audioinput', 'mic-1'),
    device('audioinput', 'mic-2'),
    device('audiooutput', 'spk-1'),
  ])
  assert.deepEqual(inputs.map((i) => i.label), ['Microphone 1', 'Microphone 2'])
  assert.deepEqual(outputs.map((o) => o.label), ['Speaker 1'])
})

test('an empty list yields empty lists, not undefined', () => {
  assert.deepEqual(partitionDevices([]), { inputs: [], outputs: [] })
})
