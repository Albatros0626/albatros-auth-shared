import { describe, it, expect } from 'vitest'
import { VERSION } from './index'

describe('package smoke test', () => {
  it('exports VERSION constant', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
