'use client'

import * as React from 'react'
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type HTMLMotionProps,
} from 'motion/react'

import { cn } from '@/lib/utils'
import { SPRING, fadeInUp, staggerContainer, tiltFromPointer } from '@/lib/motion'

/**
 * The platform's reusable depth + motion pieces. All are cursor-reactive or
 * scroll-reactive and all short-circuit under reduced motion, degrading to
 * plain (still good-looking) static elements. Built on `motion` v12 + the
 * shared vocabulary in `@/lib/motion`, styled only with existing Horizon/
 * Graphite tokens — no new palette.
 */

/* ------------------------------------------------------------------ Reveal */

/**
 * Scroll-reveal: fades + rises into place the first time it enters the
 * viewport, with spring physics. Drop it around any block. `delay` staggers
 * sibling reveals when you don't want a full StaggerReveal container.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 12,
  ...props
}: {
  children: React.ReactNode
  className?: string
  delay?: number
  y?: number
} & HTMLMotionProps<'div'>) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ ...SPRING.soft, delay }}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/**
 * True once the surrounding StaggerReveal has fired its one-shot reveal.
 * Items that mount later (pagination, filtering) would otherwise inherit the
 * container's `hidden` variant forever — the reveal never re-fires — and
 * render invisible at opacity 0.
 */
const StaggerRevealedContext = React.createContext(false)

/** Container that reveals its direct children in sequence on scroll-in. */
export function StaggerReveal({
  children,
  className,
  stagger = 0.06,
  ...props
}: {
  children: React.ReactNode
  className?: string
  stagger?: number
} & HTMLMotionProps<'div'>) {
  const reduced = useReducedMotion()
  const [revealed, setRevealed] = React.useState(false)
  if (reduced) return <div className={className}>{children}</div>
  return (
    <StaggerRevealedContext.Provider value={revealed}>
      <motion.div
        className={className}
        variants={staggerContainer(stagger)}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-60px' }}
        onViewportEnter={() => setRevealed(true)}
        {...props}
      >
        {children}
      </motion.div>
    </StaggerRevealedContext.Provider>
  )
}

/** A single item inside a <StaggerReveal>. */
export function StaggerItem({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotion()
  const revealed = React.useContext(StaggerRevealedContext)
  // Captured once at mount: items in the initial batch stay driven by the
  // container's staggered reveal; items mounted after it (a page flip, a
  // search) animate themselves in, since the container won't re-fire.
  const [selfDriven] = React.useState(revealed)
  if (reduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      variants={fadeInUp}
      {...(selfDriven ? { initial: 'hidden', animate: 'show' } : {})}
    >
      {children}
    </motion.div>
  )
}

/* ---------------------------------------------------------------- TiltCard */

/**
 * The signature interaction: a surface that tilts in 3D toward the cursor with
 * a moving specular highlight, so it reads as a physical, lit object instead of
 * a flat rectangle. Renders the card surface itself (border/bg/shadow/radius),
 * so use it in place of a <Card>. Lifts slightly and brightens its glare on
 * hover. No tilt under reduced motion — just a clean static card.
 */
export function TiltCard({
  children,
  className,
  maxDeg = 8,
  glare = true,
  interactive = true,
  ...props
}: {
  children: React.ReactNode
  className?: string
  maxDeg?: number
  glare?: boolean
  interactive?: boolean
} & Omit<HTMLMotionProps<'div'>, 'children'>) {
  const reduced = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)

  const rotateX = useSpring(0, SPRING.soft)
  const rotateY = useSpring(0, SPRING.soft)
  const glareX = useMotionValue(50)
  const glareY = useMotionValue(50)
  const glareOpacity = useSpring(0, SPRING.soft)
  const lift = useSpring(0, SPRING.soft)

  const glareBg = useTransform(
    [glareX, glareY],
    ([x, y]: number[]) =>
      `radial-gradient(circle at ${x}% ${y}%, rgba(255,255,255,0.55), rgba(255,255,255,0) 55%)`,
  )

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduced || !interactive) return
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const t = tiltFromPointer(event.clientX, event.clientY, rect, maxDeg)
    rotateX.set(t.rotateX)
    rotateY.set(t.rotateY)
    glareX.set(t.glareX)
    glareY.set(t.glareY)
  }
  const onPointerEnter = () => {
    if (reduced || !interactive) return
    glareOpacity.set(glare ? 1 : 0)
    lift.set(-6)
  }
  const onPointerLeave = () => {
    rotateX.set(0)
    rotateY.set(0)
    glareOpacity.set(0)
    lift.set(0)
  }

  return (
    <motion.div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ rotateX, rotateY, y: lift, transformPerspective: 900, transformStyle: 'preserve-3d' }}
      className={cn(
        'relative rounded-xl border bg-card text-card-foreground shadow-2 transition-shadow duration-base',
        interactive && !reduced && 'hover:shadow-4',
        className,
      )}
      {...props}
    >
      {children}
      {glare && !reduced && (
        <motion.span
          aria-hidden="true"
          style={{ background: glareBg, opacity: glareOpacity }}
          className="pointer-events-none absolute inset-0 rounded-xl mix-blend-soft-light"
        />
      )}
    </motion.div>
  )
}

/* ----------------------------------------------------------- MagneticButton */

/**
 * A wrapper that pulls its child toward the cursor while hovered — for hero
 * CTAs that should feel attracted to the pointer. Wrap a <Button>. Movement is
 * capped and springs back on leave; inert under reduced motion.
 */
export function Magnetic({
  children,
  className,
  strength = 0.35,
  ...props
}: {
  children: React.ReactNode
  className?: string
  strength?: number
} & Omit<HTMLMotionProps<'div'>, 'children'>) {
  const reduced = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)
  const x = useSpring(0, SPRING.bouncy)
  const y = useSpring(0, SPRING.bouncy)

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    x.set((event.clientX - (rect.left + rect.width / 2)) * strength)
    y.set((event.clientY - (rect.top + rect.height / 2)) * strength)
  }
  const reset = () => {
    x.set(0)
    y.set(0)
  }

  return (
    <motion.div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      style={reduced ? undefined : { x, y }}
      className={cn('inline-flex', className)}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/* -------------------------------------------------------------- Spotlight */

/**
 * A cursor-following radial glow layer for a container (e.g. a feature panel).
 * Absolutely positioned; give the parent `relative` and `overflow-hidden`. Uses
 * the Horizon accent at low opacity so it reads as ambient light, not a blob.
 */
export function Spotlight({ className, size = 380 }: { className?: string; size?: number }) {
  const reduced = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)
  const mx = useMotionValue(-size)
  const my = useMotionValue(-size)
  const background = useTransform(
    [mx, my],
    ([x, y]: number[]) =>
      `radial-gradient(${size}px circle at ${x}px ${y}px, rgba(68,124,147,0.16), transparent 70%)`,
  )
  // The layer is pointer-events-none (so it never blocks the content it sits
  // over), so it can't receive pointer events itself — listen on the parent.
  React.useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent || reduced) return
    const onMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect()
      mx.set(event.clientX - rect.left)
      my.set(event.clientY - rect.top)
    }
    parent.addEventListener('pointermove', onMove, { passive: true })
    return () => parent.removeEventListener('pointermove', onMove)
  }, [reduced, mx, my])
  if (reduced) return null
  return (
    <motion.div
      ref={ref}
      aria-hidden="true"
      style={{ background }}
      className={cn('pointer-events-none absolute inset-0', className)}
    />
  )
}

/* ---------------------------------------------------------------- Aurora */

/**
 * Ambient animated background: three slow-drifting Horizon-gradient orbs behind
 * a hero or empty state so the page has atmosphere instead of dead flat color.
 * Purely decorative and self-contained (give the parent `relative` +
 * `overflow-hidden`). Freezes to a static gradient under reduced motion.
 */
export function Aurora({ className, intensity = 1 }: { className?: string; intensity?: number }) {
  const reduced = useReducedMotion()
  const drift = (dx: number, dy: number, s: number): HTMLMotionProps<'div'>['animate'] =>
    reduced ? undefined : { x: [0, dx, 0], y: [0, dy, 0], scale: [1, s, 1] }
  const transition = (d: number): HTMLMotionProps<'div'>['transition'] => ({
    duration: d,
    repeat: Infinity,
    ease: 'easeInOut',
  })
  return (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <motion.div
        animate={drift(40, 30, 1.15)}
        transition={transition(16)}
        style={{ opacity: 0.5 * intensity }}
        className="absolute -left-24 -top-24 h-[28rem] w-[28rem] rounded-full bg-horizon-300 blur-3xl"
      />
      <motion.div
        animate={drift(-50, 40, 1.2)}
        transition={transition(20)}
        style={{ opacity: 0.4 * intensity }}
        className="absolute -right-32 top-10 h-[32rem] w-[32rem] rounded-full bg-horizon-500 blur-3xl"
      />
      <motion.div
        animate={drift(30, -40, 1.1)}
        transition={transition(24)}
        style={{ opacity: 0.35 * intensity }}
        className="absolute -bottom-24 left-1/3 h-[26rem] w-[26rem] rounded-full bg-horizon-200 blur-3xl"
      />
    </div>
  )
}
