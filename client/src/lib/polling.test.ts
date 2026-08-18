import { describe, it, expect } from 'vitest'
import { visiblePolling } from './utils'

describe('visiblePolling', () => {
  it('returns the interval when there is no document', () => {
    expect(visiblePolling(5000)()).toBe(5000)
  })

  it('returns false when the document is hidden', () => {
    Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true })
    expect(visiblePolling(5000)()).toBe(false)
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('returns the interval when the document is visible', () => {
    Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true })
    expect(visiblePolling(5000)()).toBe(5000)
    Reflect.deleteProperty(globalThis, 'document')
  })
})