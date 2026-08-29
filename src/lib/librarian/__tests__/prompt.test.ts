import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt } from '@/lib/librarian/prompt'
import { APP_SURFACES } from '@/lib/librarian/surfaces'
import type { LibrarianResult } from '@/lib/librarian/relevance'
import type { KnowledgeDoc } from '@/lib/help-center/retrieve'

const page: LibrarianResult = { type: 'page', id: 'integrations', title: 'Integrations', href: '/integrations', subtitle: 'connect an app account' }
const flow: LibrarianResult = { type: 'flow', id: 'f1', title: 'Pipeline review', href: '/flows/f1', subtitle: 'Flow · draft' }
const doc: KnowledgeDoc = { source: 'help', title: 'Connecting Slack', url: 'https://help.backstory.ai/slack', text: 'Open Integrations and choose Slack.' }

describe('buildPrompt', () => {
  it('numbers candidates and sources in ONE space, so a citation resolves to the right thing', () => {
    const prompt = buildPrompt('how do I connect Slack?', [page, flow], [doc])
    assert.match(prompt, /1\. \[page\] Integrations/)
    assert.match(prompt, /2\. \[flow\] Pipeline review/)
    // The sources continue the same numbering — this is what citedSources
    // splits back apart in the route.
    assert.match(prompt, /3\. \[Backstory Help Centre\] Connecting Slack/)
  })

  it('states the page the question came from', () => {
    const surface = APP_SURFACES.find((s) => s.id === 'credentials')!
    const prompt = buildPrompt('why did this stop working?', [], [], { surface })
    assert.match(prompt, /asking from the Credentials page/)
  })

  it('says nothing about a page when the path did not resolve', () => {
    const prompt = buildPrompt('what is this?', [], [], { surface: null })
    assert.ok(!prompt.includes('asking from'), 'an unrecognised path must add no page context at all')
  })

  it('replays earlier turns as DATA, so a follow-up works without re-opening the instruction channel', () => {
    const prompt = buildPrompt('what about Gmail?', [], [], {
      history: [
        { role: 'user', content: 'how do I connect Slack?' },
        { role: 'assistant', content: 'Open Integrations and pick Slack.' },
      ],
    })
    assert.match(prompt, /<untrusted_data source="earlier conversation">/)
    assert.match(prompt, /User: how do I connect Slack\?/)
    assert.match(prompt, /Assistant: Open Integrations and pick Slack\./)
    // The turn being answered is the instruction, and it stays outside the fence.
    const fenceEnd = prompt.lastIndexOf('</untrusted_data>')
    assert.ok(prompt.indexOf('User question: what about Gmail?') > fenceEnd)
  })

  it('adds no conversation block on the first question', () => {
    const prompt = buildPrompt('what is a flow?', [page], [])
    assert.ok(!prompt.includes('earlier conversation'))
    assert.match(prompt, /User question: what is a flow\?$/)
  })
})
