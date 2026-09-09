/**
 * Closing the preset menu unmounts whatever holds focus. These pin where focus
 * goes next, because the answer used to be <body>: no ring anywhere, and the
 * next Tab restarting from the skip link at the top of the app.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PresetMenu } from './PresetMenu'
import { createMockBridge } from '../mock/bridge'
import { initAppStore } from '../state/store'

afterEach(cleanup)

beforeEach(async () => {
  const store = initAppStore(createMockBridge({ rotateFocus: false }))
  await store.getState().actions.init()
})

function openMenu(): HTMLElement {
  render(<PresetMenu />)
  const trigger = screen.getByRole('button', { name: /Presets/ })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('preset menu focus', () => {
  it('returns focus to the trigger after a preset is chosen', async () => {
    const trigger = openMenu()
    const pick = screen.getByRole('menuitemradio', { name: /Minecraft AFK farm/ })
    pick.focus()
    fireEvent.click(pick)

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger on Escape', async () => {
    const trigger = openMenu()
    screen.getByRole('menuitemradio', { name: /Autoclicker/ }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves focus alone when the menu is dismissed by clicking elsewhere', async () => {
    const trigger = openMenu()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()

    fireEvent.pointerDown(outside)
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    // The click has already put focus where the user pointed. Snatching it
    // back to the trigger would fight them.
    expect(document.activeElement).toBe(outside)
    expect(document.activeElement).not.toBe(trigger)
    outside.remove()
  })
})
