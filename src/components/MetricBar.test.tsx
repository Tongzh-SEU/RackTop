import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MetricBar } from './MetricBar'

describe('MetricBar current-user marker', () => {
  it('does not render a marker when the current user has no usage', () => {
    const markup = renderToStaticMarkup(<MetricBar label="MEM" value={25} detail="10 / 40 GB" currentUserValue={0} currentUserDetail="0.0 GB" />)

    expect(markup).not.toContain('metric-bar__own-marker')
    expect(markup).not.toContain('metric-bar__own-label')
  })

  it('renders a positioned marker and capacity label for current-user usage', () => {
    const markup = renderToStaticMarkup(<MetricBar label="MEM" value={45} detail="18 / 40 GB" currentUserValue={25} currentUserDetail="10.0 GB" />)

    expect(markup).toContain('metric-bar__own-marker')
    expect(markup).toContain('--own-position:25%')
    expect(markup).toContain('你 10.0 GB')
  })
})
