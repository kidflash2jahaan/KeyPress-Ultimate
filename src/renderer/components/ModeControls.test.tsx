/**
 * The interval fields.
 *
 * The store clamps every interval the instant it is set, which is right for a
 * finished value and ruinous for a half-typed one. These tests pin the rule
 * that stops it: a keystroke edits a draft, and only blur or Enter commits.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeControls } from './ModeControls'
import { createMockBridge } from '../mock/bridge'
import { getAppStore, initAppStore, LIMITS } from '../state/store'

afterEach(cleanup)

function mount(mode: 'hold-repeat' | 'tap'): void {
  const store = initAppStore(createMockBridge({ rotateFocus: false }))
  store.getState().actions.setMode(mode)
  render(<ModeControls />)
}

function field(name: string): HTMLInputElement {
  return screen.getByLabelText(`${name}, in milliseconds`) as HTMLInputElement
}

describe('typing an interval', () => {
  it('does not clamp on every keystroke', () => {
    mount('hold-repeat')
    const input = field('First repeat after')
    expect(input.value).toBe('400')

    // "1500", one keystroke at a time. Committing per keystroke turned this
    // into 100, then 1005, then 10050 clamped to 2000.
    for (const value of ['1', '15', '150', '1500']) {
      fireEvent.change(input, { target: { value } })
      expect(input.value).toBe(value)
    }
    expect(getAppStore().getState().repeatInitialMs).toBe(400)

    fireEvent.blur(input)
    expect(getAppStore().getState().repeatInitialMs).toBe(1500)
    expect(input.value).toBe('1500')
  })

  it('can be cleared and retyped', () => {
    mount('hold-repeat')
    const input = field('Then every')

    fireEvent.change(input, { target: { value: '' } })
    // Number('') is 0, which used to clamp straight back to the minimum and
    // make the field impossible to empty.
    expect(input.value).toBe('')
    expect(getAppStore().getState().repeatIntervalMs).toBe(33)

    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.blur(input)
    expect(getAppStore().getState().repeatIntervalMs).toBe(120)
  })

  it('commits on Enter without waiting for a blur', () => {
    mount('tap')
    const input = field('Tap every')

    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(getAppStore().getState().tapIntervalMs).toBe(250)
  })

  it('puts the live value back when the field is left empty', () => {
    mount('tap')
    const input = field('Tap every')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input.value).toBe('100')
    expect(getAppStore().getState().tapIntervalMs).toBe(100)
  })

  it('shows the clamp once the value is finished', () => {
    mount('tap')
    const input = field('Tap every')

    fireEvent.change(input, { target: { value: '99999' } })
    fireEvent.blur(input)
    expect(getAppStore().getState().tapIntervalMs).toBe(LIMITS.tapIntervalMs.max)
    expect(input.value).toBe(String(LIMITS.tapIntervalMs.max))
  })

  it('shows the clamp even when it lands back on the value already held', () => {
    mount('tap')
    const input = field('Tap every')
    fireEvent.change(input, { target: { value: String(LIMITS.tapIntervalMs.min) } })
    fireEvent.blur(input)
    expect(input.value).toBe(String(LIMITS.tapIntervalMs.min))

    // The store clamps this back to the minimum it is already holding, so no
    // prop changes and nothing resyncs the field. It still has to tell the
    // truth about what is stored.
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    expect(getAppStore().getState().tapIntervalMs).toBe(LIMITS.tapIntervalMs.min)
    expect(input.value).toBe(String(LIMITS.tapIntervalMs.min))
  })

  it('abandons the draft on Escape', () => {
    mount('tap')
    const input = field('Tap every')

    fireEvent.change(input, { target: { value: '750' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('100')
    expect(getAppStore().getState().tapIntervalMs).toBe(100)
  })
})
