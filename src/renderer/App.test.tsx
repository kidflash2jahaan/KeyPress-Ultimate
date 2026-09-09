/**
 * Shell tests.
 *
 * These are the checks that only hold once the pieces are wired together: the
 * board printing the legends of the platform it is running on, the plate
 * carrying a `--u` and a `--gap` that agree, the lower band being tied to the
 * plate's width, and the settings sheet actually containing focus.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { GAP_RATIO, plateOuterWidthPx, UNIT_FULL } from './components/keyboard-layout'
import { createMockBridge } from './mock/bridge'
import { initAppStore } from './state/store'
import type { Platform } from '../shared/types'

/** jsdom has no layout, so the observer never fires and `--u` stays UNIT_FULL. */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(platform: Platform = 'darwin'): Promise<void> {
  const store = initAppStore(createMockBridge({ platform, rotateFocus: false }))
  await store.getState().actions.init()
  render(<App />)
  await waitFor(() => {
    expect(document.querySelector('[aria-label="Keyboard"]')).not.toBeNull()
  })
}

function plateElement(): HTMLElement {
  const board = screen.getByRole('group', { name: 'Keyboard' })
  const plate = board.parentElement
  if (plate === null) throw new Error('the board has no plate around it')
  return plate
}

describe('key legends', () => {
  it('prints the macOS legends on macOS', async () => {
    await mount('darwin')

    // The two caps either side of the space bar. They printed "Meta" for as
    // long as withPlatformLabels was only ever called from a test.
    expect(screen.getAllByLabelText('⌘ Command')).toHaveLength(2)
    expect(screen.getAllByLabelText('⌥ Option')).toHaveLength(2)
    expect(screen.getByLabelText('Return')).toBeTruthy()
    expect(screen.getByLabelText('⌫ Delete')).toBeTruthy()
    expect(screen.queryByLabelText('Meta')).toBeNull()
    expect(screen.queryByLabelText('Backspace')).toBeNull()
  })

  it('prints the Windows legends on Windows', async () => {
    await mount('win32')

    expect(screen.getAllByLabelText('Win')).toHaveLength(2)
    expect(screen.getByLabelText('Backspace')).toBeTruthy()
    // The main Enter and the numpad Enter, both named the same on Windows.
    expect(screen.getAllByLabelText('Enter')).toHaveLength(2)
    expect(screen.queryByLabelText('Meta')).toBeNull()
    expect(screen.queryByLabelText('⌘ Command')).toBeNull()
  })

  it('names the selection in the status line with the same legend', async () => {
    await mount('darwin')
    // A target and a key, so the line is the ready sentence rather than a
    // refusal that names neither.
    fireEvent.click(screen.getByRole('button', { name: /Minecraft/ }))
    fireEvent.click(screen.getAllByLabelText('⌘ Command')[0] as HTMLElement)

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('⌘ Command')
    expect(status.textContent).not.toContain('Meta')
  })
})

describe('plate geometry', () => {
  it('sets --gap on the plate, from the same unit as --u', async () => {
    await mount()
    const plate = plateElement()

    const unit = Number.parseFloat(plate.style.getPropertyValue('--u'))
    const gap = Number.parseFloat(plate.style.getPropertyValue('--gap'))
    expect(unit).toBe(UNIT_FULL)
    // The bug: --gap lived on :root, resolved against the viewport clamp, and
    // could not see the plate's unit at all.
    expect(gap).toBeCloseTo(unit * GAP_RATIO, 5)
  })

  it('publishes the plate width so the lower band can line up with it', async () => {
    await mount()
    const shell = plateElement().closest('div[data-phase]')
    expect(shell).not.toBeNull()
    expect((shell as HTMLElement).style.getPropertyValue('--plate-w')).toBe(
      `${plateOuterWidthPx(UNIT_FULL)}px`,
    )
  })
})

describe('settings sheet focus containment', () => {
  async function openSettings(): Promise<HTMLElement> {
    await mount()
    const trigger = screen.getByLabelText('Settings')
    // Focus it the way a click would in a browser: the sheet returns focus to
    // whatever held it when the sheet opened.
    trigger.focus()
    fireEvent.click(trigger)
    await screen.findByRole('dialog')
    return trigger
  }

  it('makes the app behind the scrim inert while the sheet is open', async () => {
    await openSettings()

    const main = document.querySelector('main')
    expect(main).not.toBeNull()
    // aria-modal="true" claims this. Without inert, Tab walked out of the
    // sheet and onto the keycaps underneath a blurred scrim.
    expect((main as HTMLElement).hasAttribute('inert')).toBe(true)
    expect(document.querySelector('header')?.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('footer')?.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
  })

  it('wraps Tab from the last control back to the first', async () => {
    await openSettings()
    // First and last tab stops in the sheet, on macOS: the header's Done
    // button and the Updates group's Check now button.
    const first = screen.getByRole('button', { name: 'Done' })
    const last = screen.getByRole('button', { name: 'Check now' })

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('counts a radio group as the one tab stop the browser gives it', async () => {
    await openSettings()
    const checked = screen.getByRole('radio', { name: 'Follow the system' })
    expect((checked as HTMLInputElement).checked).toBe(true)

    // Shift+Tab off the first stop must land on the last control, not on an
    // unchecked radio that Tab would never have visited.
    screen.getByRole('button', { name: 'Done' }).focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).not.toBe(screen.getByRole('radio', { name: 'Dark' }))
  })

  it('lets the app back in and returns focus when the sheet closes', async () => {
    const trigger = await openSettings()
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })
})
