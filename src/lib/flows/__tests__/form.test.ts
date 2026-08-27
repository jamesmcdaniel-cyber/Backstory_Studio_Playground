import test from 'node:test'
import assert from 'node:assert/strict'
import { hostedFormDefinition, normalizeHostedFormSubmission } from '@/lib/flows/form'

test('hosted form definitions are available only for form triggers and use safe defaults', () => {
  assert.equal(hostedFormDefinition('Demo', { type: 'webhook' }), null)
  assert.deepEqual(hostedFormDefinition('Demo', { type: 'form', inputFields: [{ name: 'email', type: 'string', required: true }] }), {
    title: 'Demo',
    description: '',
    submitLabel: 'Submit',
    successMessage: 'Thanks — your response was received.',
    fields: [{ name: 'email', type: 'string', required: true, description: undefined, default: undefined }],
  })
})

test('form submissions allow only declared fields and coerce declared types', () => {
  const definition = hostedFormDefinition('Demo', {
    type: 'form',
    inputFields: [
      { name: 'name', type: 'string', required: true },
      { name: 'score', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'tags', type: 'array' },
    ],
  })!
  assert.deepEqual(normalizeHostedFormSubmission(definition, {
    name: 'Acme', score: '12', active: 'true', tags: '["priority"]', ignored: 'nope',
  }), { name: 'Acme', score: 12, active: true, tags: ['priority'] })
  assert.throws(() => normalizeHostedFormSubmission(definition, { score: 'nope' }), /name is required|score must be a number/)
})
