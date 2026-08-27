import { triggerInputFieldsFromTrigger, type FlowTrigger } from '@/lib/flows/trigger'
import type { TriggerInputField } from '@/lib/flows/graph'

export type HostedFormDefinition = {
  title: string
  description: string
  submitLabel: string
  successMessage: string
  fields: TriggerInputField[]
}

const bounded = (value: unknown, fallback: string, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback

export function hostedFormDefinition(flowName: string, trigger: unknown): HostedFormDefinition | null {
  const value = trigger && typeof trigger === 'object' && !Array.isArray(trigger)
    ? trigger as FlowTrigger
    : null
  if (!value || value.type !== 'form') return null
  return {
    title: bounded(value.formTitle, flowName, 160),
    description: bounded(value.formDescription, '', 2_000),
    submitLabel: bounded(value.submitLabel, 'Submit', 80),
    successMessage: bounded(value.successMessage, 'Thanks — your response was received.', 500),
    fields: triggerInputFieldsFromTrigger(value).slice(0, 100),
  }
}

function parseFieldValue(field: TriggerInputField, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined
  if (field.type === 'string') return String(value).slice(0, 50_000)
  if (field.type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) throw new Error(`${field.name} must be a number.`)
    return parsed
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1' || value === 'on') return true
    if (value === 'false' || value === '0' || value === 'off') return false
    throw new Error(`${field.name} must be true or false.`)
  }
  if (field.type === 'object' || field.type === 'array') {
    let parsed = value
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value) }
      catch { throw new Error(`${field.name} must be valid JSON.`) }
    }
    if (field.type === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${field.name} must be ${field.type === 'array' ? 'a JSON array' : 'a JSON object'}.`)
    }
    return parsed
  }
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) }
  catch { return value.slice(0, 50_000) }
}

/** Allow only declared fields onto the run payload, with their declared types. */
export function normalizeHostedFormSubmission(definition: HostedFormDefinition, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Form submission must be an object.')
  const source = input as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const field of definition.fields) {
    const name = field.name.trim()
    if (!name) continue
    const value = parseFieldValue(field, source[name])
    if (value === undefined) {
      if (field.required && !field.default?.trim()) throw new Error(`${name} is required.`)
      if (field.default?.trim()) output[name] = parseFieldValue(field, field.default)
    } else {
      output[name] = value
    }
  }
  return output
}
