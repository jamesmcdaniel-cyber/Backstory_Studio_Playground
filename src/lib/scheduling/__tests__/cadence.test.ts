import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cadenceOf,
  cronToTime,
  daysFromCron,
  describeSchedule,
  dowCron,
  isPickerCron,
  scheduleForCadence,
  type Cadence,
} from '../cadence.js'

const FALLBACK = { time: '09:00', timezone: 'UTC', runAt: '2026-08-10', days: [1, 3] }

describe('cadenceOf ↔ scheduleForCadence round-trip', () => {
  it('every cadence classifies back to itself after serialization', () => {
    for (const cadence of ['every15min', 'every30min', 'hourly', 'daily', 'daysofweek', 'once'] as Cadence[]) {
      const schedule = scheduleForCadence(cadence, {}, FALLBACK)
      assert.equal(cadenceOf(schedule), cadence, `${cadence} did not round-trip`)
    }
  })

  it('maps legacy backend types onto the friendly cadences', () => {
    assert.equal(cadenceOf({ type: 'hourly' }), 'hourly')
    assert.equal(cadenceOf({ type: 'weekly', time: '09:00' }), 'daysofweek')
    assert.equal(cadenceOf({ type: 'cron', cron: '0 * * * *' }), 'hourly')
    assert.equal(cadenceOf({ type: 'cron', cron: '30 9 * * 1,3' }), 'daysofweek')
    assert.equal(cadenceOf({ type: 'cron', cron: '*/15 * * * *' }), 'every15min')
  })
})

describe('cron helpers (internal storage only — never shown to users)', () => {
  it('builds and parses day-of-week crons', () => {
    assert.equal(dowCron('14:30', [3, 1]), '30 14 * * 1,3')
    assert.deepEqual(daysFromCron('30 14 * * 1,3'), [1, 3])
    assert.deepEqual(daysFromCron('whatever'), [1, 2, 3, 4, 5])
    assert.equal(cronToTime('30 14 * * 1,3'), '14:30')
    assert.equal(cronToTime('*/15 * * * *'), '09:00')
  })

  it('recognizes picker-generated crons as safe for next-run scans', () => {
    for (const cron of ['*/15 * * * *', '*/30 * * * *', '0 * * * *', '30 9 * * 1,3']) {
      assert.ok(isPickerCron(cron), `${cron} should be a picker cron`)
    }
    assert.ok(!isPickerCron('0 9 29 2 *'), 'a rare legacy cron must not trigger a long scan')
  })
})

describe('describeSchedule', () => {
  it('describes every cadence in plain English with no cron syntax', () => {
    assert.equal(describeSchedule({ type: 'manual' }), 'manual')
    assert.equal(describeSchedule({ type: 'hourly' }), 'every hour, on the hour')
    assert.equal(describeSchedule({ type: 'daily', time: '09:00' }), 'every day at 09:00')
    assert.equal(describeSchedule({ type: 'once', runAt: '2026-08-10', time: '09:00' }), 'once on 2026-08-10 at 09:00')
    assert.equal(describeSchedule({ type: 'cron', cron: '*/30 * * * *' }), 'every 30 minutes')
    assert.equal(describeSchedule({ type: 'cron', cron: '30 9 * * 1,3' }), 'Mo, We at 09:30')
    const custom = describeSchedule({ type: 'cron', cron: '@reboot' })
    assert.equal(custom, 'a custom schedule')
    for (const schedule of [{ type: 'cron' as const, cron: '30 9 * * 1,3' }, { type: 'cron' as const, cron: '*/15 * * * *' }]) {
      assert.ok(!describeSchedule(schedule).includes('*'), 'cron syntax must never leak into the description')
    }
  })
})
