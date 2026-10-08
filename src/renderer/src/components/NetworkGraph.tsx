import { formatSpeed } from '../format'
import { DOWNLOAD_SAMPLES } from '../store'

interface Props {
  samples: number[]
  peakBps: number
}

const WIDTH = 600
const HEIGHT = 140

/** Steam-style network usage graph: one bar per second over the last two minutes, newest
 *  on the right, with the peak marked. Bars are padded in from the right so a download
 *  that just started fills in from the right edge rather than stretching across. */
export function NetworkGraph({ samples, peakBps }: Props): React.JSX.Element {
  // Headroom above the peak so the tallest bar never touches the top edge, and a floor
  // so a near-idle download doesn't render as a wall of full-height noise.
  const scaleMax = Math.max(peakBps * 1.15, 256 * 1024)
  const barWidth = WIDTH / DOWNLOAD_SAMPLES
  const offset = DOWNLOAD_SAMPLES - samples.length
  const peakY = HEIGHT - (peakBps / scaleMax) * HEIGHT

  return (
    <div className="net-graph">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            className="net-graph-grid"
            x1={0}
            x2={WIDTH}
            y1={HEIGHT * f}
            y2={HEIGHT * f}
          />
        ))}
        {samples.map((bps, i) => {
          const h = Math.max(bps > 0 ? 1 : 0, (bps / scaleMax) * HEIGHT)
          return (
            <rect
              key={i}
              className={i === samples.length - 1 ? 'net-graph-bar current' : 'net-graph-bar'}
              x={(offset + i) * barWidth + 0.5}
              y={HEIGHT - h}
              width={Math.max(1, barWidth - 1)}
              height={h}
            />
          )
        })}
        {peakBps > 0 && <line className="net-graph-peak" x1={0} x2={WIDTH} y1={peakY} y2={peakY} />}
      </svg>
      <div className="net-graph-scale">
        <span>{formatSpeed(scaleMax)}</span>
        <span>2 min</span>
      </div>
    </div>
  )
}
