'use client'

import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'

export const RUNNING_WORDS = [
  'Working', 'Thinking', 'Reasoning', 'Analyzing', 'Pondering', 'Crunching',
  'Synthesizing', 'Digging in', 'Computing', 'Percolating', 'Noodling', 'Cooking',
]

export function TypewriterStatus({ seed = 0 }: { seed?: number }) {
  const reduced = useReducedMotion()
  const [wordIndex, setWordIndex] = useState(seed % RUNNING_WORDS.length)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'typing' | 'holding' | 'deleting'>('typing')

  useEffect(() => {
    if (reduced) return
    const word = RUNNING_WORDS[wordIndex]
    let timer: number
    if (phase === 'typing') {
      if (text.length < word.length) timer = window.setTimeout(() => setText(word.slice(0, text.length + 1)), 55)
      else timer = window.setTimeout(() => setPhase('holding'), 4000)
    } else if (phase === 'holding') {
      timer = window.setTimeout(() => setPhase('deleting'), 400)
    } else {
      if (text.length > 0) timer = window.setTimeout(() => setText(word.slice(0, text.length - 1)), 32)
      else {
        setWordIndex((i) => (i + 1) % RUNNING_WORDS.length)
        setPhase('typing')
      }
    }
    return () => window.clearTimeout(timer)
  }, [text, phase, wordIndex, reduced])

  return (
    <span>
      {reduced ? RUNNING_WORDS[wordIndex] : text}
      <span className="animate-pulse">…</span>
    </span>
  )
}
