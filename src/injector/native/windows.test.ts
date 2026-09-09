/**
 * Windows adapter tests, all of which run on macOS.
 *
 * The Windows layer cannot be exercised on the machine it was written on, so these tests
 * cover the three things that CAN be proved off-Windows and that would otherwise only
 * fail on a user's machine:
 *
 *   1. the hand-written INPUT records are byte-identical to what koffi's own struct and
 *      union marshaller produces for the same INPUT, for every record shape we send;
 *   2. the layout constants the byte writers hardcode are the ones koffi measures, and
 *      the refusal fires when they are not;
 *   3. importing the module on a non-Windows host is silent, and the binding failure is
 *      parked in `initError` instead of thrown, so the app can show a real error.
 *
 * Plus the pure encoding rules (scan codes, extended keys, the virtual-key fallback) and
 * the held-state bookkeeping, which is where a stuck key would come from.
 *
 * darwin-arm64 is a valid ABI proxy for Windows x64 for these member types: the same
 * alignment rules give the same offsets, which is what test 2 asserts rather than assumes.
 */

import koffi from 'koffi'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { KeyDef, MouseDef } from '../../shared/types'
import { getKeyById, getKeys, getMouseButtonById } from '../../shared/keys'
import { hasNativeInputExtras, type NativeInput } from './types'
import {
  __test,
  createWindowsNativeInput,
  encodeKey,
  encodeMouseDown,
  encodeMouseUp,
  encodeScan,
  expectedInputLayout,
  handleAddress,
  INPUT_LAYOUT_32,
  INPUT_LAYOUT_64,
  isNullHandle,
  isWindows,
  KEYEVENTF,
  KPU_EXTRA_INFO,
  LAYOUT_REFUSAL,
  MOUSEEVENTF,
  MOUSEDATA,
  probeStructLayout,
  assertStructLayout,
  timeBeginPeriod,
  timeEndPeriod,
  windowsNative,
  type InputLayout,
} from './windows'

// ---------------------------------------------------------------------------------
// The reference marshaller: koffi's own struct and union encoder.
// Anonymous types, so re-running this file cannot collide on a registered type name.
// ---------------------------------------------------------------------------------

const ULONG_PTR = 'uint64'
const REF_MOUSEINPUT = koffi.struct({
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: ULONG_PTR,
})
const REF_KEYBDINPUT = koffi.struct({
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: ULONG_PTR,
})
const REF_HARDWAREINPUT = koffi.struct({ uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
const REF_UNION = koffi.union({ mi: REF_MOUSEINPUT, ki: REF_KEYBDINPUT, hi: REF_HARDWAREINPUT })
const REF_INPUT = koffi.struct({ type: 'uint32', u: REF_UNION })
const REF_SIZE = koffi.sizeof(REF_INPUT)
const EXTRA = BigInt(KPU_EXTRA_INFO)

interface RefKey {
  wVk?: number
  wScan?: number
  dwFlags: number
}
interface RefMouse {
  dx?: number
  dy?: number
  mouseData?: number
  dwFlags: number
}

/** One koffi-marshalled keyboard INPUT, at record index `i` of `buf`. */
function refKey(buf: Buffer, i: number, fields: RefKey): void {
  koffi.encode(buf, i * REF_SIZE, REF_INPUT, {
    type: 1,
    u: {
      ki: {
        wVk: fields.wVk ?? 0,
        wScan: fields.wScan ?? 0,
        dwFlags: fields.dwFlags,
        time: 0,
        dwExtraInfo: EXTRA,
      },
    },
  })
}

/** One koffi-marshalled mouse INPUT. `mouseData` is passed already widened to uint32. */
function refMouse(buf: Buffer, i: number, fields: RefMouse): void {
  koffi.encode(buf, i * REF_SIZE, REF_INPUT, {
    type: 0,
    u: {
      mi: {
        dx: fields.dx ?? 0,
        dy: fields.dy ?? 0,
        mouseData: (fields.mouseData ?? 0) >>> 0,
        dwFlags: fields.dwFlags,
        time: 0,
        dwExtraInfo: EXTRA,
      },
    },
  })
}

// ---------------------------------------------------------------------------------
// Minimal fixtures. Literals rather than data/keys.json so an encoding test fails for
// exactly one reason; the real data is exercised separately, below.
// ---------------------------------------------------------------------------------

function makeKey(overrides: Partial<KeyDef> & Pick<KeyDef, 'id'>): KeyDef {
  return {
    label: overrides.id,
    section: 'alphanum',
    row: 0,
    unitWidth: 1,
    unitHeight: 1,
    macKeyCode: null,
    winVirtualKey: null,
    winScanCode: null,
    winExtended: false,
    isModifier: false,
    holdable: true,
    ...overrides,
  }
}

function makeButton(overrides: Partial<MouseDef> & Pick<MouseDef, 'id'>): MouseDef {
  return {
    label: overrides.id,
    description: '',
    holdable: true,
    macButton: null,
    macDownType: null,
    macUpType: null,
    winFlagDown: null,
    winFlagUp: null,
    winMouseData: 0,
    ...overrides,
  }
}

/** KeyW: scan 0x11, not extended. */
const KEY_W = makeKey({ id: 'key-w', label: 'W', winVirtualKey: 0x57, winScanCode: 0x11 })
/** ArrowUp: 0xE048, so scan 0x48 plus the extended flag. */
const ARROW_UP = makeKey({
  id: 'key-arrow-up',
  label: 'Up',
  winVirtualKey: 0x26,
  winScanCode: 0x48,
  winExtended: true,
})
const SHIFT_LEFT = makeKey({
  id: 'key-left-shift',
  label: 'Shift',
  winVirtualKey: 0xa0,
  winScanCode: 0x2a,
  isModifier: true,
})
const KEY_A = makeKey({ id: 'key-a', label: 'A', winVirtualKey: 0x41, winScanCode: 0x1e })

const MOUSE_LEFT = makeButton({ id: 'left', winFlagDown: 0x0002, winFlagUp: 0x0004 })
const MOUSE_FORWARD = makeButton({
  id: 'forward',
  winFlagDown: 0x0080,
  winFlagUp: 0x0100,
  winMouseData: 0x0002,
})
const WHEEL_DOWN = makeButton({
  id: 'wheel-down',
  holdable: false,
  winFlagDown: 0x0800,
  winFlagUp: null,
  winMouseData: -120,
})

// =====================================================================================

describe('struct layout', () => {
  it('hardcodes the x64 layout the plan specifies', () => {
    expect(INPUT_LAYOUT_64).toEqual({
      sizeofINPUT: 40,
      unionOffset: 8,
      sizeofKEYBDINPUT: 24,
      sizeofMOUSEINPUT: 32,
      sizeofHARDWAREINPUT: 8,
      kiExtraInfoOffset: 16,
      miExtraInfoOffset: 24,
      pointerSize: 8,
    })
  })

  it('hardcodes the ia32 layout, where the four-byte hole disappears', () => {
    expect(INPUT_LAYOUT_32).toEqual({
      sizeofINPUT: 28,
      unionOffset: 4,
      sizeofKEYBDINPUT: 16,
      sizeofMOUSEINPUT: 24,
      sizeofHARDWAREINPUT: 8,
      kiExtraInfoOffset: 12,
      miExtraInfoOffset: 20,
      pointerSize: 4,
    })
  })

  it('selects by pointer width, so win32-arm64 gets the 64-bit layout', () => {
    expect(expectedInputLayout('x64')).toBe(INPUT_LAYOUT_64)
    expect(expectedInputLayout('arm64')).toBe(INPUT_LAYOUT_64)
    expect(expectedInputLayout('ia32')).toBe(INPUT_LAYOUT_32)
  })

  it('matches what koffi actually measures on this host', () => {
    // This is the assertion that makes darwin-arm64 a legitimate proxy for Windows x64.
    expect(probeStructLayout()).toEqual(expectedInputLayout())
    expect(() => assertStructLayout(probeStructLayout())).not.toThrow()
  })

  it('measures the 32-bit layout correctly when asked for it', () => {
    // `pointerSize` is deliberately the host's `void *` and so stays 8 here; every
    // struct offset is driven by the requested ULONG_PTR width and must match ia32.
    const { pointerSize, ...offsets } = probeStructLayout('ia32')
    const { pointerSize: _expected, ...expectedOffsets } = INPUT_LAYOUT_32
    expect(offsets).toEqual(expectedOffsets)
    expect(pointerSize).toBe(expectedInputLayout().pointerSize)
  })

  it('refuses to inject on any mismatch, naming the field', () => {
    const wrong: InputLayout = { ...INPUT_LAYOUT_64, sizeofINPUT: 36, unionOffset: 4 }
    expect(() => assertStructLayout(wrong, 'x64')).toThrow(LAYOUT_REFUSAL)
    expect(() => assertStructLayout(wrong, 'x64')).toThrow(/sizeofINPUT is 36, expected 40/)
    expect(() => assertStructLayout(wrong, 'x64')).toThrow(/unionOffset is 4, expected 8/)
  })

  it('koffi integer widths are the ones Win32 needs, which init also asserts', () => {
    const pointerWidth = koffi.sizeof('void *')
    expect(koffi.sizeof('uintptr')).toBe(pointerWidth) // ULONG_PTR
    expect(koffi.sizeof('intptr')).toBe(pointerWidth) // LPARAM
    expect(koffi.sizeof('int')).toBe(4) // BOOL is four bytes
    expect(koffi.sizeof('int32')).toBe(4) // LONG
    expect(koffi.sizeof('uint32')).toBe(4) // DWORD
    expect(koffi.sizeof('uint16')).toBe(2) // WORD
    // The two traps the module never uses: koffi's 'bool' is one byte where Win32 BOOL
    // is four, and koffi's 'long' is host-defined where Win32 LONG is always 32-bit.
    expect(koffi.sizeof('bool')).not.toBe(4)
  })

  it('the record writers use the layout constants, not their own numbers', () => {
    const layout = expectedInputLayout()
    expect(__test.INPUT_SIZE).toBe(layout.sizeofINPUT)
    expect(__test.UNION_OFF).toBe(layout.unionOffset)
    expect(__test.KI_EXTRA).toBe(layout.kiExtraInfoOffset)
    expect(__test.MI_EXTRA).toBe(layout.miExtraInfoOffset)
  })
})

describe('hand-written INPUT records are byte-identical to koffi', () => {
  it('key down, scan code, not extended', () => {
    const encoding = encodeKey(KEY_W)
    expect(encoding).toMatchObject({ mode: 'scancode', wVk: 0, wScan: 0x11, extended: false })
    expect(encoding.downFlags).toBe(KEYEVENTF.SCANCODE)

    const mine = __test.slotsFor(1)
    __test.writeKeyRecord(mine, 0, {
      wVk: encoding.wVk,
      wScan: encoding.wScan,
      dwFlags: encoding.downFlags,
    })

    const reference = Buffer.alloc(REF_SIZE)
    refKey(reference, 0, { wVk: 0, wScan: 0x11, dwFlags: 0x0008 })
    expect(mine.subarray(0, REF_SIZE)).toEqual(reference)
  })

  it('key up, scan code, extended (the 0xE0 keys)', () => {
    const encoding = encodeKey(ARROW_UP)
    expect(encoding).toMatchObject({ mode: 'scancode', wVk: 0, wScan: 0x48, extended: true })
    expect(encoding.upFlags).toBe(
      KEYEVENTF.SCANCODE | KEYEVENTF.EXTENDEDKEY | KEYEVENTF.KEYUP,
    )

    const mine = __test.slotsFor(1)
    __test.writeKeyRecord(mine, 0, {
      wVk: encoding.wVk,
      wScan: encoding.wScan,
      dwFlags: encoding.upFlags,
    })

    const reference = Buffer.alloc(REF_SIZE)
    refKey(reference, 0, { wVk: 0, wScan: 0x48, dwFlags: 0x000b })
    expect(mine.subarray(0, REF_SIZE)).toEqual(reference)
  })

  it('key down through the virtual-key fallback', () => {
    const encoding = encodeKey(ARROW_UP, true)
    expect(encoding).toMatchObject({ mode: 'virtual-key', wVk: 0x26, extended: true })
    // No KEYEVENTF_SCANCODE: the system derives the scan code from the virtual key.
    expect(encoding.downFlags).toBe(KEYEVENTF.EXTENDEDKEY)

    const mine = __test.slotsFor(1)
    __test.writeKeyRecord(mine, 0, {
      wVk: encoding.wVk,
      wScan: encoding.wScan,
      dwFlags: encoding.downFlags,
    })

    const reference = Buffer.alloc(REF_SIZE)
    refKey(reference, 0, { wVk: 0x26, wScan: 0x48, dwFlags: 0x0001 })
    expect(mine.subarray(0, REF_SIZE)).toEqual(reference)
  })

  it('mouse down, X button, with mouseData and no movement', () => {
    const encoding = encodeMouseDown(MOUSE_FORWARD)
    expect(encoding).toEqual({ dwFlags: MOUSEEVENTF.XDOWN, mouseData: MOUSEDATA.XBUTTON2 })

    const mine = __test.slotsFor(1)
    __test.writeMouseRecord(mine, 0, encoding)

    const reference = Buffer.alloc(REF_SIZE)
    refMouse(reference, 0, { dx: 0, dy: 0, mouseData: 2, dwFlags: 0x0080 })
    expect(mine.subarray(0, REF_SIZE)).toEqual(reference)
  })

  it('mouse wheel, whose mouseData is negative', () => {
    const encoding = encodeMouseDown(WHEEL_DOWN)
    expect(encoding).toEqual({ dwFlags: MOUSEEVENTF.WHEEL, mouseData: -120 })

    const mine = __test.slotsFor(1)
    __test.writeMouseRecord(mine, 0, encoding)

    const reference = Buffer.alloc(REF_SIZE)
    // -120 as a ULONG-shaped field is 0xFFFFFF88; the bytes must be the same either way.
    refMouse(reference, 0, { mouseData: -120 >>> 0, dwFlags: 0x0800 })
    expect(mine.subarray(0, REF_SIZE)).toEqual(reference)
    expect(mine.readInt32LE(__test.UNION_OFF + 8)).toBe(-120)
  })

  it('a multi-record array, which is what releaseAll() sends', () => {
    const mine = __test.slotsFor(3)
    __test.writeKeyRecord(mine, 0, { wScan: 0x11, dwFlags: 0x000a })
    __test.writeKeyRecord(mine, 1, { wScan: 0x1e, dwFlags: 0x000a })
    __test.writeMouseRecord(mine, 2, { dwFlags: MOUSEEVENTF.LEFTUP })

    const reference = Buffer.alloc(REF_SIZE * 3)
    refKey(reference, 0, { wScan: 0x11, dwFlags: 0x000a })
    refKey(reference, 1, { wScan: 0x1e, dwFlags: 0x000a })
    refMouse(reference, 2, { dwFlags: 0x0004 })
    expect(mine.subarray(0, REF_SIZE * 3)).toEqual(reference)
  })

  it('stamps dwExtraInfo so our own events are recognisable', () => {
    const buf = __test.slotsFor(1)
    __test.writeKeyRecord(buf, 0, { wScan: 0x11, dwFlags: KEYEVENTF.SCANCODE })
    const at = __test.UNION_OFF + __test.KI_EXTRA
    expect(buf.readBigUInt64LE(at)).toBe(BigInt(KPU_EXTRA_INFO))
  })

  it('relies on slotsFor() to zero the padding, and slotsFor() does', () => {
    // The writers set only the real members. The four-byte alignment hole at offset 4,
    // the hole before dwExtraInfo, and the union tail are left alone, which is exactly
    // why every batch must be built on a buffer slotsFor() has just zeroed. Prove both
    // halves of that: dirty bytes survive the writer, and slotsFor() removes them.
    const dirty = __test.slotsFor(1)
    dirty.fill(0xff, 0, __test.INPUT_SIZE)
    __test.writeKeyRecord(dirty, 0, { wScan: 0x11, dwFlags: KEYEVENTF.SCANCODE })
    expect(dirty.readUInt32LE(4)).toBe(0xffffffff) // the hole between type and the union
    expect(dirty.readUInt32LE(__test.UNION_OFF + 12)).toBe(0xffffffff) // before dwExtraInfo

    const clean = __test.slotsFor(1)
    __test.writeKeyRecord(clean, 0, { wScan: 0x11, dwFlags: KEYEVENTF.SCANCODE })
    const reference = Buffer.alloc(REF_SIZE)
    refKey(reference, 0, { wScan: 0x11, dwFlags: 0x0008 })
    expect(clean.subarray(0, REF_SIZE)).toEqual(reference)
  })

  it('grows the shared buffer rather than overflowing it', () => {
    const big = __test.slotsFor(64)
    expect(big.length).toBeGreaterThanOrEqual(__test.INPUT_SIZE * 64)
    __test.writeKeyRecord(big, 63, { wScan: 0x11, dwFlags: KEYEVENTF.SCANCODE })
    expect(big.readUInt16LE(63 * __test.INPUT_SIZE + __test.UNION_OFF + 2)).toBe(0x11)
  })
})

describe('scan-code encoding', () => {
  it('passes a plain byte through', () => {
    expect(encodeScan(0x11)).toEqual({ wScan: 0x11, extended: false, prefix: 0 })
  })

  it('splits a 0xE0-prefixed value into byte plus extended flag', () => {
    expect(encodeScan(0xe048)).toEqual({ wScan: 0x48, extended: true, prefix: 0xe0 })
  })

  it('honours the extended hint that data/keys.json carries', () => {
    expect(encodeScan(0x48, true)).toEqual({ wScan: 0x48, extended: true, prefix: 0 })
  })

  it('does not mark a 0xE1 value extended, because Pause cannot be expressed', () => {
    // The physical Pause key emits 0xE1 0x1D 0x45, which one INPUT record cannot carry.
    // We send the bare 0x45, matching Chromium. See the checklist, R-04.
    expect(encodeScan(0xe145)).toEqual({ wScan: 0x45, extended: false, prefix: 0xe1 })
  })
})

describe('encodeKey', () => {
  it('defaults to scan codes with wVk explicitly zero', () => {
    const encoding = encodeKey(KEY_W)
    expect(encoding.mode).toBe('scancode')
    expect(encoding.wVk).toBe(0)
    expect(encoding.downFlags & KEYEVENTF.SCANCODE).toBe(KEYEVENTF.SCANCODE)
  })

  it('sets KEYEVENTF_EXTENDEDKEY only for the 0xE0 keys', () => {
    expect(encodeKey(KEY_W).downFlags & KEYEVENTF.EXTENDEDKEY).toBe(0)
    expect(encodeKey(ARROW_UP).downFlags & KEYEVENTF.EXTENDEDKEY).toBe(KEYEVENTF.EXTENDEDKEY)
  })

  it('uses the virtual-key path when the setting asks for it', () => {
    const encoding = encodeKey(KEY_W, true)
    expect(encoding.mode).toBe('virtual-key')
    expect(encoding.wVk).toBe(0x57)
    expect(encoding.downFlags & KEYEVENTF.SCANCODE).toBe(0)
  })

  it('falls back to the virtual key when there is no scan code, even unasked', () => {
    const oddball = makeKey({ id: 'key-odd', winVirtualKey: 0x1f, winScanCode: null })
    expect(encodeKey(oddball).mode).toBe('virtual-key')
  })

  it('falls back to the scan code when the setting is on but there is no virtual key', () => {
    const scanOnly = makeKey({ id: 'key-scan-only', winVirtualKey: null, winScanCode: 0x56 })
    expect(encodeKey(scanOnly, true).mode).toBe('scancode')
  })

  it('throws by key id when the key has neither code', () => {
    const unusable = makeKey({ id: 'key-fn', label: 'fn' })
    expect(() => encodeKey(unusable)).toThrow(/key-fn/)
    expect(() => encodeKey(unusable)).toThrow(/cannot be injected on Windows/)
  })

  it('agrees with the real data for a plain key, an extended key and a modifier', () => {
    const w = getKeyById('key-w')
    const up = getKeyById('arrow-up')
    const shift = getKeyById('key-left-shift')
    expect(w).toBeDefined()
    expect(up).toBeDefined()
    expect(shift).toBeDefined()
    if (!w || !up || !shift) return
    expect(encodeKey(w)).toMatchObject({ mode: 'scancode', wVk: 0, wScan: 0x11, extended: false })
    expect(encodeKey(up)).toMatchObject({ mode: 'scancode', wScan: 0x48, extended: true })
    expect(encodeKey(shift)).toMatchObject({ mode: 'scancode', wScan: 0x2a, extended: false })
  })

  it('encodes every real key that has a Windows code, on both paths', () => {
    // `key-fn` is the one key in data/keys.json with no Windows code at all; it is
    // macOS-only and the UI must draw it as unavailable rather than hand it to us.
    const unusable: string[] = []
    for (const key of getKeys()) {
      const hasWindowsCode = key.winScanCode !== null || key.winVirtualKey !== null
      if (!hasWindowsCode) {
        expect(() => encodeKey(key)).toThrow(new RegExp(key.id))
        continue
      }
      try {
        encodeKey(key)
        encodeKey(key, true)
      } catch {
        unusable.push(key.id)
      }
    }
    expect(unusable).toEqual([])
  })

  it('sets the extended flag for exactly the keys the data marks extended', () => {
    for (const key of getKeys()) {
      if (key.winScanCode === null) continue
      expect(encodeKey(key).extended).toBe(key.winExtended)
      expect(encodeKey(key).wScan).toBe(key.winScanCode & 0xff)
    }
  })
})

describe('mouse encoding', () => {
  it('produces down and up flags for a holdable button', () => {
    expect(encodeMouseDown(MOUSE_LEFT)).toEqual({ dwFlags: MOUSEEVENTF.LEFTDOWN, mouseData: 0 })
    expect(encodeMouseUp(MOUSE_LEFT)).toEqual({ dwFlags: MOUSEEVENTF.LEFTUP, mouseData: 0 })
  })

  it('returns null for the wheel, which has no up event to hold', () => {
    expect(encodeMouseUp(WHEEL_DOWN)).toBeNull()
  })

  it('throws for a button with no down flag rather than sending an empty record', () => {
    const broken = makeButton({ id: 'middle' })
    expect(() => encodeMouseDown(broken)).toThrow(/middle/)
  })

  it('agrees with the real data for the X buttons and the wheel', () => {
    const forward = getMouseButtonById('forward')
    const wheelDown = getMouseButtonById('wheel-down')
    expect(forward).toBeDefined()
    expect(wheelDown).toBeDefined()
    if (!forward || !wheelDown) return
    expect(encodeMouseDown(forward)).toEqual({
      dwFlags: MOUSEEVENTF.XDOWN,
      mouseData: MOUSEDATA.XBUTTON2,
    })
    expect(encodeMouseUp(wheelDown)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------
// Held-state bookkeeping, through the test-only sender seam. This is the code path a
// stuck key would come from, so it is worth proving without a Windows box.
// ---------------------------------------------------------------------------------

interface SentBatch {
  count: number
  bytes: Buffer
}

describe('held state and releaseAll', () => {
  let adapter: ReturnType<typeof createWindowsNativeInput>
  let batches: SentBatch[]
  let failNext: boolean

  beforeEach(() => {
    adapter = createWindowsNativeInput()
    batches = []
    failNext = false
    __test.installFakeSender((buf, count) => {
      // Copy: the module reuses one buffer, so a reference would alias the next batch.
      batches.push({ count, bytes: Buffer.from(buf.subarray(0, count * __test.INPUT_SIZE)) })
      if (failNext) throw new Error('SendInput inserted 0 of 1 records (simulated)')
      return count
    })
  })

  afterEach(() => {
    __test.installFakeSender(null)
  })

  function recordAt(batch: SentBatch, i: number): { type: number; wScan: number; flags: number } {
    const base = i * __test.INPUT_SIZE + __test.UNION_OFF
    return {
      type: batch.bytes.readUInt32LE(i * __test.INPUT_SIZE),
      wScan: batch.bytes.readUInt16LE(base + 2),
      flags: batch.bytes.readUInt32LE(base + 4),
    }
  }

  it('tracks what is down and releases it', () => {
    adapter.keyDown(KEY_W)
    adapter.mouseDown(MOUSE_LEFT)
    expect(adapter.getHeldKeyIds()).toEqual(['key-w'])
    expect(adapter.getHeldButtonIds()).toEqual(['left'])

    const result = adapter.releaseAll()
    expect(result).toEqual({ released: 2, error: null })
    expect(adapter.getHeldKeyIds()).toEqual([])
    expect(adapter.getHeldButtonIds()).toEqual([])
  })

  it('batches every outstanding up into ONE SendInput call', () => {
    adapter.keyDown(SHIFT_LEFT)
    adapter.keyDown(KEY_W)
    adapter.keyDown(KEY_A)
    adapter.mouseDown(MOUSE_LEFT)
    adapter.mouseDown(MOUSE_FORWARD)
    batches.length = 0

    adapter.releaseAll()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.count).toBe(5)
  })

  it('orders the batch mouse first, keys in reverse press order, modifiers last', () => {
    adapter.keyDown(SHIFT_LEFT) // modifier, pressed first
    adapter.keyDown(KEY_W)
    adapter.keyDown(KEY_A)
    adapter.mouseDown(MOUSE_LEFT)
    batches.length = 0

    adapter.releaseAll()
    const batch = batches[0]
    expect(batch).toBeDefined()
    if (!batch) return
    expect(recordAt(batch, 0).type).toBe(0) // mouse up
    expect(recordAt(batch, 1).wScan).toBe(0x1e) // KeyA, pressed last, released first
    expect(recordAt(batch, 2).wScan).toBe(0x11) // KeyW
    expect(recordAt(batch, 3).wScan).toBe(0x2a) // Shift, the modifier, last
    // Every keyboard record must carry KEYUP.
    for (const i of [1, 2, 3]) {
      expect(recordAt(batch, i).flags & KEYEVENTF.KEYUP).toBe(KEYEVENTF.KEYUP)
    }
  })

  it('is idempotent, so every exit path can call it', () => {
    adapter.keyDown(KEY_W)
    adapter.releaseAll()
    batches.length = 0
    expect(adapter.releaseAll()).toEqual({ released: 0, error: null })
    expect(batches).toHaveLength(0)
  })

  it('never throws, and clears held state even when the send fails', () => {
    adapter.keyDown(KEY_W)
    adapter.keyDown(ARROW_UP)
    failNext = true
    const result = adapter.releaseAll()
    expect(result.released).toBe(0)
    expect(result.error).toMatch(/simulated/)
    // Cleared in a finally: a set we would keep re-releasing is worse than an empty one.
    expect(adapter.getHeldKeyIds()).toEqual([])
  })

  it('records a key as held before the send, so a failed press is still released', () => {
    failNext = true
    expect(() => adapter.keyDown(KEY_W)).toThrow(/simulated/)
    expect(adapter.getHeldKeyIds()).toEqual(['key-w'])

    failNext = false
    expect(adapter.releaseAll()).toEqual({ released: 1, error: null })
  })

  it('releases a key with the encoding it was pressed with, not the current setting', () => {
    adapter.keyDown(ARROW_UP) // scan-code path
    adapter.setUseVirtualKeys(true) // the user flips the fallback mid-session
    batches.length = 0

    adapter.releaseAll()
    const batch = batches[0]
    expect(batch).toBeDefined()
    if (!batch) return
    const record = recordAt(batch, 0)
    expect(record.flags & KEYEVENTF.SCANCODE).toBe(KEYEVENTF.SCANCODE)
    expect(record.wScan).toBe(0x48)
  })

  it('sends the wheel but never tracks it as held', () => {
    adapter.mouseDown(WHEEL_DOWN)
    expect(batches).toHaveLength(1)
    expect(adapter.getHeldButtonIds()).toEqual([])
    expect(adapter.releaseAll()).toEqual({ released: 0, error: null })
    adapter.mouseUp(WHEEL_DOWN) // a no-op, not an error
    expect(batches).toHaveLength(1)
  })

  it('forgets a key on keyUp even when the up fails', () => {
    adapter.keyDown(KEY_W)
    failNext = true
    expect(() => adapter.keyUp(KEY_W)).toThrow(/simulated/)
    expect(adapter.getHeldKeyIds()).toEqual([])
  })

  it('applies settings without disturbing what is already down', () => {
    adapter.keyDown(KEY_W)
    adapter.applySettings({
      theme: 'system',
      panicHotkey: 'CommandOrControl+Alt+Shift+K',
      maxSessionMinutes: 30,
      autoCheckUpdates: true,
      windowsUseVirtualKeys: true,
    })
    expect(adapter.getHeldKeyIds()).toEqual(['key-w'])
    expect(adapter.getDiagnostics().useVirtualKeys).toBe(true)
    expect(encodeKey(KEY_A, true).mode).toBe('virtual-key')
  })

  it('dispose() releases whatever is down and is safe to repeat', () => {
    adapter.keyDown(KEY_W)
    batches.length = 0
    adapter.dispose()
    expect(batches).toHaveLength(1)
    expect(() => adapter.dispose()).not.toThrow()
    expect(batches).toHaveLength(1)
  })
})

describe('the locked NativeInput seam', () => {
  it('satisfies the contract, and the optional extras all-or-nothing', () => {
    // The `implements` clause is the real check; this asserts the runtime half, which is
    // what `hasNativeInputExtras()` actually probes at startup.
    const adapter: NativeInput = createWindowsNativeInput()
    expect(hasNativeInputExtras(adapter)).toBe(true)
  })
})

describe('the extras', () => {
  let adapter: ReturnType<typeof createWindowsNativeInput>
  let batches: SentBatch[]

  beforeEach(() => {
    adapter = createWindowsNativeInput()
    batches = []
    __test.installFakeSender((buf, count) => {
      batches.push({ count, bytes: Buffer.from(buf.subarray(0, count * __test.INPUT_SIZE)) })
      return count
    })
  })

  afterEach(() => {
    __test.installFakeSender(null)
  })

  it('keyDownRepeat re-sends the key-down and never an intermediate key-up', () => {
    adapter.keyDown(KEY_W)
    batches.length = 0
    adapter.keyDownRepeat(KEY_W)
    expect(batches).toHaveLength(1)
    const batch = batches[0]
    expect(batch).toBeDefined()
    if (!batch) return
    const flags = batch.bytes.readUInt32LE(__test.UNION_OFF + 4)
    expect(flags & KEYEVENTF.KEYUP).toBe(0)
    expect(flags & KEYEVENTF.SCANCODE).toBe(KEYEVENTF.SCANCODE)
    expect(adapter.getHeldKeyIds()).toEqual(['key-w'])
  })

  it('keyDownRepeat reuses the encoding the key was pressed with', () => {
    adapter.keyDown(ARROW_UP)
    adapter.setUseVirtualKeys(true)
    batches.length = 0
    adapter.keyDownRepeat(ARROW_UP)
    const batch = batches[0]
    expect(batch).toBeDefined()
    if (!batch) return
    expect(batch.bytes.readUInt32LE(__test.UNION_OFF + 4) & KEYEVENTF.SCANCODE).toBe(
      KEYEVENTF.SCANCODE,
    )
  })

  it('keyDownRepeat starts tracking a key it was handed cold', () => {
    adapter.keyDownRepeat(KEY_A)
    expect(adapter.getHeldKeyIds()).toEqual(['key-a'])
  })

  it('keyUpToPid sends nothing, so focus loss cannot double-release', () => {
    adapter.keyDown(KEY_W)
    batches.length = 0
    adapter.keyUpToPid(KEY_W, 1234)
    expect(batches).toHaveLength(0)
    // The global keyUp still does the work.
    adapter.keyUp(KEY_W)
    expect(batches).toHaveLength(1)
    expect(adapter.getHeldKeyIds()).toEqual([])
  })

  it('physicalModifiersClear needs the FFI and says so rather than guessing', () => {
    // On a host with no user32 there is no honest answer, so it throws instead of
    // returning a confident `true` that would let the first press land into a held Alt.
    expect(() => adapter.physicalModifiersClear()).toThrow()
  })
})

// ---------------------------------------------------------------------------------
// Behaviour on a host that is not Windows.
// ---------------------------------------------------------------------------------

describe('loading on a non-Windows host', () => {
  it('reports the platform honestly', () => {
    expect(isWindows).toBe(process.platform === 'win32')
  })

  it('imports without side effects: nothing is bound and nothing has failed yet', () => {
    // Reaching this line at all is the assertion: an import-time throw would have failed
    // the whole file before any test ran.
    const fresh = createWindowsNativeInput()
    expect(fresh.initError).toBeNull()
    expect(fresh.ready).toBe(false)
    expect(fresh.getDiagnostics().initialised).toBe(false)
  })

  it('parks the init failure in initError instead of throwing at import', async () => {
    const fresh = createWindowsNativeInput()
    await expect(fresh.init()).rejects.toThrow(/Windows input adapter was loaded on/)
    expect(fresh.initError).toBeInstanceOf(Error)
    expect(fresh.ready).toBe(false)
    const diagnostics = fresh.getDiagnostics()
    expect(diagnostics.initialised).toBe(false)
    expect(diagnostics.initError).toMatch(/Windows/)
    // The same failure comes back on a second call rather than being retried forever.
    await expect(fresh.init()).rejects.toBe(fresh.initError)
  })

  it('throws on injection rather than silently doing nothing', () => {
    const fresh = createWindowsNativeInput()
    expect(() => fresh.keyDown(KEY_W)).toThrow(/Windows/)
    // The key was still recorded, so releaseAll can report the intent.
    expect(fresh.getHeldKeyIds()).toEqual(['key-w'])
    const result = fresh.releaseAll()
    expect(result.released).toBe(0)
    expect(result.error).toMatch(/Windows/)
    expect(fresh.getHeldKeyIds()).toEqual([])
  })

  it('throws on the enumeration and focus calls too', () => {
    const fresh = createWindowsNativeInput()
    expect(() => fresh.getFrontmostPid()).toThrow()
    expect(() => fresh.listApplications()).toThrow()
    expect(() => fresh.describeForegroundBlocking()).toThrow()
  })

  it('answers the permission questions without any FFI at all', () => {
    const fresh = createWindowsNativeInput()
    expect(fresh.hasPermission()).toBe(true)
    expect(() => fresh.openPermissionSettings()).not.toThrow()
  })

  it('makes the timer-resolution calls no-ops when winmm is not bound', () => {
    expect(timeBeginPeriod(1)).toBeNull()
    expect(timeEndPeriod(1)).toBeNull()
    expect(windowsNative.getTimerPeriodDepth()).toBe(0)
  })

  it('reports diagnostics on the shared adapter without throwing', () => {
    const diagnostics = windowsNative.getDiagnostics()
    expect(diagnostics.platform).toBe(process.platform)
    expect(diagnostics.expectedLayout).toEqual(expectedInputLayout())
    expect(diagnostics.recordConstants.INPUT_SIZE).toBe(__test.INPUT_SIZE)
    expect(diagnostics.winmmAvailable).toBe(false)
  })
})

describe('handles', () => {
  it('treats null, undefined and zero as the null handle', () => {
    expect(isNullHandle(null)).toBe(true)
    expect(isNullHandle(undefined)).toBe(true)
    expect(isNullHandle(0)).toBe(true)
    expect(isNullHandle(0n)).toBe(true)
  })

  it('normalises numbers and BigInts to the same address', () => {
    expect(handleAddress(0x1234)).toBe(0x1234n)
    expect(handleAddress(0x1234n)).toBe(0x1234n)
    expect(isNullHandle(0x1234n)).toBe(false)
  })

  it('does not throw on a value it cannot address', () => {
    expect(handleAddress(Number.NaN)).toBe(0n)
    expect(handleAddress({})).toBe(0n)
  })
})

describe('SendInput failure messages', () => {
  it('names the UIPI-adjacent case when access is denied', () => {
    expect(__test.describeSendInputError(0, 5)).toMatch(/administrator/)
  })

  it('names BlockInput when zero events went in with no error', () => {
    expect(__test.describeSendInputError(0, 0)).toMatch(/blocked by another thread/)
  })

  it('does not pretend to know an unexpected error', () => {
    expect(__test.describeSendInputError(0, 1234)).toMatch(/Unexpected Win32 error 1234/)
  })
})

describe('identity and naming', () => {
  it('uses the lowercased image path as the stable identity', () => {
    expect(__test.identityFor('C:\\Program Files\\Rust\\Rust.exe', 42)).toBe(
      'c:\\program files\\rust\\rust.exe',
    )
  })

  it('falls back to the pid when the path cannot be read', () => {
    expect(__test.identityFor(null, 42)).toBe('pid:42')
  })

  it('names an app after its executable, falling back to the window title', () => {
    expect(__test.basename('C:\\Games\\Rust\\Rust.exe')).toBe('Rust.exe')
    expect(__test.prettyName('Rust.exe', 'Rust - Facepunch')).toBe('Rust')
    expect(__test.prettyName(null, 'Some Window')).toBe('Some Window')
    expect(__test.prettyName(null, '')).toBe('Unknown')
  })
})
