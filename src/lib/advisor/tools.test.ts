import { describe, expect, it } from 'vitest'
import { parseWindow, TOOL_DEFINITIONS, runTool } from './tools'

describe('TOOL_DEFINITIONS', () => {
  it('offers exactly the five read-only tools, and nothing that writes', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'get_delivery',
      'get_marketing',
      'get_metrics',
      'get_orders',
      'get_products',
    ])
  })

  it('describes every parameter, so the model does not have to guess', () => {
    for (const tool of TOOL_DEFINITIONS) {
      for (const key of Object.keys(tool.input_schema.properties)) {
        expect(tool.input_schema.properties[key].description).toBeTruthy()
      }
    }
  })
})

describe('parseWindow', () => {
  it('reads an explicit range', () => {
    const { from, to } = parseWindow({ from: '2026-08-01', to: '2026-08-07' })
    expect(from.toISOString().slice(0, 10)).toBe('2026-08-01')
    expect(to.toISOString().slice(0, 10)).toBe('2026-08-07')
  })

  it('rejects a range that runs backwards rather than returning nonsense', () => {
    expect(() => parseWindow({ from: '2026-08-07', to: '2026-08-01' })).toThrow(RangeError)
  })

  it('rejects a date it cannot read', () => {
    expect(() => parseWindow({ from: 'last tuesday', to: '2026-08-07' })).toThrow(RangeError)
  })

  it('rejects a window longer than a year, so one question cannot scan everything', () => {
    expect(() => parseWindow({ from: '2020-01-01', to: '2026-08-07' })).toThrow(RangeError)
  })
})

describe('runTool', () => {
  it('refuses a tool name it does not know', async () => {
    await expect(runTool('drop_table', {})).rejects.toThrow(/Unknown tool/)
  })
})
