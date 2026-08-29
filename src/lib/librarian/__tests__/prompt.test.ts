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

  it('fences the retrieved documentation, which the system prompt has already told the model outranks it', () => {
    // Two of the three documented sites are third-party-hosted, and these
    // passages arrive pre-blessed as authoritative — so an instruction smuggled
    // into one would be the highest-privilege injection channel in the product.
    const prompt = buildPrompt('how do I connect Slack?', [], [doc])
    assert.match(prompt, /<untrusted_data source="backstory documentation">/)
    const open = prompt.indexOf('<untrusted_data source="backstory documentation">')
    const close = prompt.indexOf('</untrusted_data>', open)
    const fenced = prompt.slice(open, close)
    assert.ok(fenced.includes('Open Integrations and choose Slack.'), 'the passage text must sit inside the envelope')
  })

  it('wraps the whole SOURCES block as one unit, so the shared numbering survives the fence', () => {
    // Per-passage envelopes would keep the arithmetic and lose the list: what
    // citedSources resolves against is one concatenation, counted by position.
    const prompt = buildPrompt('how do I connect Slack?', [page, flow], [doc, { ...doc, title: 'Slack scopes' }])
    assert.equal(prompt.match(/<untrusted_data source="backstory documentation">/g)?.length, 1)
    assert.match(prompt, /3\. \[Backstory Help Centre\] Connecting Slack/)
    assert.match(prompt, /4\. \[Backstory Help Centre\] Slack scopes/)
  })

  it('redacts a key pasted into a candidate title before the fence ever sees it', () => {
    // The fence stops this text being obeyed; only the redactor stops it being
    // read back out again on the next question about that flow.
    const leaky: LibrarianResult = {
      ...flow,
      title: 'Sync with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
      subtitle: 'Flow · uses AKIA1234567890ABCDEF',
    }
    const prompt = buildPrompt('why is this failing?', [leaky], [])
    assert.ok(!prompt.includes('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF'), 'the key must not reach the model')
    assert.ok(!prompt.includes('AKIA1234567890ABCDEF'), 'the access key id must not reach the model')
    assert.match(prompt, /1\. \[flow\] Sync with \[redacted\] — Flow · uses \[redacted\]/)
  })

  it('redacts a credential replayed from an earlier turn, so it is not re-sent on every follow-up', () => {
    const prompt = buildPrompt('did that work?', [], [], {
      history: [
        { role: 'user', content: 'the header is Bearer abcdefghijklmnopqrstuvwxyz012345' },
        { role: 'assistant', content: 'That token looks malformed.' },
      ],
    })
    assert.ok(!prompt.includes('abcdefghijklmnopqrstuvwxyz012345'), 'a replayed turn must not smuggle the token back in')
    assert.match(prompt, /User: the header is Bearer \[redacted\]/)
  })

  it('leaves the question itself alone, because it is the user\'s own deliberate input', () => {
    // A redactor here would break the honest version of the question, and
    // recordPiiEgress in the route already records that it crossed.
    const question = 'is sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF the right shape for a key?'
    const prompt = buildPrompt(question, [], [])
    assert.ok(prompt.endsWith(`User question: ${question}`))
  })

  it('leaves retrieved documentation unredacted, since fencing is the treatment for a public page', () => {
    // Mangling published docs would corrupt the one input here nobody in the
    // workspace authored — and there is no workspace secret to find in it.
    const example: KnowledgeDoc = { ...doc, text: 'Send the header as Bearer abcdefghijklmnopqrstuvwxyz012345.' }
    const prompt = buildPrompt('how does auth work?', [], [example])
    assert.ok(prompt.includes('Bearer abcdefghijklmnopqrstuvwxyz012345'), 'a documented example must survive intact')
  })
})
