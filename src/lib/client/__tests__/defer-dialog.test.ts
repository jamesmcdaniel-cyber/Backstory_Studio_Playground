import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferDialogFromDropdown } from '../defer-dialog'

test('a dropdown-launched dialog opens on a later task', async () => {
  let opened = false
  deferDialogFromDropdown(() => { opened = true })
  assert.equal(opened, false, 'the dropdown must get a chance to release its modal layer first')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(opened, true)
})
