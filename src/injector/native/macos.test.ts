/**
 * macOS native adapter tests.
 *
 * NOTHING IN THIS FILE POSTS AN EVENT. Every adapter under test is constructed
 * with an `inspector`, which puts it in dry-run mode: it still builds the real
 * CGEvent it would post, through real CoreGraphics, then reads type, keycode,
 * flags, autorepeat, click state and button number back off it and releases it.
 * `CGEventPost` and `CGEventPostToPid` are never reached. That is exactly the
 * proof strategy of `scratchpad/spike-macos/10-verify.mjs`.
 *
 * The read-only calls (`listApplications`, `getFrontmostPid`,
 * `hasPermission`, `physicalModifiersClear`) are made for real, because they
 * synthesize nothing. `openPermissionSettings()` returns a URL and opens no
 * window, so it is safe to call too.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getKeyById, getMouseButtonById } from '@shared/keys'
import type { KeyDef, MouseDef } from '@shared/types'
import {
  MAC_PERMISSION_SETTINGS_URL,
  MacNativeInput,
  type InspectedEvent,
} from './macos'
import { createNativeInputFor } from './index'

// CGEventType
const KEY_DOWN = 10
const KEY_UP = 11
const FLAGS_CHANGED = 12
const LEFT_MOUSE_DOWN = 1
const LEFT_MOUSE_UP = 2
const OTHER_MOUSE_DOWN = 25
const OTHER_MOUSE_UP = 26
// CGEventTapLocation
const HID_EVENT_TAP = 0
// CGEventFlags
const MASK_SHIFT = 0x00020000
const DEVICE_LEFT_SHIFT = 0x0002

function key(id: string): KeyDef {
  const found = getKeyById(id)
  if (found === undefined) throw new Error(`test fixture: no key "${id}"`)
  return found
}

function button(id: string): MouseDef {
  const found = getMouseButtonById(id)
  if (found === undefined) throw new Error(`test fixture: no button "${id}"`)
  return found
}

const W = key('key-w')
const A = key('key-a')
const LEFT_SHIFT = key('key-left-shift')
const RIGHT_SHIFT = key('key-right-shift')
const SCROLL_LOCK = key('key-scroll-lock') // macKeyCode === null on macOS
const LMB = button('left')
const MMB = button('middle')
const BACK = button('back')
const WHEEL_UP = button('wheel-up')

const onMac = process.platform === 'darwin'
const describeMac = onMac ? describe : describe.skip

describeMac('MacNativeInput (dry run, nothing is posted)', () => {
  let events: InspectedEvent[]
  let mac: MacNativeInput

  beforeEach(async () => {
    events = []
    mac = new MacNativeInput({ inspector: (event) => events.push(event) })
    await mac.init()
  })

  // -- non-negotiable 2: event source suppression ---------------------------

  it('forces the local events suppression interval to 0', () => {
    // Read straight back out of CoreGraphics, not off a JS field. The macOS
    // default is 0.25s, which deadens the user's real keyboard and mouse for a
    // quarter second after every event we post.
    expect(mac.localEventsSuppressionInterval()).toBe(0)
  })

  it('permits all local events during both suppression states', () => {
    const permitAll = 0x7
    expect(mac.localEventsFilterDuringSuppressionState(0)).toBe(permitAll)
    expect(mac.localEventsFilterDuringSuppressionState(1)).toBe(permitAll)
  })

  it('uses one shared HID-system event source for the life of the adapter', () => {
    expect(mac.eventSourceStateId()).toBe(1) // kCGEventSourceStateHIDSystemState
    mac.keyDown(W)
    mac.keyDown(LEFT_SHIFT)
    mac.mouseDown(LMB)
    mac.releaseAll()
    expect(mac.eventSourceCreations()).toBe(1)
  })

  // -- non-negotiable 3: tap location ---------------------------------------

  it('posts every event to kCGHIDEventTap', () => {
    // `tap` is the argument the posting path was actually handed, not a
    // constant the dry run restates: `#emit` chooses the tap and `#post` both
    // reports it and passes it to CGEventPost, so a post routed to the session
    // tap (1) fails here. A session-tap post does not update the global key
    // state games read through the HID layer, which is the whole product.
    mac.keyDown(W)
    mac.keyDown(LEFT_SHIFT)
    mac.mouseDown(LMB)
    mac.keyUpToPid(W, 4242) // the pid-targeted path chooses a tap too
    mac.releaseAll()
    expect(events.length).toBeGreaterThan(4)
    for (const event of events) expect(event.tap).toBe(HID_EVENT_TAP)
  })

  // -- keyboard -------------------------------------------------------------

  it('builds a plain key-down with no flags and no autorepeat', () => {
    mac.keyDown(W)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: KEY_DOWN,
      keyCode: W.macKeyCode,
      flags: 0,
      autorepeat: 0,
      toPid: null,
    })
  })

  it('never re-asserts a key that is already held', () => {
    mac.keyDown(W)
    mac.keyDown(W)
    mac.keyDown(W)
    expect(events).toHaveLength(1)
  })

  it('sets the autorepeat field only when a repeat is asked for', () => {
    mac.keyDown(W)
    events.length = 0
    mac.keyDownRepeat(W)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: KEY_DOWN, keyCode: W.macKeyCode, autorepeat: 1 })
  })

  it('refuses a key that does not exist on macOS', () => {
    expect(SCROLL_LOCK.macKeyCode).toBeNull()
    expect(() => mac.keyDown(SCROLL_LOCK)).toThrow(/no macOS key code/i)
    expect(events).toHaveLength(0)
  })

  // -- non-negotiable 4: modifiers as FlagsChanged --------------------------

  it('posts a modifier as kCGEventFlagsChanged, not key-down', () => {
    mac.keyDown(LEFT_SHIFT)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe(FLAGS_CHANGED)
    expect(events[0]?.type).not.toBe(KEY_DOWN)
  })

  it('carries the modifier mask and the left/right device bit on the modifier event', () => {
    mac.keyDown(LEFT_SHIFT)
    expect(events[0]?.flags).toBe(MASK_SHIFT | DEVICE_LEFT_SHIFT)
  })

  it('stamps the cumulative modifier mask on every event while a modifier is held', () => {
    mac.keyDown(LEFT_SHIFT)
    events.length = 0
    mac.keyDown(W)
    mac.mouseDown(LMB)
    mac.keyUp(W)
    expect(events).toHaveLength(3)
    for (const event of events) expect(event.flags).toBe(MASK_SHIFT | DEVICE_LEFT_SHIFT)
  })

  it('clears the modifier out of the mask before posting its own release', () => {
    mac.keyDown(LEFT_SHIFT)
    events.length = 0
    mac.keyUp(LEFT_SHIFT)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: FLAGS_CHANGED, flags: 0 })
  })

  // -- releasing what this instance never pressed ---------------------------
  //
  // The main process owns its own adapter and has never pressed anything on
  // it: the injector process did the pressing. Both of main's last-resort
  // release paths, the crash-journal replay at startup and the fallback used
  // when the injector dies, call keyUp/mouseUp on that fresh instance. An
  // adapter that released only what it personally pressed would post nothing,
  // let main report a released count, and let the journal that was the last
  // record of the stuck key be deleted. Every test below runs on the `mac`
  // built in beforeEach, which has pressed nothing at all.

  it('posts a key-up for a key it never pressed', () => {
    expect(mac.getHeld()).toEqual({ keyIds: [], buttonIds: [], flags: 0 })

    mac.keyUp(W)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: KEY_UP, keyCode: W.macKeyCode, flags: 0, toPid: null })
  })

  it('posts a mouse-up for a button it never pressed', () => {
    mac.mouseUp(LMB)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: LEFT_MOUSE_UP, clickState: 1 })
  })

  it('posts a modifier it never pressed as FlagsChanged, not key-up', () => {
    mac.keyUp(LEFT_SHIFT)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: FLAGS_CHANGED,
      keyCode: LEFT_SHIFT.macKeyCode,
      flags: 0,
    })
  })

  it('replays a whole journal plan on an adapter that pressed none of it', () => {
    // Exactly what `releaseDirectly` does with a recovered journal.
    mac.mouseUp(LMB)
    mac.keyUp(W)
    mac.keyUp(LEFT_SHIFT)

    expect(events.map((event) => event.type)).toEqual([LEFT_MOUSE_UP, KEY_UP, FLAGS_CHANGED])
  })

  it('does not disturb a genuinely held modifier when releasing one it is not holding', () => {
    mac.keyDown(LEFT_SHIFT)
    events.length = 0

    mac.keyUp(RIGHT_SHIFT)

    // Left shift is still down, so the shift mask must survive: the mask is not
    // per-key, and clearing right shift's bits out of it would tell every app
    // that shift came up while it is still being held.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: FLAGS_CHANGED,
      keyCode: RIGHT_SHIFT.macKeyCode,
      flags: MASK_SHIFT | DEVICE_LEFT_SHIFT,
    })
    expect(mac.getHeld().keyIds).toEqual([LEFT_SHIFT.id])
  })

  it('leaves the held set untouched by a release for something it is not holding', () => {
    mac.keyDown(W)
    mac.keyUp(A)
    mac.mouseUp(LMB)
    expect(mac.getHeld()).toEqual({ keyIds: [W.id], buttonIds: [], flags: 0 })

    events.length = 0
    mac.releaseAll()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: KEY_UP, keyCode: W.macKeyCode })
  })

  it('reports held state exactly', () => {
    mac.keyDown(W)
    mac.keyDown(LEFT_SHIFT)
    mac.mouseDown(LMB)
    expect(mac.getHeld()).toEqual({
      keyIds: [W.id, LEFT_SHIFT.id],
      buttonIds: [LMB.id],
      flags: MASK_SHIFT | DEVICE_LEFT_SHIFT,
    })
  })

  // -- mouse ----------------------------------------------------------------

  it('builds left mouse down and up with a click state of 1', () => {
    mac.mouseDown(LMB)
    mac.mouseUp(LMB)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: LEFT_MOUSE_DOWN, clickState: 1 })
    expect(events[1]).toMatchObject({ type: LEFT_MOUSE_UP, clickState: 1 })
  })

  it('routes buttons past right through OtherMouse with an explicit button number', () => {
    mac.mouseDown(MMB)
    mac.mouseDown(BACK)
    expect(events[0]).toMatchObject({ type: OTHER_MOUSE_DOWN, buttonNumber: 2 })
    expect(events[1]).toMatchObject({ type: OTHER_MOUSE_DOWN, buttonNumber: 3 })
    events.length = 0
    mac.mouseUp(BACK)
    expect(events[0]).toMatchObject({ type: OTHER_MOUSE_UP, buttonNumber: 3 })
  })

  it('refuses to hold the scroll wheel', () => {
    expect(WHEEL_UP.holdable).toBe(false)
    expect(() => mac.mouseDown(WHEEL_UP)).toThrow(/not holdable/i)
    expect(events).toHaveLength(0)
  })

  // -- non-negotiable 7: releaseAll ----------------------------------------

  it('releases in reverse press order with modifiers last', () => {
    mac.keyDown(W)
    mac.keyDown(A)
    mac.keyDown(LEFT_SHIFT)
    mac.mouseDown(LMB)
    events.length = 0

    mac.releaseAll()

    const sequence = events.map((event) =>
      event.type === LEFT_MOUSE_UP || event.type === OTHER_MOUSE_UP
        ? `mouse:${event.buttonNumber}`
        : `key:${event.keyCode}:${event.type}`,
    )
    expect(sequence).toEqual([
      'mouse:0',
      `key:${A.macKeyCode}:${KEY_UP}`,
      `key:${W.macKeyCode}:${KEY_UP}`,
      `key:${LEFT_SHIFT.macKeyCode}:${FLAGS_CHANGED}`,
    ])
    expect(events[3]?.flags).toBe(0)
  })

  it('is idempotent: a second releaseAll posts nothing', () => {
    mac.keyDown(W)
    mac.mouseDown(LMB)
    mac.releaseAll()
    events.length = 0

    mac.releaseAll()

    expect(events).toHaveLength(0)
    expect(mac.getHeld()).toEqual({ keyIds: [], buttonIds: [], flags: 0 })
  })

  it('releases everything on dispose and stays disposable twice', () => {
    mac.keyDown(W)
    events.length = 0
    mac.dispose()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: KEY_UP, keyCode: W.macKeyCode })
    events.length = 0
    mac.dispose()
    expect(events).toHaveLength(0)
  })

  // -- non-negotiable 8: pid-targeted release ------------------------------

  it('keyUpToPid targets one process and leaves the held set untouched', () => {
    mac.keyDown(W)
    events.length = 0

    mac.keyUpToPid(W, 4242)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: KEY_UP, keyCode: W.macKeyCode, toPid: 4242 })
    // Still held: the global up is a second, separate post.
    expect(mac.getHeld().keyIds).toEqual([W.id])

    events.length = 0
    mac.keyUp(W)
    expect(events[0]).toMatchObject({ type: KEY_UP, keyCode: W.macKeyCode, toPid: null })
    expect(mac.getHeld().keyIds).toEqual([])
  })

  it('keyUpToPid clears a modifier out of the mask for the targeted release too', () => {
    mac.keyDown(LEFT_SHIFT)
    events.length = 0
    mac.keyUpToPid(LEFT_SHIFT, 4242)
    expect(events[0]).toMatchObject({ type: FLAGS_CHANGED, flags: 0, toPid: 4242 })
  })

  it('keyUpToPid posts nothing for a key that is not held', () => {
    mac.keyUpToPid(W, 4242)
    expect(events).toHaveLength(0)
  })

  // -- non-negotiable 1: focus source --------------------------------------

  it('getFrontmostPid returns a live pid or null, never a sentinel', () => {
    const pid = mac.getFrontmostPid()
    if (pid !== null) {
      expect(Number.isInteger(pid)).toBe(true)
      expect(pid).toBeGreaterThan(0)
    }
  })

  it('resolves the frontmost pid through the WindowServer, not a cached workspace notification', () => {
    // A CGWindowListCopyWindowInfo round trip measured 104us on the reference
    // machine. -[NSWorkspace frontmostApplication], the wrong source (measured
    // frozen for 231s across 16 real focus changes), costs 0.3us because it
    // just reads a cached ivar. This lower bound can therefore only fail if the
    // implementation is swapped back to the stale source.
    const iterations = 2000
    for (let i = 0; i < 200; i++) mac.getFrontmostPid()
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) mac.getFrontmostPid()
    const meanUs = Number(process.hrtime.bigint() - start) / 1000 / iterations
    expect(meanUs).toBeGreaterThan(5)
  })

  // -- non-negotiable 5: autorelease pool ----------------------------------

  it('wraps every enumeration in an NSAutoreleasePool', () => {
    const before = mac.autoreleasePoolStats()
    mac.listApplications()
    const afterList = mac.autoreleasePoolStats()
    expect(afterList.created - before.created).toBe(1)
    expect(afterList.drained - before.drained).toBe(1)

    mac.getFrontmostPid()
    const afterFocus = mac.autoreleasePoolStats()
    expect(afterFocus.drained - afterList.drained).toBe(1)
    expect(afterFocus.created).toBe(afterFocus.drained)
  })

  it('does not grow native memory across repeated enumeration', () => {
    // `runningApplications` hands back a freshly autoreleased NSArray on every
    // call, so without a pool this leaks: measured 7.48MB over 50,000 calls
    // against 0.16MB with one. RSS alone cannot see that, because V8's own heap
    // churn from 30,000 rounds of app objects dwarfs it, so the measure here is
    // RSS minus the committed JS heap: what the Objective-C side is holding.
    // The warm-up is long on purpose: V8 grows its own heap for the first few
    // thousand rounds of app objects, and that shows up in RSS as tens of
    // megabytes that have nothing to do with Objective-C. Once it plateaus, RSS
    // growth is native growth.
    for (let i = 0; i < 12000; i++) mac.listApplications()
    const before = process.memoryUsage().rss
    for (let i = 0; i < 30000; i++) mac.listApplications()
    expect((process.memoryUsage().rss - before) / 1048576).toBeLessThan(3)
  }, 120_000)

  // -- non-negotiable 6: listApplications ----------------------------------

  it('lists only activation-policy-0 apps, keyed by bundle identifier', () => {
    const all = mac.enumerateApplications()
    const listed = mac.listApplications()

    expect(all.length).toBeGreaterThan(listed.length) // agents and daemons dropped
    expect(all.some((app) => app.activationPolicy !== 0)).toBe(true)

    const regularWithBundleId = all.filter(
      (app) => app.activationPolicy === 0 && app.bundleId !== null,
    )
    expect(listed).toHaveLength(regularWithBundleId.length)

    for (const app of listed) {
      const raw = all.find((candidate) => candidate.pid === app.pid)
      expect(raw?.activationPolicy).toBe(0)
      expect(app.identity).toBe(raw?.bundleId)
      expect(app.identity.length).toBeGreaterThan(0)
      expect(app.name.length).toBeGreaterThan(0)
      expect(app.pid).toBeGreaterThan(0)
    }
  })

  // -- permissions ----------------------------------------------------------

  it('reports permission as a boolean without prompting', () => {
    // CGPreflightPostEventAccess never raises the TCC dialog; the Request
    // variant does and is deliberately not bound anywhere in the adapter.
    expect(typeof mac.hasPermission()).toBe('boolean')
    expect(mac.hasPermission()).toBe(mac.hasPermission())
  })

  it('hands back the Accessibility deep link instead of opening a window', () => {
    expect(mac.openPermissionSettings()).toBe(MAC_PERMISSION_SETTINGS_URL)
    expect(MAC_PERMISSION_SETTINGS_URL).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    )
  })

  it('answers whether the user is physically holding a modifier', () => {
    expect(typeof mac.physicalModifiersClear()).toBe('boolean')
  })
})

describe('createNativeInputFor', () => {
  it('refuses a platform with no adapter', async () => {
    await expect(createNativeInputFor('linux')).rejects.toThrow(
      /keypress ultimate does not support linux/i,
    )
  })

  it('names the platform it was given', async () => {
    await expect(createNativeInputFor('freebsd')).rejects.toThrow(/freebsd/)
  })
})
