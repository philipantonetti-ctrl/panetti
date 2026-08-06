// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RowMenu } from './RowMenu'

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Actions for Maria' }))

function setup(overrides: Parameters<typeof RowMenu>[0]['actions'] = []) {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  render(
    <RowMenu
      ariaLabel="Actions for Maria"
      actions={
        overrides.length
          ? overrides
          : [
              { label: 'Edit', onSelect: onEdit },
              { label: 'Deactivate', onSelect: vi.fn() },
              { label: 'Delete', danger: true, onSelect: onDelete },
            ]
      }
    />,
  )
  return { onEdit, onDelete }
}

describe('RowMenu', () => {
  it('shows nothing until it is asked for', () => {
    setup()
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('runs the action and closes', () => {
    const { onEdit } = setup()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('stays open when the page scrolls, and follows the row instead', () => {
    // The bug this guards: the menu used to close on ANY scroll, and the
    // browser fires one the moment focus lands on the first item — so it shut
    // in the same frame it opened and the button read as dead. jsdom does not
    // scroll on focus, so the event is raised here directly.
    setup()
    open()
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.scroll(document, {})
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))

    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('closes on Escape and hands focus back to the row', () => {
    setup()
    const trigger = screen.getByRole('button', { name: 'Actions for Maria' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('never fires a disabled action', () => {
    const onSelect = vi.fn()
    setup([{ label: 'Delete', danger: true, disabled: true, onSelect }])
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('walks the items with the arrow keys, skipping what is disabled', () => {
    setup([
      { label: 'Edit', onSelect: vi.fn() },
      { label: 'Deactivate', disabled: true, onSelect: vi.fn() },
      { label: 'Delete', danger: true, onSelect: vi.fn() },
    ])
    open()

    // Opening lands on the first item, so a keyboard user is inside the menu
    // rather than left on the trigger with it hanging open beneath them.
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit' }))

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    // Deactivate is disabled, so Delete is next — indexing by the action's own
    // position would have landed on the item nobody can press.
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit' })) // wraps
  })
})
