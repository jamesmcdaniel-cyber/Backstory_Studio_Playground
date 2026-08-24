'use client'

/**
 * Single-series rate line, 0–100%.
 *
 * One series by design, so there is no legend — the section heading names it
 * (see the dataviz form heuristic: none of the adoption questions is about
 * identity BETWEEN series, so no categorical palette is needed, which is what
 * this two-ramp design system can actually support).
 *
 * A null value BREAKS the line rather than plotting as zero. "No runs at all"
 * and "every run was manual" are opposite findings and must never share a
 * shape on the chart.
 */

export interface RatePoint {
  label: string
  value: number | null
}

const W = 720
const H = 180
const PAD = { top: 12, right: 16, bottom: 24, left: 34 }

export function RateLine({ points, ariaLabel }: { points: RatePoint[]; ariaLabel: string }) {
  // An all-null window must NOT draw an empty grid: a blank plot reads as a
  // flat zero, which is the very confusion the null-breaks-the-line rule exists
  // to prevent.
  if (points.length === 0 || points.every((point) => point.value === null)) {
    return (
      <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
        No runs in this window — nothing to rate.
      </p>
    )
  }

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const x = (index: number) =>
    PAD.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW)
  const y = (value: number) => PAD.top + (1 - value) * plotH

  // Split into contiguous runs of non-null values so gaps stay gaps.
  const segments: Array<Array<{ index: number; value: number }>> = []
  let current: Array<{ index: number; value: number }> = []
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length) segments.push(current)
      current = []
    } else {
      current.push({ index, value: point.value })
    }
  })
  if (current.length) segments.push(current)

  const plotted = points
    .map((point, index) => ({ ...point, index }))
    .filter((point): point is RatePoint & { index: number; value: number } => point.value !== null)
  const last = plotted[plotted.length - 1]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={ariaLabel}
      className="h-auto w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Recessive grid: present enough to read a value against, never competing
          with the data. */}
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={tick}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(tick)}
            y2={y(tick)}
            className="stroke-graphite-200 dark:stroke-graphite-800"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 6}
            y={y(tick) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[9px] tabular-nums"
          >
            {Math.round(tick * 100)}
          </text>
        </g>
      ))}

      {segments.map((segment, i) => (
        <polyline
          key={i}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-horizon-600 dark:stroke-horizon-300"
          points={segment.map((p) => `${x(p.index)},${y(p.value)}`).join(' ')}
        />
      ))}

      {/* A lone surviving point would otherwise render as an invisible
          zero-length polyline. */}
      {segments
        .filter((segment) => segment.length === 1)
        .map((segment, i) => (
          <circle
            key={`solo-${i}`}
            cx={x(segment[0].index)}
            cy={y(segment[0].value)}
            r={4}
            className="fill-horizon-600 dark:fill-horizon-300"
          />
        ))}

      {/* Selective direct label: the latest value only, never a number on every
          point. */}
      {last && (
        <>
          <circle
            cx={x(last.index)}
            cy={y(last.value)}
            r={4}
            className="fill-horizon-600 dark:fill-horizon-300"
          />
          {/* Clamped into the plot on both axes, and flipped BELOW the point
              when the value sits near the top — at 100% an above-the-point
              label lands outside the frame and gets clipped. */}
          <text
            x={Math.max(PAD.left + 12, Math.min(x(last.index), W - PAD.right - 12))}
            y={last.value > 0.88 ? y(last.value) + 16 : y(last.value) - 9}
            textAnchor="middle"
            /* Surface halo so the label stays legible where it crosses the
               line — the text equivalent of the surface ring on overlapping
               marks. paint-order puts the stroke behind the glyphs. */
            stroke="currentColor"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
            className="fill-foreground text-[11px] font-medium tabular-nums text-white dark:text-graphite-900"
          >
            {Math.round(last.value * 100)}%
          </text>
        </>
      )}

      {/* Hover layer: hit targets larger than the marks. Native <title> gives a
          real tooltip and is read by assistive tech, with no JS. */}
      {points.map((point, index) => (
        <circle key={point.label} cx={x(index)} cy={H / 2} r={10} fill="transparent">
          {/* One child, composed here: an SVG <title> may only hold a single
              text node. Interpolating several expressions makes it an array,
              which browsers render as literal markup and which knocks the tree
              out of hydration. */}
          <title>
            {`${point.label}: ${point.value === null ? 'no runs' : `${Math.round(point.value * 100)}%`}`}
          </title>
        </circle>
      ))}

      <text
        x={PAD.left}
        y={H - 6}
        className="fill-muted-foreground text-[9px] tabular-nums"
      >
        {points[0].label}
      </text>
      <text
        x={W - PAD.right}
        y={H - 6}
        textAnchor="end"
        className="fill-muted-foreground text-[9px] tabular-nums"
      >
        {points[points.length - 1].label}
      </text>
    </svg>
  )
}
