/**
 * macOS native input, ported from `scratchpad/spike-macos/macos-native.mjs`
 * (695 lines, exercised against real CoreGraphics on the build machine). Every
 * constant here was read out of the macOS 26.5 SDK headers, not from memory,
 * and every design decision below traces to a measurement recorded in the spec.
 *
 * This file and `./windows.ts` are the only two files in the app allowed to
 * call koffi.
 *
 * THE SIX THINGS THAT MATTER
 *
 * 1. Focus comes from `CGWindowListCopyWindowInfo`'s front layer-0 window
 *    owner, never `-[NSWorkspace frontmostApplication]`. The latter is updated
 *    by a workspace notification, so in a process that does not service a
 *    CFRunLoop it never updates at all: measured frozen for 231 seconds across
 *    16 real focus changes. Whenever focus is uncertain we return null and the
 *    caller treats that as "not on target" and releases. A stuck key is far
 *    worse than a dropped hold.
 *
 * 2. One shared `CGEventSource` with `kCGEventSourceStateHIDSystemState`, whose
 *    local-events suppression interval is forced from the 0.25s default to 0.0
 *    and whose suppression filter permits all events in both suppression
 *    states. Without this the user's real keyboard and mouse go dead while we
 *    hold keys.
 *
 * 3. Events are posted to `kCGHIDEventTap`, the point where real hardware
 *    enters the window server, so a synthetic key travels the identical path a
 *    physical one does and updates the global key state games read.
 *
 * 4. Modifiers are posted as `kCGEventFlagsChanged`, never key-down/key-up, and
 *    the cumulative modifier mask is stamped on every posted event. macOS keeps
 *    no cross-event memory of held modifiers: whatever is in an event's flags
 *    field is what the receiving app sees.
 *
 * 5. Enumeration runs inside an `NSAutoreleasePool`. `runningApplications`
 *    returns a freshly autoreleased array on every call: measured 7.48MB leaked
 *    over 50,000 pool-less calls against 0.16MB with a pool.
 *
 * 6. `listApplications()` keeps only `activationPolicy === 0`, which is exactly
 *    "real windowed apps, not background processes": 6 regular apps out of 95
 *    processes on a normal desktop.
 *
 * Never enable App Sandbox. It silently no-ops `CGEventPost`.
 */
import koffi, { type KoffiFunc } from 'koffi'
import type { AppInfo, KeyDef, MouseDef } from '@shared/types'
import type { NativeInput, NativeInputExtras } from './types'

// ---------------------------------------------------------------------------
// Constants, all from the macOS 26.5 SDK
// ---------------------------------------------------------------------------

/** CGEventTapLocation. HID, not session: see note 3 at the top of this file. */
const kCGHIDEventTap = 0

/** CGEventSourceStateID. 1 means "this source's state is real hardware state". */
const kCGEventSourceStateHIDSystemState = 1

/**
 * CGEventType. Mouse types come from `data/mouse.json`; of the keyboard types
 * (kCGEventKeyDown 10, kCGEventKeyUp 11, kCGEventFlagsChanged 12) only the last
 * is named here, because `CGEventCreateKeyboardEvent` picks between the first
 * two itself and only a modifier has to be retyped afterwards.
 */
const kCGEventFlagsChanged = 12

/** CGEventField. */
const kCGMouseEventClickState = 1
const kCGMouseEventButtonNumber = 3
const kCGKeyboardEventAutorepeat = 8
const kCGKeyboardEventKeycode = 9

/** CGEventFilterMask: `kCGEventFilterMaskPermitLocal{MouseEvents,KeyboardEvents}` + Sys. */
const kCGEventFilterMaskPermitAllEvents = 0x1 | 0x2 | 0x4

/** CGEventSuppressionState. Both states must permit local events. */
const kCGEventSuppressionStateSuppressionInterval = 0
const kCGEventSuppressionStateRemoteMouseDrag = 1

/** CGWindowListOption. */
const kCGWindowListOptionOnScreenOnly = 1 << 0
const kCGWindowListExcludeDesktopElements = 1 << 4
const kCGNullWindowID = 0

/** NSApplicationActivationPolicyRegular: has a Dock icon and a menu bar. */
const ACTIVATION_POLICY_REGULAR = 0

/** CGEventFlags modifier masks. */
const MASK_CAPSLOCK = 0x00010000
const MASK_SHIFT = 0x00020000
const MASK_CONTROL = 0x00040000
const MASK_OPTION = 0x00080000
const MASK_COMMAND = 0x00100000
const MASK_FN = 0x00800000

/**
 * macOS key code -> coarse modifier mask plus the low-byte "device dependent"
 * left/right bit real hardware carries (IOLLEvent.h `NX_DEVICE*KEYMASK`). Games
 * and engines distinguish left from right shift by reading these, so we set them
 * alongside the coarse mask to look as much like hardware as possible.
 *
 * Keyed by `KeyDef.macKeyCode` rather than by `KeyDef.isModifier`, because Caps
 * Lock carries a flag mask while the data quite correctly marks it neither a
 * modifier nor holdable.
 */
const MODIFIER_BITS: ReadonlyMap<number, number> = new Map([
  [54, MASK_COMMAND | 0x0010], // right command, NX_DEVICERCMDKEYMASK
  [55, MASK_COMMAND | 0x0008], // left command,  NX_DEVICELCMDKEYMASK
  [56, MASK_SHIFT | 0x0002], //   left shift,    NX_DEVICELSHIFTKEYMASK
  [57, MASK_CAPSLOCK], //         caps lock
  [58, MASK_OPTION | 0x0020], //  left option,   NX_DEVICELALTKEYMASK
  [59, MASK_CONTROL | 0x0001], // left control,  NX_DEVICELCTLKEYMASK
  [60, MASK_SHIFT | 0x0004], //   right shift,   NX_DEVICERSHIFTKEYMASK
  [61, MASK_OPTION | 0x0040], //  right option,  NX_DEVICERALTKEYMASK
  [62, MASK_CONTROL | 0x2000], // right control, NX_DEVICERCTLKEYMASK
  [63, MASK_FN], //               fn
])

/**
 * The modifiers the focus-gain gate waits to see released. Caps Lock and fn are
 * excluded: Caps Lock is a latched state rather than something a user holds
 * through a Cmd-Tab, and a held fn cannot turn a `W` into a destructive
 * shortcut.
 */
const PHYSICAL_GATE_KEY_CODES: readonly number[] = [54, 55, 56, 58, 59, 60, 61, 62]

/**
 * Verified against this machine's System Settings bundle: the
 * SecurityPrivacyExtension declares the legacy identifier
 * `com.apple.preference.security` and allows the `x-apple.systempreferences`
 * URL scheme, and the `Privacy_Accessibility` anchor is present in its binary.
 */
export const MAC_PERMISSION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

// ---------------------------------------------------------------------------
// FFI bindings
// ---------------------------------------------------------------------------

/** An opaque Objective-C / CoreFoundation pointer, as koffi hands it back. */
type NativePointer = object

interface CGPointValue {
  x: number
  y: number
}

/**
 * `objc_msgSend` has no variadic promotion on arm64: the callee reads arguments
 * from the registers dictated by the *actual* C prototype, so koffi needs one
 * declaration per exact (return type, argument types) shape. Each handle is
 * independent.
 */
interface Bindings {
  sel(name: string): NativePointer
  cls(name: string): NativePointer
  msgSendId: KoffiFunc<(receiver: NativePointer, sel: NativePointer) => NativePointer | null>
  msgSendStr: KoffiFunc<(receiver: NativePointer, sel: NativePointer) => string | null>
  msgSendInt: KoffiFunc<(receiver: NativePointer, sel: NativePointer) => number>
  msgSendLong: KoffiFunc<(receiver: NativePointer, sel: NativePointer) => number>
  msgSendULong: KoffiFunc<(receiver: NativePointer, sel: NativePointer) => number>
  msgSendBool: KoffiFunc<(receiver: NativePointer, sel: NativePointer) => boolean>
  msgSendIdWithIndex: KoffiFunc<
    (receiver: NativePointer, sel: NativePointer, index: number) => NativePointer | null
  >
  msgSendIdWithPointer: KoffiFunc<
    (
      receiver: NativePointer,
      sel: NativePointer,
      argument: NativePointer | Buffer,
    ) => NativePointer | null
  >
  msgSendIdWithInt: KoffiFunc<
    (receiver: NativePointer, sel: NativePointer, argument: number) => NativePointer | null
  >
  CFRelease: KoffiFunc<(cf: NativePointer) => void>
  CGEventSourceCreate: KoffiFunc<(stateId: number) => NativePointer | null>
  CGEventSourceSetLocalEventsSuppressionInterval: KoffiFunc<
    (source: NativePointer, seconds: number) => void
  >
  CGEventSourceGetLocalEventsSuppressionInterval: KoffiFunc<(source: NativePointer) => number>
  CGEventSourceSetLocalEventsFilterDuringSuppressionState: KoffiFunc<
    (source: NativePointer, filter: number, state: number) => void
  >
  CGEventSourceGetLocalEventsFilterDuringSuppressionState: KoffiFunc<
    (source: NativePointer, state: number) => number
  >
  CGEventSourceKeyState: KoffiFunc<(stateId: number, keyCode: number) => boolean>
  CGEventCreate: KoffiFunc<(source: NativePointer | null) => NativePointer | null>
  CGEventCreateKeyboardEvent: KoffiFunc<
    (source: NativePointer, virtualKey: number, keyDown: boolean) => NativePointer | null
  >
  CGEventCreateMouseEvent: KoffiFunc<
    (
      source: NativePointer,
      mouseType: number,
      cursor: CGPointValue,
      mouseButton: number,
    ) => NativePointer | null
  >
  CGEventPost: KoffiFunc<(tap: number, event: NativePointer) => void>
  CGEventPostToPid: KoffiFunc<(pid: number, event: NativePointer) => void>
  CGEventSetType: KoffiFunc<(event: NativePointer, type: number) => void>
  CGEventGetType: KoffiFunc<(event: NativePointer) => number>
  CGEventSetFlags: KoffiFunc<(event: NativePointer, flags: number) => void>
  CGEventGetFlags: KoffiFunc<(event: NativePointer) => number>
  CGEventGetLocation: KoffiFunc<(event: NativePointer) => CGPointValue>
  CGEventSetIntegerValueField: KoffiFunc<
    (event: NativePointer, field: number, value: number) => void
  >
  CGEventGetIntegerValueField: KoffiFunc<(event: NativePointer, field: number) => number>
  CGWindowListCopyWindowInfo: KoffiFunc<
    (option: number, relativeToWindow: number) => NativePointer | null
  >
  CGPreflightPostEventAccess: KoffiFunc<() => boolean>
  classes: {
    NSAutoreleasePool: NativePointer
    NSRunningApplication: NativePointer
    NSString: NativePointer
    sharedWorkspace: NativePointer
  }
  windowKeys: {
    layer: NativePointer
    ownerPid: NativePointer
  }
  pointSize: number
}

/**
 * Bound once per process and cached. koffi refuses to register the same struct
 * name twice, and re-declaring `objc_msgSend` per adapter instance would be
 * pure waste, so two `MacNativeInput`s share one binding table.
 */
let cachedBindings: Bindings | null = null

/** Pool bookkeeping, so the tests can prove enumeration is actually wrapped. */
let poolsCreated = 0
let poolsDrained = 0

function bind(): Bindings {
  if (cachedBindings !== null) return cachedBindings

  const libobjc = koffi.load('/usr/lib/libobjc.A.dylib')
  // AppKit must be loaded or NSWorkspace / NSRunningApplication are not
  // registered with the Objective-C runtime and objc_getClass returns NULL.
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')
  const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

  const objcGetClass = libobjc.func(
    'void *objc_getClass(const char *name)',
  ) as KoffiFunc<(name: string) => NativePointer | null>
  const selRegisterName = libobjc.func(
    'void *sel_registerName(const char *name)',
  ) as KoffiFunc<(name: string) => NativePointer>

  const selectorCache = new Map<string, NativePointer>()
  const sel = (name: string): NativePointer => {
    const cached = selectorCache.get(name)
    if (cached !== undefined) return cached
    const selector = selRegisterName(name)
    selectorCache.set(name, selector)
    return selector
  }

  const classCache = new Map<string, NativePointer>()
  const cls = (name: string): NativePointer => {
    const cached = classCache.get(name)
    if (cached !== undefined) return cached
    const klass = objcGetClass(name)
    if (klass === null) throw new Error(`objc_getClass("${name}") returned NULL`)
    classCache.set(name, klass)
    return klass
  }

  // CGFloat is double on every 64-bit platform. koffi passes and returns this
  // 16-byte two-double struct by value correctly on arm64 (it is a homogeneous
  // float aggregate, passed in v0/v1), verified by round-tripping through
  // CGEventCreateMouseEvent / CGEventGetLocation with exact equality.
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' })

  const msgSendId = libobjc.func('objc_msgSend', 'void *', ['void *', 'void *']) as Bindings['msgSendId']
  const msgSendIdWithPointer = libobjc.func('objc_msgSend', 'void *', [
    'void *',
    'void *',
    'void *',
  ]) as Bindings['msgSendIdWithPointer']

  const NSString = cls('NSString')
  const stringWithUTF8String = sel('stringWithUTF8String:')
  const retain = sel('retain')
  const alloc = sel('alloc')
  const init = sel('init')
  const drain = sel('drain')
  const NSAutoreleasePool = cls('NSAutoreleasePool')

  // The CGWindowList dictionary keys are toll-free-bridged NSStrings. Built once
  // inside a pool and retained forever, because stringWithUTF8String: returns an
  // autoreleased object that would otherwise die when the pool drains.
  const pool = msgSendId(msgSendId(NSAutoreleasePool, alloc) as NativePointer, init)
  if (pool === null) throw new Error('failed to create an NSAutoreleasePool')
  let windowKeys: Bindings['windowKeys']
  try {
    const nsString = (value: string): NativePointer => {
      const created = msgSendIdWithPointer(
        NSString,
        stringWithUTF8String,
        Buffer.from(`${value}\0`, 'utf8'),
      )
      if (created === null) throw new Error(`+[NSString stringWithUTF8String:"${value}"] failed`)
      const retained = msgSendId(created, retain)
      if (retained === null) throw new Error(`-[NSString retain] failed for "${value}"`)
      return retained
    }
    windowKeys = { layer: nsString('kCGWindowLayer'), ownerPid: nsString('kCGWindowOwnerPID') }
  } finally {
    msgSendId(pool, drain)
  }

  cachedBindings = {
    sel,
    cls,
    msgSendId,
    msgSendStr: libobjc.func('objc_msgSend', 'str', ['void *', 'void *']) as Bindings['msgSendStr'],
    msgSendInt: libobjc.func('objc_msgSend', 'int', ['void *', 'void *']) as Bindings['msgSendInt'],
    msgSendLong: libobjc.func('objc_msgSend', 'long', [
      'void *',
      'void *',
    ]) as Bindings['msgSendLong'],
    msgSendULong: libobjc.func('objc_msgSend', 'unsigned long', [
      'void *',
      'void *',
    ]) as Bindings['msgSendULong'],
    msgSendBool: libobjc.func('objc_msgSend', 'bool', [
      'void *',
      'void *',
    ]) as Bindings['msgSendBool'],
    msgSendIdWithIndex: libobjc.func('objc_msgSend', 'void *', [
      'void *',
      'void *',
      'unsigned long',
    ]) as Bindings['msgSendIdWithIndex'],
    msgSendIdWithPointer,
    msgSendIdWithInt: libobjc.func('objc_msgSend', 'void *', [
      'void *',
      'void *',
      'int',
    ]) as Bindings['msgSendIdWithInt'],
    CFRelease: CF.func('void CFRelease(void *cf)') as Bindings['CFRelease'],
    CGEventSourceCreate: CG.func(
      'void *CGEventSourceCreate(int32_t stateID)',
    ) as Bindings['CGEventSourceCreate'],
    CGEventSourceSetLocalEventsSuppressionInterval: CG.func(
      'void CGEventSourceSetLocalEventsSuppressionInterval(void *source, double seconds)',
    ) as Bindings['CGEventSourceSetLocalEventsSuppressionInterval'],
    CGEventSourceGetLocalEventsSuppressionInterval: CG.func(
      'double CGEventSourceGetLocalEventsSuppressionInterval(void *source)',
    ) as Bindings['CGEventSourceGetLocalEventsSuppressionInterval'],
    CGEventSourceSetLocalEventsFilterDuringSuppressionState: CG.func(
      'void CGEventSourceSetLocalEventsFilterDuringSuppressionState(void *source, uint32_t filter, uint32_t state)',
    ) as Bindings['CGEventSourceSetLocalEventsFilterDuringSuppressionState'],
    CGEventSourceGetLocalEventsFilterDuringSuppressionState: CG.func(
      'uint32_t CGEventSourceGetLocalEventsFilterDuringSuppressionState(void *source, uint32_t state)',
    ) as Bindings['CGEventSourceGetLocalEventsFilterDuringSuppressionState'],
    CGEventSourceKeyState: CG.func(
      'bool CGEventSourceKeyState(int32_t stateID, uint16_t key)',
    ) as Bindings['CGEventSourceKeyState'],
    CGEventCreate: CG.func('void *CGEventCreate(void *source)') as Bindings['CGEventCreate'],
    CGEventCreateKeyboardEvent: CG.func(
      'void *CGEventCreateKeyboardEvent(void *source, uint16_t virtualKey, bool keyDown)',
    ) as Bindings['CGEventCreateKeyboardEvent'],
    CGEventCreateMouseEvent: CG.func(
      'void *CGEventCreateMouseEvent(void *source, uint32_t mouseType, CGPoint mouseCursorPosition, uint32_t mouseButton)',
    ) as Bindings['CGEventCreateMouseEvent'],
    CGEventPost: CG.func('void CGEventPost(uint32_t tap, void *event)') as Bindings['CGEventPost'],
    CGEventPostToPid: CG.func(
      'void CGEventPostToPid(int32_t pid, void *event)',
    ) as Bindings['CGEventPostToPid'],
    CGEventSetType: CG.func(
      'void CGEventSetType(void *event, uint32_t type)',
    ) as Bindings['CGEventSetType'],
    CGEventGetType: CG.func(
      'uint32_t CGEventGetType(void *event)',
    ) as Bindings['CGEventGetType'],
    CGEventSetFlags: CG.func(
      'void CGEventSetFlags(void *event, uint64_t flags)',
    ) as Bindings['CGEventSetFlags'],
    CGEventGetFlags: CG.func(
      'uint64_t CGEventGetFlags(void *event)',
    ) as Bindings['CGEventGetFlags'],
    CGEventGetLocation: CG.func(
      'CGPoint CGEventGetLocation(void *event)',
    ) as Bindings['CGEventGetLocation'],
    CGEventSetIntegerValueField: CG.func(
      'void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)',
    ) as Bindings['CGEventSetIntegerValueField'],
    CGEventGetIntegerValueField: CG.func(
      'int64_t CGEventGetIntegerValueField(void *event, uint32_t field)',
    ) as Bindings['CGEventGetIntegerValueField'],
    CGWindowListCopyWindowInfo: CG.func(
      'void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)',
    ) as Bindings['CGWindowListCopyWindowInfo'],
    CGPreflightPostEventAccess: CG.func(
      'bool CGPreflightPostEventAccess()',
    ) as Bindings['CGPreflightPostEventAccess'],
    classes: {
      NSAutoreleasePool,
      NSRunningApplication: cls('NSRunningApplication'),
      NSString,
      sharedWorkspace: (() => {
        // NSWorkspace is a process-wide singleton: resolve once, never release.
        const workspace = msgSendId(cls('NSWorkspace'), sel('sharedWorkspace'))
        if (workspace === null) throw new Error('+[NSWorkspace sharedWorkspace] returned NULL')
        return workspace
      })(),
    },
    windowKeys,
    pointSize: koffi.sizeof(CGPoint),
  }
  return cachedBindings
}

/** Run `body` inside an NSAutoreleasePool, so repeated polling does not grow RSS. */
function withPool<T>(b: Bindings, body: () => T): T {
  const allocated = b.msgSendId(b.classes.NSAutoreleasePool, b.sel('alloc'))
  if (allocated === null) throw new Error('+[NSAutoreleasePool alloc] returned NULL')
  const pool = b.msgSendId(allocated, b.sel('init'))
  if (pool === null) throw new Error('-[NSAutoreleasePool init] returned NULL')
  poolsCreated += 1
  try {
    return body()
  } finally {
    b.msgSendId(pool, b.sel('drain'))
    poolsDrained += 1
  }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One `NSRunningApplication`, before the activation-policy filter. */
export interface MacRunningApp {
  pid: number
  name: string | null
  bundleId: string | null
  path: string | null
  activationPolicy: number
  active: boolean
}

/**
 * Everything CoreGraphics holds on an event that was built but, in dry-run
 * mode, deliberately not posted.
 */
export interface InspectedEvent {
  /** The tap it would have gone to. Always `kCGHIDEventTap` (0). */
  tap: number
  /** Target process for a `CGEventPostToPid` release, or null for a global post. */
  toPid: number | null
  type: number
  keyCode: number
  flags: number
  autorepeat: number
  clickState: number
  buttonNumber: number
  location: CGPointValue
}

export type EventInspector = (event: InspectedEvent) => void

export interface MacNativeInputOptions {
  /**
   * Dry run. When an inspector is supplied the adapter still builds the real
   * CGEvent it would post, through real CoreGraphics, reads every field back off
   * it and releases it, but never calls `CGEventPost` or `CGEventPostToPid`.
   * That is how the test suite proves event construction without touching the
   * machine it runs on.
   */
  inspector?: EventInspector
}

type HeldItem =
  | { kind: 'key'; key: KeyDef; code: number; modifierBits: number }
  | { kind: 'button'; button: MouseDef; number: number }

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class MacNativeInput implements NativeInput, NativeInputExtras {
  readonly #inspector: EventInspector | undefined
  #bindings: Bindings | null = null
  #source: NativePointer | null = null
  #sourceCreations = 0
  /** Press order. Release order is this, reversed, with modifiers last. */
  #held: HeldItem[] = []
  #heldKeyCodes = new Set<number>()
  #heldButtonNumbers = new Set<number>()
  #flags = 0

  constructor(options: MacNativeInputOptions = {}) {
    this.#inspector = options.inspector
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Bind CoreGraphics, assert the one struct layout we depend on, then create
   * and configure the single shared event source. Throws rather than posting
   * anything through a source whose suppression settings did not take.
   */
  async init(): Promise<void> {
    const b = this.#bind()

    if (b.pointSize !== 16) {
      throw new Error(
        `Refusing to inject input with an unknown struct layout: sizeof(CGPoint) is ${b.pointSize}, expected 16`,
      )
    }

    if (this.#source !== null) return

    const source = b.CGEventSourceCreate(kCGEventSourceStateHIDSystemState)
    if (source === null) {
      throw new Error('CGEventSourceCreate(kCGEventSourceStateHIDSystemState) returned NULL')
    }
    this.#sourceCreations += 1

    // macOS suppresses the user's own hardware events for 0.25s after every
    // synthetic one. A hold-keys tool posting continuously would make their real
    // keyboard and mouse feel dead, so the interval goes to zero and the filter
    // permits local events during both suppression states.
    b.CGEventSourceSetLocalEventsSuppressionInterval(source, 0)
    b.CGEventSourceSetLocalEventsFilterDuringSuppressionState(
      source,
      kCGEventFilterMaskPermitAllEvents,
      kCGEventSuppressionStateSuppressionInterval,
    )
    b.CGEventSourceSetLocalEventsFilterDuringSuppressionState(
      source,
      kCGEventFilterMaskPermitAllEvents,
      kCGEventSuppressionStateRemoteMouseDrag,
    )

    const interval = b.CGEventSourceGetLocalEventsSuppressionInterval(source)
    if (interval !== 0) {
      b.CFRelease(source)
      throw new Error(
        `local events suppression interval read back as ${interval}, expected 0. ` +
          'Holding keys with this source would deaden the real keyboard and mouse.',
      )
    }

    this.#source = source
  }

  /** Release everything held, then the event source. Safe to call repeatedly. */
  dispose(): void {
    this.releaseAll()
    const b = this.#bindings
    if (b !== null && this.#source !== null) b.CFRelease(this.#source)
    this.#source = null
  }

  // -- keyboard -------------------------------------------------------------

  /** Press and hold. Already held is a no-op: Hold mode never re-asserts. */
  keyDown(key: KeyDef): void {
    const code = macKeyCode(key)
    if (this.#heldKeyCodes.has(code)) return
    const modifierBits = MODIFIER_BITS.get(code) ?? 0
    this.#held.push({ kind: 'key', key, code, modifierBits })
    this.#heldKeyCodes.add(code)
    // A modifier must be inside the mask before its own event is posted.
    this.#flags |= modifierBits
    this.#postKey(code, true, { modifier: modifierBits !== 0, flags: this.#flags })
  }

  /**
   * Re-send a key-down for an already-held key with the autorepeat flag set.
   * Hold+Repeat mode's only assert: never an intermediate key-up.
   */
  keyDownRepeat(key: KeyDef): void {
    const code = macKeyCode(key)
    if (!this.#heldKeyCodes.has(code)) {
      this.keyDown(key)
      return
    }
    // A modifier has no autorepeat: real hardware emits one FlagsChanged and
    // nothing more until the key comes back up.
    if (MODIFIER_BITS.has(code)) return
    this.#postKey(code, true, { modifier: false, flags: this.#flags, repeat: true })
  }

  /** Release. Not held is a no-op. */
  keyUp(key: KeyDef): void {
    const code = macKeyCode(key)
    const index = this.#held.findIndex((item) => item.kind === 'key' && item.code === code)
    if (index === -1) return
    const item = this.#held[index]
    if (item === undefined || item.kind !== 'key') return
    this.#held.splice(index, 1)
    this.#heldKeyCodes.delete(code)
    // A modifier must be out of the mask before its own release is posted.
    this.#flags = this.#computeFlags()
    this.#postKey(code, false, { modifier: item.modifierBits !== 0, flags: this.#flags })
  }

  /**
   * Post one key-up straight at a single process without touching held state.
   *
   * On focus loss every release is posted twice: here first, so the app that was
   * holding the key definitely sees it go up even though it is no longer
   * frontmost, then globally through `keyUp()` to clear system state.
   */
  keyUpToPid(key: KeyDef, pid: number): void {
    const code = macKeyCode(key)
    const item = this.#held.find((held) => held.kind === 'key' && held.code === code)
    if (item === undefined || item.kind !== 'key') return
    // Flags as they will be once this key is released, so the targeted event and
    // the global one that follows tell the app the same story.
    this.#postKey(code, false, {
      modifier: item.modifierBits !== 0,
      flags: this.#flags & ~item.modifierBits,
      toPid: pid,
    })
  }

  /**
   * True when the user is holding no physical modifier. Keys this adapter is
   * itself holding are discounted, because `CGEventSourceKeyState` reads the
   * combined HID state and our own synthetic modifiers show up in it.
   */
  physicalModifiersClear(): boolean {
    const b = this.#bind()
    for (const code of PHYSICAL_GATE_KEY_CODES) {
      if (this.#heldKeyCodes.has(code)) continue
      if (b.CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, code)) return false
    }
    return true
  }

  // -- mouse ----------------------------------------------------------------

  mouseDown(btn: MouseDef): void {
    const number = macMouseButton(btn)
    if (this.#heldButtonNumbers.has(number)) return
    this.#held.push({ kind: 'button', button: btn, number })
    this.#heldButtonNumbers.add(number)
    this.#postMouse(btn, number, true)
  }

  mouseUp(btn: MouseDef): void {
    const number = macMouseButton(btn)
    const index = this.#held.findIndex((item) => item.kind === 'button' && item.number === number)
    if (index === -1) return
    this.#held.splice(index, 1)
    this.#heldButtonNumbers.delete(number)
    this.#postMouse(btn, number, false)
  }

  // -- release --------------------------------------------------------------

  /**
   * Release everything, in reverse press order with modifiers last, and never
   * throw. This runs from exit handlers and signal handlers, where the only
   * thing worse than a failed release is a failed release that aborts the rest
   * of them.
   */
  releaseAll(): void {
    if (this.#held.length === 0) return
    const reversed = [...this.#held].reverse()

    for (const item of reversed) {
      if (item.kind === 'key' && item.modifierBits !== 0) continue
      this.#releaseQuietly(item)
    }
    for (const item of reversed) {
      if (item.kind !== 'key' || item.modifierBits === 0) continue
      this.#releaseQuietly(item)
    }

    // Whatever the OS did with those posts, this adapter is no longer holding
    // anything: leaving stale entries behind would make the next releaseAll()
    // re-post releases for keys that are already up.
    this.#held = []
    this.#heldKeyCodes.clear()
    this.#heldButtonNumbers.clear()
    this.#flags = 0
  }

  #releaseQuietly(item: HeldItem): void {
    try {
      if (item.kind === 'key') this.keyUp(item.key)
      else this.mouseUp(item.button)
    } catch {
      // Best effort. A throw here would strand every key after this one.
    }
  }

  // -- focus and enumeration ------------------------------------------------

  /**
   * pid of the app owning the frontmost normal (layer 0) window, or null.
   *
   * A synchronous query to the WindowServer, so it cannot go stale and cannot
   * block on another process. Null means "uncertain", and the caller must treat
   * uncertain as "not on target" and release.
   */
  getFrontmostPid(): number | null {
    let b: Bindings
    try {
      b = this.#bind()
    } catch {
      return null
    }
    try {
      return withPool(b, () => {
        const windows = b.CGWindowListCopyWindowInfo(
          kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
          kCGNullWindowID,
        )
        if (windows === null) return null
        try {
          // Ordered front to back, so the first layer-0 entry is the front
          // window. The Dock, menu bar and panels sit above layer 0.
          const count = b.msgSendULong(windows, b.sel('count'))
          for (let index = 0; index < count; index++) {
            const window = b.msgSendIdWithIndex(windows, b.sel('objectAtIndex:'), index)
            if (window === null) continue
            const layer = b.msgSendIdWithPointer(window, b.sel('objectForKey:'), b.windowKeys.layer)
            if (layer === null || b.msgSendInt(layer, b.sel('intValue')) !== 0) continue
            const owner = b.msgSendIdWithPointer(
              window,
              b.sel('objectForKey:'),
              b.windowKeys.ownerPid,
            )
            if (owner === null) return null
            const pid = b.msgSendInt(owner, b.sel('intValue'))
            return pid > 0 ? pid : null
          }
          return null
        } finally {
          // CGWindowListCopyWindowInfo is a *Copy* function: we own the array.
          b.CFRelease(windows)
        }
      })
    } catch {
      return null
    }
  }

  /**
   * Real windowed apps only, keyed by bundle identifier so a target survives the
   * game restarting. An app with no bundle identifier is dropped: there is no
   * stable identity to remember it by.
   */
  listApplications(): AppInfo[] {
    const apps: AppInfo[] = []
    for (const app of this.enumerateApplications()) {
      if (app.activationPolicy !== ACTIVATION_POLICY_REGULAR) continue
      if (app.bundleId === null || app.bundleId.length === 0) continue
      apps.push({
        identity: app.bundleId,
        name: app.name ?? app.bundleId,
        pid: app.pid,
        path: app.path,
      })
    }
    return apps
  }

  /** Every running application NSWorkspace knows about, unfiltered. */
  enumerateApplications(): MacRunningApp[] {
    const b = this.#bind()
    return withPool(b, () => {
      const array = b.msgSendId(b.classes.sharedWorkspace, b.sel('runningApplications'))
      if (array === null) return []
      const count = b.msgSendULong(array, b.sel('count'))
      const out: MacRunningApp[] = []
      for (let index = 0; index < count; index++) {
        const app = b.msgSendIdWithIndex(array, b.sel('objectAtIndex:'), index)
        if (app === null) continue
        out.push(readRunningApplication(b, app))
      }
      return out
    })
  }

  /** One pid, resolved live through LaunchServices. Null for a non-application. */
  getApplicationByPid(pid: number): MacRunningApp | null {
    const b = this.#bind()
    return withPool(b, () => {
      const app = b.msgSendIdWithInt(
        b.classes.NSRunningApplication,
        b.sel('runningApplicationWithProcessIdentifier:'),
        pid,
      )
      return app === null ? null : readRunningApplication(b, app)
    })
  }

  // -- permissions ----------------------------------------------------------

  /**
   * TCC `kTCCServicePostEvent`, which is the precise question `CGEventPost`
   * cares about. Never prompts: the `CGRequestPostEventAccess` variant does, and
   * is deliberately not bound anywhere in this file.
   */
  hasPermission(): boolean {
    try {
      return this.#bind().CGPreflightPostEventAccess()
    } catch {
      return false
    }
  }

  /**
   * Returns the Accessibility deep link rather than opening it.
   *
   * The injector is a `utilityProcess`. Raising a window from here would be the
   * wrong process doing it, so the caller (the main process) opens the returned
   * URL with `shell.openExternal`. The `NativeInput` contract types this as
   * returning void, which a string return satisfies.
   */
  openPermissionSettings(): string {
    return MAC_PERMISSION_SETTINGS_URL
  }

  // -- introspection, for tests and diagnostics -----------------------------

  /** Exactly what this adapter believes it is holding down. */
  getHeld(): { keyIds: string[]; buttonIds: string[]; flags: number } {
    const keyIds: string[] = []
    const buttonIds: string[] = []
    for (const item of this.#held) {
      if (item.kind === 'key') keyIds.push(item.key.id)
      else buttonIds.push(item.button.id)
    }
    return { keyIds, buttonIds, flags: this.#flags }
  }

  /** Read straight back out of CoreGraphics. Must be 0. */
  localEventsSuppressionInterval(): number {
    return this.#bind().CGEventSourceGetLocalEventsSuppressionInterval(this.#requireSource())
  }

  /** The suppression filter for one `CGEventSuppressionState`. Must permit all. */
  localEventsFilterDuringSuppressionState(state: number): number {
    return this.#bind().CGEventSourceGetLocalEventsFilterDuringSuppressionState(
      this.#requireSource(),
      state,
    )
  }

  eventSourceStateId(): number {
    return kCGEventSourceStateHIDSystemState
  }

  /** How many event sources this adapter has created. One, for its whole life. */
  eventSourceCreations(): number {
    return this.#sourceCreations
  }

  /** Process-wide autorelease pool bookkeeping, so the pool wrapping is testable. */
  autoreleasePoolStats(): { created: number; drained: number } {
    return { created: poolsCreated, drained: poolsDrained }
  }

  // -- internals ------------------------------------------------------------

  #bind(): Bindings {
    if (this.#bindings === null) this.#bindings = bind()
    return this.#bindings
  }

  #requireSource(): NativePointer {
    if (this.#source === null) {
      throw new Error('MacNativeInput.init() must be awaited before posting any event')
    }
    return this.#source
  }

  #computeFlags(): number {
    let flags = 0
    for (const item of this.#held) if (item.kind === 'key') flags |= item.modifierBits
    return flags
  }

  #postKey(
    code: number,
    down: boolean,
    options: { modifier: boolean; flags: number; repeat?: boolean; toPid?: number },
  ): void {
    const b = this.#bind()
    const source = this.#requireSource()
    const event = b.CGEventCreateKeyboardEvent(source, code, down)
    if (event === null) throw new Error(`CGEventCreateKeyboardEvent failed for key code ${code}`)
    try {
      if (options.modifier) {
        // Real hardware never delivers a modifier as keyDown/keyUp: the window
        // server emits kCGEventFlagsChanged. Retype the event so the receiver's
        // idea of what is held stays coherent.
        b.CGEventSetType(event, kCGEventFlagsChanged)
      } else if (options.repeat === true) {
        b.CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, 1)
      }
      // Always stamp the cumulative mask. This also clears the undocumented
      // 0x20000000 bit CoreGraphics puts on freshly created keyboard events.
      b.CGEventSetFlags(event, options.flags)
      this.#emit(b, event, options.toPid ?? null)
    } finally {
      b.CFRelease(event) // CGEventCreate* follows the CF *Create* rule: we own it.
    }
  }

  #postMouse(btn: MouseDef, number: number, down: boolean): void {
    const b = this.#bind()
    const source = this.#requireSource()
    const type = down ? btn.macDownType : btn.macUpType
    if (type === null) {
      throw new Error(`mouse button "${btn.id}" has no macOS ${down ? 'down' : 'up'} event type`)
    }
    // Hold the button wherever the cursor already is.
    const at = this.#cursorPosition(b)
    const event = b.CGEventCreateMouseEvent(source, type, at, number)
    if (event === null) throw new Error(`CGEventCreateMouseEvent failed for button ${number}`)
    try {
      // 1 = a single click, 2 = the second of a double. A held button must never
      // read as a double click, and some apps ignore an event left at 0.
      b.CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1)
      // For kCGEventOtherMouse* the button identity lives only in this field.
      b.CGEventSetIntegerValueField(event, kCGMouseEventButtonNumber, number)
      b.CGEventSetFlags(event, this.#flags)
      this.#emit(b, event, null)
    } finally {
      b.CFRelease(event)
    }
  }

  #cursorPosition(b: Bindings): CGPointValue {
    const event = b.CGEventCreate(null)
    if (event === null) return { x: 0, y: 0 }
    try {
      return b.CGEventGetLocation(event)
    } finally {
      b.CFRelease(event)
    }
  }

  /**
   * The single place an event leaves this file. With an inspector attached
   * nothing is posted at all: the event is read back and handed over instead.
   */
  #emit(b: Bindings, event: NativePointer, toPid: number | null): void {
    const inspector = this.#inspector
    if (inspector !== undefined) {
      inspector({
        tap: kCGHIDEventTap,
        toPid,
        type: b.CGEventGetType(event),
        keyCode: b.CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode),
        flags: b.CGEventGetFlags(event),
        autorepeat: b.CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat),
        clickState: b.CGEventGetIntegerValueField(event, kCGMouseEventClickState),
        buttonNumber: b.CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber),
        location: b.CGEventGetLocation(event),
      })
      return
    }
    if (toPid === null) b.CGEventPost(kCGHIDEventTap, event)
    else b.CGEventPostToPid(toPid, event)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRunningApplication(b: Bindings, app: NativePointer): MacRunningApp {
  const bundleUrl = b.msgSendId(app, b.sel('bundleURL'))
  const utf8 = (value: NativePointer | null): string | null =>
    value === null ? null : b.msgSendStr(value, b.sel('UTF8String'))
  return {
    pid: b.msgSendInt(app, b.sel('processIdentifier')),
    name: utf8(b.msgSendId(app, b.sel('localizedName'))),
    bundleId: utf8(b.msgSendId(app, b.sel('bundleIdentifier'))),
    path: bundleUrl === null ? null : utf8(b.msgSendId(bundleUrl, b.sel('path'))),
    activationPolicy: b.msgSendLong(app, b.sel('activationPolicy')),
    active: b.msgSendBool(app, b.sel('isActive')),
  }
}

function macKeyCode(key: KeyDef): number {
  if (key.macKeyCode === null) {
    throw new Error(`"${key.id}" has no macOS key code, so it cannot be pressed on this platform`)
  }
  return key.macKeyCode
}

function macMouseButton(btn: MouseDef): number {
  if (!btn.holdable || btn.macButton === null) {
    throw new Error(`mouse input "${btn.id}" is not holdable on macOS`)
  }
  return btn.macButton
}
