import { describe, expect, it } from 'vitest'
import { renderMacro, MACRO_VARIABLES } from './macros'

describe('renderMacro', () => {
  it('fills every variable it has', () => {
    const r = renderMacro('Hi {{customer_name}}, order {{order_number}} is {{delivery_status}}.', {
      customer_name: 'Kari', order_number: '#1042', delivery_status: 'in transit',
    })
    expect(r).toEqual({ text: 'Hi Kari, order #1042 is in transit.', missing: [] })
  })

  /**
   * Gorgias replaces a missing variable with a blank and sends "Hi , your
   * order  is on its way". We mark it and refuse to send instead.
   */
  it('marks a variable it cannot fill and names it as missing', () => {
    const r = renderMacro('Parcel {{tracking_number}} for {{customer_name}}', { customer_name: 'Kari' })
    expect(r.text).toBe('Parcel ⟪tracking_number⟫ for Kari')
    expect(r.missing).toEqual(['tracking_number'])
  })

  it('treats null and empty as missing — an empty name is not a name', () => {
    expect(renderMacro('{{customer_name}}', { customer_name: '' }).missing).toEqual(['customer_name'])
    expect(renderMacro('{{customer_name}}', { customer_name: null }).missing).toEqual(['customer_name'])
  })

  it('reports an unknown variable as missing rather than leaving braces in a customer email', () => {
    const r = renderMacro('{{shoe_size}}', {})
    expect(r.text).toBe('⟪shoe_size⟫')
    expect(r.missing).toEqual(['shoe_size'])
  })

  it('tolerates spaces inside the braces and lists each missing name once', () => {
    const r = renderMacro('{{ order_number }} and {{order_number}}', {})
    expect(r.missing).toEqual(['order_number'])
  })

  it('exports the variable list the settings page documents', () => {
    expect(MACRO_VARIABLES).toEqual([
      'customer_name', 'order_number', 'tracking_number', 'product_name', 'delivery_status', 'agent_name', 'brand_name',
    ])
  })
})
