/**
 * KeyPress Ultimate — Windows native input adapter (koffi FFI, no node-gyp).
 *
 * This file and `macos.ts` are the only two files in the app allowed to call koffi.
 * Every line here was written from Microsoft Learn and the koffi 3.2.1 source on a Mac.
 * It has never executed on Windows. `docs/windows-testing-checklist.md` lists, risk by
 * risk, what a human on a real machine still has to confirm. Because of that, the rule
 * throughout is: be exhaustively explicit, and make every failure loud.
 *
 * The five decisions that shape the whole file:
 *
 * 1. INPUT records are written BYTE BY BYTE into a preallocated Buffer. koffi's
 *    struct/union marshaller is never used to send input. A union has no "active arm"
 *    that koffi can know about (`koffi.decode()` of one returns `{}`), the hot path
 *    would allocate, and a silent marshalling change would corrupt input rather than
 *    fail. koffi's struct declarations are still built at init and used only to ASSERT
 *    the offsets hardcoded here.
 *
 * 2. `init()` asserts sizeof/offsetof against per-arch constants and refuses to run on
 *    a mismatch. See `assertStructLayout`.
 *
 * 3. Keys are injected as SCAN CODES (`KEYEVENTF_SCANCODE`, `wVk = 0`), with
 *    `KEYEVENTF_EXTENDEDKEY` for the 0xE0-prefixed keys. That is the documented way to
 *    "simulate a physical keystroke regardless of which keyboard is currently being
 *    used", and it is what DirectInput / Raw Input games read. A virtual-key path
 *    exists behind `Settings.windowsUseVirtualKeys` for titles that ignore scancodes.
 *
 * 4. Explicit integer widths on every declaration. Win32 `LONG` is `int32`, `LPARAM` is
 *    `intptr`, `ULONG_PTR` is `uintptr`, `DWORD` is `uint32`, `WORD` is `uint16`, and
 *    `BOOL` is `'int'` (four bytes). koffi's `'long'` is 64-bit on LP64 hosts and koffi's
 *    `'bool'` is one byte, so neither is ever used. koffi's own documentation example
 *    for `EnumWindowsProc` uses `long lParam`, which is wrong for Win64.
 *
 * 5. `SendInput`'s return value is never treated as proof that anything happened.
 *    Microsoft, verbatim: "This function fails when it is blocked by UIPI. Note that
 *    neither GetLastError nor the return value will indicate the failure was caused by
 *    UIPI blocking." `describeForegroundBlocking()` exists so the UI can say
 *    "Rust is running as administrator, restart KeyPress Ultimate as administrator"
 *    instead of lying about keys being held.
 *
 * Importing this module has no side effects beyond building a few frozen tables. It is
 * safe to import on macOS: binding failures are parked in `initError` rather than thrown
 * at import, so a mis-selected adapter shows a real error instead of a white screen.
 */

import koffi from 'koffi'
import type { AppInfo, KeyDef, MouseButtonId, MouseDef, Settings } from '../../shared/types'
import type { NativeInput, NativeInputExtras } from './types'

// =====================================================================================
// SECTION 0 — Win32 constants
// =====================================================================================
// Exported as frozen groups rather than loose consts so that the documented-but-unused
// members survive `noUnusedLocals` and stay readable next to the ones we call.

/** `INPUT.type` (ns-winuser-input). */
export const INPUT_TYPE = Object.freeze({ MOUSE: 0, KEYBOARD: 1, HARDWARE: 2 })

/** `KEYBDINPUT.dwFlags` (ns-winuser-keybdinput). */
export const KEYEVENTF = Object.freeze({
  EXTENDEDKEY: 0x0001, // wScan is the low byte of a 0xE0-prefixed two-byte sequence
  KEYUP: 0x0002,
  UNICODE: 0x0004, // unused: we inject keys, not text
  SCANCODE: 0x0008, // wScan identifies the key and wVk is ignored
})

/** `MOUSEINPUT.dwFlags` (ns-winuser-mouseinput). */
export const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  XDOWN: 0x0080,
  XUP: 0x0100,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
  MOVE_NOCOALESCE: 0x2000,
  VIRTUALDESK: 0x4000,
  ABSOLUTE: 0x8000,
})

/** `MOUSEINPUT.mouseData` when `dwFlags` carries XDOWN/XUP, and one wheel detent. */
export const MOUSEDATA = Object.freeze({ XBUTTON1: 0x0001, XBUTTON2: 0x0002, WHEEL_DELTA: 120 })

/** `MapVirtualKeyW` uMapType (nf-winuser-mapvirtualkeyw). */
export const MAPVK = Object.freeze({
  VK_TO_VSC: 0,
  VSC_TO_VK: 1,
  VK_TO_CHAR: 2,
  VSC_TO_VK_EX: 3,
  /** Vista+: the high byte of the result is 0xE0/0xE1 for extended keys. */
  VK_TO_VSC_EX: 4,
})

/** `GetWindow` uCmd (nf-winuser-getwindow). */
export const GW = Object.freeze({
  HWNDFIRST: 0,
  HWNDLAST: 1,
  HWNDNEXT: 2,
  HWNDPREV: 3,
  OWNER: 4,
  CHILD: 5,
  ENABLEDPOPUP: 6,
})

/** `GetAncestor` gaFlags (winuser.h). */
export const GA = Object.freeze({ PARENT: 1, ROOT: 2, ROOTOWNER: 3 })

/** `GetWindowLongPtrW` nIndex (nf-winuser-getwindowlongptrw). */
export const GWL = Object.freeze({ STYLE: -16, EXSTYLE: -20 })

/** Extended window styles (winmsg/extended-window-styles). */
export const WS_EX = Object.freeze({
  TRANSPARENT: 0x00000020,
  TOOLWINDOW: 0x00000080,
  APPWINDOW: 0x00040000,
  LAYERED: 0x00080000,
  NOACTIVATE: 0x08000000,
})

/**
 * DWM window attributes (ne-dwmapi-dwmwindowattribute).
 *
 * The enum in the docs reads as if it were 0-based, but Learn states "IMPORTANT. The
 * value of DWMWA_NCRENDERING_ENABLED is 1", which shifts every member by one. Counting
 * from 1 gives DWMWA_CLOAKED = 14, which is the value every real implementation uses.
 */
export const DWM = Object.freeze({
  WA_CLOAKED: 14,
  CLOAKED_APP: 0x00000001, // cloaked by its owner application
  CLOAKED_SHELL: 0x00000002, // cloaked by the shell (suspended UWP "ghosts")
  CLOAKED_INHERITED: 0x00000004, // inherited from the owner window
})

/** `HRESULT` success. */
export const S_OK = 0

/** Process access rights (procthread/process-security-and-access-rights). */
export const PROCESS_ACCESS = Object.freeze({
  QUERY_INFORMATION: 0x0400,
  /** Deliberately weaker: documented to work across integrity levels. */
  QUERY_LIMITED_INFORMATION: 0x1000,
  VM_READ: 0x0010,
  SYNCHRONIZE: 0x00100000,
})

/** `QueryFullProcessImageNameW` dwFlags (winbase.h). */
export const PROCESS_NAME = Object.freeze({ WIN32: 0x00000000, NATIVE: 0x00000001 })

/**
 * Token access rights and information classes (winnt.h).
 *
 * `TOKEN_QUERY` is not given numerically on Learn; winnt.h defines it as 0x0008.
 * `TOKEN_INFORMATION_CLASS` starts at `TokenUser = 1`; counting the members in order
 * gives `TokenElevation = 20`. Both are flagged for confirmation in R-05.
 */
export const TOKEN = Object.freeze({
  QUERY: 0x0008,
  InfoElevationType: 18,
  InfoElevation: 20,
  InfoIntegrityLevel: 25,
  InfoUIAccess: 26,
  ElevationTypeDefault: 1,
  ElevationTypeFull: 2,
  ElevationTypeLimited: 3,
})

/** Win32 error codes this file actually branches on. */
export const WIN32_ERROR = Object.freeze({
  SUCCESS: 0,
  ACCESS_DENIED: 5,
  INVALID_PARAMETER: 87,
  INSUFFICIENT_BUFFER: 122,
  NOACCESS: 998,
})

/** `timeBeginPeriod` / `timeEndPeriod` results (mmsystem.h). */
export const TIMERR = Object.freeze({ NOERROR: 0, NOCANDO: 97 })

/**
 * The virtual keys the focus-gain gate asks about, plus the probe key.
 *
 * SHIFT / CONTROL / MENU are the "either side" aggregates, which is what we want: the
 * gate cares whether any modifier is physically down, not which one.
 */
export const VK = Object.freeze({
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12, // Alt
  LWIN: 0x5b,
  RWIN: 0x5c,
  SCROLL: 0x91,
})

/**
 * Stamped into `dwExtraInfo` on every record we generate so a debugging session (or a
 * future feature) can recognise our own events through `GetMessageExtraInfo()` or
 * `KBDLLHOOKSTRUCT.dwExtraInfo`. 0x4B505500 is 'K','P','U',NUL. Must be non-zero.
 */
export const KPU_EXTRA_INFO = 0x4b505500

/** The calling convention token. Mandatory on Win32 x86, harmless elsewhere. */
const STDCALL = '__stdcall'

export const isWindows = process.platform === 'win32'

// =====================================================================================
// SECTION 1 — struct layout: expected, measured, asserted
// =====================================================================================

export interface InputLayout {
  sizeofINPUT: number
  unionOffset: number
  sizeofKEYBDINPUT: number
  sizeofMOUSEINPUT: number
  sizeofHARDWAREINPUT: number
  /** Offset of `dwExtraInfo` **within KEYBDINPUT**, not within INPUT. */
  kiExtraInfoOffset: number
  /** Offset of `dwExtraInfo` **within MOUSEINPUT**, not within INPUT. */
  miExtraInfoOffset: number
  pointerSize: number
}

/**
 * The layout we hardcode, per pointer width.
 *
 * 64-bit (x64 and arm64, both LLP64 on Windows): `INPUT.type` is a DWORD at 0, the union
 * is 8-aligned because MOUSEINPUT/KEYBDINPUT end in a ULONG_PTR, so the compiler inserts
 * a four-byte hole and `sizeof(INPUT)` is 40, not 36. That hole is the single most common
 * FFI bug in this API.
 *
 * 32-bit (ia32): pointers are four bytes, the hole disappears, and INPUT is 28.
 *
 * Both tables were measured with koffi on darwin-arm64, which applies the same alignment
 * rules as Windows for these member types (RISKS V-1).
 */
export const INPUT_LAYOUT_64: InputLayout = Object.freeze({
  sizeofINPUT: 40,
  unionOffset: 8,
  sizeofKEYBDINPUT: 24,
  sizeofMOUSEINPUT: 32,
  sizeofHARDWAREINPUT: 8,
  kiExtraInfoOffset: 16,
  miExtraInfoOffset: 24,
  pointerSize: 8,
})

export const INPUT_LAYOUT_32: InputLayout = Object.freeze({
  sizeofINPUT: 28,
  unionOffset: 4,
  sizeofKEYBDINPUT: 16,
  sizeofMOUSEINPUT: 24,
  sizeofHARDWAREINPUT: 8,
  kiExtraInfoOffset: 12,
  miExtraInfoOffset: 20,
  pointerSize: 4,
})

/** Windows x86 is the only 32-bit target we could ship; everything else is LLP64. */
export function is32BitArch(arch: string = process.arch): boolean {
  return arch === 'ia32' || arch === 'arm'
}

export function expectedInputLayout(arch: string = process.arch): InputLayout {
  return is32BitArch(arch) ? INPUT_LAYOUT_32 : INPUT_LAYOUT_64
}

/**
 * Declare the structs through koffi and read back what koffi thinks their layout is.
 *
 * These declarations exist ONLY to be measured. Nothing is ever marshalled through them.
 * They are anonymous so that importing this module twice in one process (Electron main
 * plus a test harness) cannot collide on a registered type name.
 *
 * Safe to call on any platform: it touches no DLL. `arch` selects the ULONG_PTR width to
 * declare, so the 32-bit layout can be measured from a 64-bit host; note that
 * `pointerSize` always reports the HOST's `void *`, because on the real target that is
 * the value that has to agree with the rest of the table.
 */
export function probeStructLayout(arch: string = process.arch): InputLayout {
  // ULONG_PTR is spelled with an explicit width rather than koffi's 'uintptr' for two
  // reasons: it lets the 32-bit layout be measured from a 64-bit host, which is how these
  // numbers were verified at all, and the declaration then says what it means no matter
  // which machine reads it. `bindWin32` separately asserts that koffi's 'uintptr' and
  // 'intptr' really are the host pointer width, because 'intptr' IS used on the wire for
  // LPARAM.
  const ULONG_PTR = is32BitArch(arch) ? 'uint32' : 'uint64'
  const MOUSEINPUT = koffi.struct({
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: ULONG_PTR,
  })
  const KEYBDINPUT = koffi.struct({
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: ULONG_PTR,
  })
  const HARDWAREINPUT = koffi.struct({ uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
  const INPUT_UNION = koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
  const INPUT = koffi.struct({ type: 'uint32', u: INPUT_UNION })

  return {
    sizeofINPUT: koffi.sizeof(INPUT),
    unionOffset: koffi.offsetof(INPUT, 'u'),
    sizeofKEYBDINPUT: koffi.sizeof(KEYBDINPUT),
    sizeofMOUSEINPUT: koffi.sizeof(MOUSEINPUT),
    sizeofHARDWAREINPUT: koffi.sizeof(HARDWAREINPUT),
    kiExtraInfoOffset: koffi.offsetof(KEYBDINPUT, 'dwExtraInfo'),
    miExtraInfoOffset: koffi.offsetof(MOUSEINPUT, 'dwExtraInfo'),
    pointerSize: koffi.sizeof('void *'),
  }
}

/** The exact sentence the plan requires on a layout mismatch. Asserted by the tests. */
export const LAYOUT_REFUSAL = 'Refusing to inject input with an unknown struct layout'

/**
 * Compare a measured layout against the expected one and throw on any difference.
 *
 * A mismatch means either koffi changed how it lays out records or we are on an ABI
 * nobody anticipated. Either way the byte offsets below are wrong, and writing wrong
 * bytes into `SendInput` is how you get a stuck key in someone's game. Refuse.
 */
export function assertStructLayout(measured: InputLayout, arch: string = process.arch): void {
  const expected = expectedInputLayout(arch)
  const mismatches: string[] = []
  for (const field of Object.keys(expected) as (keyof InputLayout)[]) {
    if (measured[field] !== expected[field]) {
      mismatches.push(`${field} is ${measured[field]}, expected ${expected[field]}`)
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `INPUT ABI mismatch on ${arch}: ${mismatches.join('; ')}. ${LAYOUT_REFUSAL}.`,
    )
  }
}

// =====================================================================================
// SECTION 2 — the hand-written INPUT records
// =====================================================================================

const LAYOUT = expectedInputLayout()
const INPUT_SIZE = LAYOUT.sizeofINPUT
const UNION_OFF = LAYOUT.unionOffset
const KI_EXTRA = LAYOUT.kiExtraInfoOffset
const MI_EXTRA = LAYOUT.miExtraInfoOffset
const WRITE_EXTRA_AS_64 = LAYOUT.pointerSize === 8

/**
 * The one scratch buffer every record is written into. Preallocated for eight records,
 * which covers every batch the app produces in practice; `slotsFor` grows it if a
 * `releaseAll()` ever needs more. A Buffer handed to koffi for a `void *` parameter is
 * valid for the duration of that call, which is exactly the lifetime `SendInput` needs.
 */
let inputBuf: Buffer = Buffer.alloc(INPUT_SIZE * 8)

/** Zero and return the shared buffer, grown if `n` records will not fit. */
export function slotsFor(n: number): Buffer {
  const bytes = INPUT_SIZE * n
  if (inputBuf.length < bytes) inputBuf = Buffer.alloc(bytes)
  inputBuf.fill(0, 0, bytes)
  return inputBuf
}

function toU32(value: number): number {
  return value >>> 0
}

function writeExtraInfo(buf: Buffer, offset: number): void {
  if (WRITE_EXTRA_AS_64) buf.writeBigUInt64LE(BigInt(KPU_EXTRA_INFO), offset)
  else buf.writeUInt32LE(KPU_EXTRA_INFO, offset)
}

export interface KeyRecordFields {
  wVk?: number
  wScan?: number
  dwFlags?: number
}

/**
 * Write one keyboard INPUT record at record index `i`.
 *
 * x64 offsets, relative to the start of the record:
 *    0  DWORD      type = INPUT_KEYBOARD (1)
 *    4  (four bytes of alignment padding, must stay zero)
 *    8  WORD       ki.wVk
 *   10  WORD       ki.wScan
 *   12  DWORD      ki.dwFlags
 *   16  DWORD      ki.time          (0 lets the system timestamp it)
 *   20  (four bytes of padding)
 *   24  ULONG_PTR  ki.dwExtraInfo
 *   32  (eight bytes of union tail padding; MOUSEINPUT is the larger arm)
 *
 * The caller is responsible for the flags. `slotsFor` has already zeroed the padding.
 */
export function writeKeyRecord(buf: Buffer, i: number, fields: KeyRecordFields): void {
  const base = i * INPUT_SIZE
  const u = base + UNION_OFF
  buf.writeUInt32LE(INPUT_TYPE.KEYBOARD, base)
  buf.writeUInt16LE((fields.wVk ?? 0) & 0xffff, u + 0)
  buf.writeUInt16LE((fields.wScan ?? 0) & 0xffff, u + 2)
  buf.writeUInt32LE(toU32(fields.dwFlags ?? 0), u + 4)
  buf.writeUInt32LE(0, u + 8) // time
  writeExtraInfo(buf, u + KI_EXTRA)
}

export interface MouseRecordFields {
  dwFlags?: number
  /** Signed for the wheel (-120 is one detent toward the user), a mask for XDOWN/XUP. */
  mouseData?: number
  dx?: number
  dy?: number
}

/**
 * Write one mouse INPUT record at record index `i`.
 *
 * For a button press there is no movement: dx and dy stay 0 and MOUSEEVENTF_MOVE is not
 * set, so the fields are ignored entirely and the cursor does not twitch. `mouseData` is
 * zero except for XDOWN/XUP (XBUTTON1/XBUTTON2) and the wheel, per the docs: "If dwFlags
 * does not contain MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, or MOUSEEVENTF_XUP, then
 * mouseData should be zero."
 */
export function writeMouseRecord(buf: Buffer, i: number, fields: MouseRecordFields): void {
  const base = i * INPUT_SIZE
  const u = base + UNION_OFF
  buf.writeUInt32LE(INPUT_TYPE.MOUSE, base)
  buf.writeInt32LE((fields.dx ?? 0) | 0, u + 0)
  buf.writeInt32LE((fields.dy ?? 0) | 0, u + 4)
  buf.writeUInt32LE(toU32(fields.mouseData ?? 0), u + 8)
  buf.writeUInt32LE(toU32(fields.dwFlags ?? 0), u + 12)
  buf.writeUInt32LE(0, u + 16) // time
  writeExtraInfo(buf, u + MI_EXTRA)
}

// =====================================================================================
// SECTION 3 — key and button encoding
// =====================================================================================

export interface ScanEncoding {
  /** The byte that goes in `wScan`. Always a single byte. */
  wScan: number
  /** Whether `KEYEVENTF_EXTENDEDKEY` must be set. */
  extended: boolean
  /** The 0xE0 / 0xE1 prefix the raw table value carried, or 0. Diagnostic only. */
  prefix: number
}

/**
 * Split a scan-code table value into (byte, extended flag).
 *
 * `SendInput` does not take the 0xE0 byte in `wScan`. It takes the LOW byte plus
 * `KEYEVENTF_EXTENDEDKEY`, which is what tells the system to reconstruct the two-byte
 * 0xE0-prefixed sequence. `data/keys.json` already stores the low byte plus a separate
 * `winExtended` flag, so `extendedHint` is normally the whole answer. The 0xE0xx branch
 * is defensive: if the data ever drifts back to storing prefixed values, we still emit
 * the right record instead of injecting 0xE0 as if it were a key.
 *
 * 0xE1 (only the Pause key, which physically emits 0xE1 0x1D 0x45) cannot be expressed
 * in one INPUT record at all. We send the bare 0x45 and do NOT set the extended flag,
 * matching Chromium. R-04 asks the tester whether anything receives it.
 */
export function encodeScan(raw: number, extendedHint = false): ScanEncoding {
  const value = raw >>> 0
  if (value > 0xff) {
    const prefix = (value >> 8) & 0xff
    return { wScan: value & 0xff, extended: extendedHint || prefix === 0xe0, prefix }
  }
  return { wScan: value & 0xff, extended: extendedHint, prefix: 0 }
}

export type KeyEncodingMode = 'scancode' | 'virtual-key'

export interface KeyEncoding {
  mode: KeyEncodingMode
  wVk: number
  wScan: number
  extended: boolean
  /** Flags for the key-down record. The key-up record adds `KEYEVENTF.KEYUP`. */
  downFlags: number
  upFlags: number
}

/**
 * Turn a `KeyDef` into the exact record fields to write.
 *
 * Scan codes are the default and the thing games want. The virtual-key path is the
 * documented fallback for titles that ignore injected scancodes; it is reached only when
 * `Settings.windowsUseVirtualKeys` is on, or when the key has no scan code at all.
 *
 * Throws, loudly and by key id, when neither code exists. `key-fn` is the one key in
 * `data/keys.json` with `winScanCode: null` and it is macOS-only, so reaching this on
 * Windows means the UI offered a key it should have drawn as unavailable.
 */
export function encodeKey(key: KeyDef, useVirtualKeys = false): KeyEncoding {
  const hasScan = key.winScanCode !== null && key.winScanCode !== 0
  const hasVk = key.winVirtualKey !== null && key.winVirtualKey !== 0

  if (useVirtualKeys && hasVk) {
    const extended = key.winExtended
    const base = extended ? KEYEVENTF.EXTENDEDKEY : 0
    return {
      mode: 'virtual-key',
      wVk: (key.winVirtualKey ?? 0) & 0xffff,
      // wScan is ignored when neither SCANCODE nor UNICODE is set, but filling it in
      // costs nothing and keeps the record self-describing in a debugger.
      wScan: hasScan ? encodeScan(key.winScanCode ?? 0, extended).wScan : 0,
      extended,
      downFlags: base,
      upFlags: base | KEYEVENTF.KEYUP,
    }
  }

  if (hasScan) {
    const sc = encodeScan(key.winScanCode ?? 0, key.winExtended)
    const base = KEYEVENTF.SCANCODE | (sc.extended ? KEYEVENTF.EXTENDEDKEY : 0)
    return {
      mode: 'scancode',
      wVk: 0, // ignored when KEYEVENTF_SCANCODE is set, and explicitly zeroed
      wScan: sc.wScan,
      extended: sc.extended,
      downFlags: base,
      upFlags: base | KEYEVENTF.KEYUP,
    }
  }

  if (hasVk) {
    const extended = key.winExtended
    const base = extended ? KEYEVENTF.EXTENDEDKEY : 0
    return {
      mode: 'virtual-key',
      wVk: (key.winVirtualKey ?? 0) & 0xffff,
      wScan: 0,
      extended,
      downFlags: base,
      upFlags: base | KEYEVENTF.KEYUP,
    }
  }

  throw new Error(
    `Key "${key.id}" (${key.label}) has neither a Windows scan code nor a virtual-key ` +
      `code, so it cannot be injected on Windows. It should be drawn as unavailable.`,
  )
}

export interface MouseEncoding {
  dwFlags: number
  mouseData: number
}

/** Down (or, for the wheel, the single discrete event). Throws if the button has none. */
export function encodeMouseDown(button: MouseDef): MouseEncoding {
  if (button.winFlagDown === null) {
    throw new Error(`Mouse button "${button.id}" has no Windows down flag, so it cannot be sent.`)
  }
  return { dwFlags: toU32(button.winFlagDown), mouseData: button.winMouseData }
}

/**
 * Up, or `null` for a button that has no up event.
 *
 * The wheel is the only such case: it emits discrete detents and has no held state, so
 * there is nothing to release. Returning `null` (rather than throwing) is what keeps the
 * wheel out of `releaseAll()`'s batch instead of poisoning it.
 */
export function encodeMouseUp(button: MouseDef): MouseEncoding | null {
  if (button.winFlagUp === null) return null
  return { dwFlags: toU32(button.winFlagUp), mouseData: button.winMouseData }
}

// =====================================================================================
// SECTION 4 — FFI bindings
// =====================================================================================

/**
 * A Win32 HANDLE / HWND as it crosses koffi. koffi 3.x hands pointers back as BigInt,
 * but the type stays wide so a future representation cannot silently become `never`
 * compared or `NaN` converted. Use `handleAddress` for every comparison.
 */
export type Win32Handle = bigint | number | object | null | undefined

/** A one-element array is koffi's documented way to receive a scalar out-parameter. */
type OutNumber = [number]
type OutHandle = [Win32Handle]

interface Win32Bindings {
  layout: InputLayout
  SendInput: (cInputs: number, pInputs: Buffer, cbSize: number) => number
  MapVirtualKeyW: (uCode: number, uMapType: number) => number
  GetAsyncKeyState: (vKey: number) => number
  GetForegroundWindow: () => Win32Handle
  GetWindowThreadProcessId: (hWnd: Win32Handle, out: OutNumber) => number
  EnumWindows: (proc: EnumWindowsProc, lParam: number) => number
  IsWindowVisible: (hWnd: Win32Handle) => number
  IsIconic: (hWnd: Win32Handle) => number
  GetWindowTextW: (hWnd: Win32Handle, buf: Buffer, maxCount: number) => number
  GetWindowTextLengthW: (hWnd: Win32Handle) => number
  GetWindow: (hWnd: Win32Handle, uCmd: number) => Win32Handle
  GetAncestor: (hWnd: Win32Handle, gaFlags: number) => Win32Handle
  GetLastActivePopup: (hWnd: Win32Handle) => Win32Handle
  GetWindowLongPtrW: (hWnd: Win32Handle, nIndex: number) => number | bigint
  GetLastError: () => number
  SetLastError: (code: number) => void
  OpenProcess: (access: number, inherit: number, pid: number) => Win32Handle
  CloseHandle: (handle: Win32Handle) => number
  QueryFullProcessImageNameW: (
    handle: Win32Handle,
    flags: number,
    buf: Buffer,
    size: OutNumber,
  ) => number
  GetCurrentProcess: () => Win32Handle
  DwmGetWindowAttribute: (
    hWnd: Win32Handle,
    attribute: number,
    buf: Buffer,
    cb: number,
  ) => number
  OpenProcessToken: (handle: Win32Handle, access: number, out: OutHandle) => number
  GetTokenInformation: (
    token: Win32Handle,
    infoClass: number,
    buf: Buffer,
    length: number,
    out: OutNumber,
  ) => number
  /** winmm is optional: losing it costs timer resolution, not correctness. */
  timeBeginPeriod: ((ms: number) => number) | null
  timeEndPeriod: ((ms: number) => number) | null
  winmmError: string | null
}

/**
 * The EnumWindows callback.
 *
 * Declared to return `number` because Win32 `BOOL` is a four-byte int, bound as koffi
 * `'int'`. Return 1 to continue enumerating, 0 to stop. koffi's `'bool'` is one byte and
 * would corrupt the return value.
 */
type EnumWindowsProc = (hWnd: Win32Handle, lParam: number | bigint) => number

/**
 * Cast a koffi-bound function to a real signature.
 *
 * `LibraryHandle.func` is typed `(...args: any[]) => any`. Every binding below goes
 * through here exactly once so that no `any` escapes into the rest of the file and the
 * argument widths are stated in one place, next to the C prototype.
 */
function bind<T extends (...args: never[]) => unknown>(fn: unknown): T {
  return fn as T
}

function bindWin32(): Win32Bindings {
  // koffi.load() searches the standard DLL search path. Bare names are correct for these
  // four: they are all KnownDLLs, so there is no CWD planting risk.
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  const advapi32 = koffi.load('advapi32.dll')

  // Output-parameter markers. koffi.out(koffi.pointer(T)) plus a one-element JS array is
  // the documented way to receive a scalar.
  const OUT_U32 = koffi.out(koffi.pointer('uint32'))
  const INOUT_U32 = koffi.inout(koffi.pointer('uint32'))
  const OUT_PTR = koffi.out(koffi.pointer('void *'))

  // The struct declarations are built only to be measured, then thrown away.
  const measured = probeStructLayout()
  assertStructLayout(measured)

  // `intptr` carries LPARAM on the wire and `uintptr` is the width every ULONG_PTR field
  // is written at, so prove koffi agrees with the host about how wide a pointer is before
  // a single record is sent. koffi's `long` is the trap this rules out: it is 64-bit on
  // LP64 hosts while Win32 LONG is always 32-bit.
  const pointerWidth = koffi.sizeof('void *')
  if (
    koffi.sizeof('uintptr') !== pointerWidth ||
    koffi.sizeof('intptr') !== pointerWidth ||
    koffi.sizeof('int') !== 4 ||
    koffi.sizeof('int32') !== 4 ||
    koffi.sizeof('uint16') !== 2
  ) {
    throw new Error(
      `koffi integer widths on ${process.arch} are not what Win32 requires ` +
        `(void *=${pointerWidth}, uintptr=${koffi.sizeof('uintptr')}, ` +
        `intptr=${koffi.sizeof('intptr')}, int=${koffi.sizeof('int')}). ${LAYOUT_REFUSAL}.`,
    )
  }

  // Every declaration uses the classic four-argument form
  // `lib.func(convention, name, returnType, argTypes)` rather than a C prototype string.
  // The prototype parser registers GLOBAL type names, so importing this module twice in
  // one process would throw on the second registration. Anonymous types cannot collide,
  // and the explicit convention token is impossible to forget.
  const winmm = (() => {
    try {
      return koffi.load('winmm.dll')
    } catch {
      return null
    }
  })()
  const winmmError = winmm === null ? 'winmm.dll could not be loaded' : null

  return {
    layout: measured,

    // ---------------- user32: input synthesis ----------------
    // UINT SendInput(UINT cInputs, LPINPUT pInputs, int cbSize);
    // A Node Buffer passed for a `void *` parameter arrives as a pointer to its bytes.
    SendInput: bind(user32.func(STDCALL, 'SendInput', 'uint32', ['uint32', 'void *', 'int'])),
    // UINT MapVirtualKeyW(UINT uCode, UINT uMapType);
    MapVirtualKeyW: bind(user32.func(STDCALL, 'MapVirtualKeyW', 'uint32', ['uint32', 'uint32'])),
    // SHORT GetAsyncKeyState(int vKey);
    GetAsyncKeyState: bind(user32.func(STDCALL, 'GetAsyncKeyState', 'int16', ['int'])),

    // ---------------- user32: windows ----------------
    // HWND GetForegroundWindow(void);
    GetForegroundWindow: bind(user32.func(STDCALL, 'GetForegroundWindow', 'void *', [])),
    // DWORD GetWindowThreadProcessId(HWND hWnd, LPDWORD lpdwProcessId);
    GetWindowThreadProcessId: bind(
      user32.func(STDCALL, 'GetWindowThreadProcessId', 'uint32', ['void *', OUT_U32]),
    ),
    // BOOL EnumWindows(WNDENUMPROC lpEnumFunc, LPARAM lParam);
    // BOOL -> 'int' (four bytes). LPARAM is pointer-sized -> 'intptr'. koffi's own doc
    // example uses `long lParam` here, which is wrong on Win64; do not copy it.
    EnumWindows: bind(
      user32.func(STDCALL, 'EnumWindows', 'int', [
        koffi.pointer(koffi.proto(STDCALL, null, 'int', ['void *', 'intptr'])),
        'intptr',
      ]),
    ),
    // BOOL IsWindowVisible(HWND hWnd);
    IsWindowVisible: bind(user32.func(STDCALL, 'IsWindowVisible', 'int', ['void *'])),
    // BOOL IsIconic(HWND hWnd);
    IsIconic: bind(user32.func(STDCALL, 'IsIconic', 'int', ['void *'])),
    // int GetWindowTextW(HWND hWnd, LPWSTR lpString, int nMaxCount);
    GetWindowTextW: bind(
      user32.func(STDCALL, 'GetWindowTextW', 'int', ['void *', 'void *', 'int']),
    ),
    // int GetWindowTextLengthW(HWND hWnd);
    GetWindowTextLengthW: bind(
      user32.func(STDCALL, 'GetWindowTextLengthW', 'int', ['void *']),
    ),
    // HWND GetWindow(HWND hWnd, UINT uCmd);
    GetWindow: bind(user32.func(STDCALL, 'GetWindow', 'void *', ['void *', 'uint32'])),
    // HWND GetAncestor(HWND hwnd, UINT gaFlags);
    GetAncestor: bind(user32.func(STDCALL, 'GetAncestor', 'void *', ['void *', 'uint32'])),
    // HWND GetLastActivePopup(HWND hWnd);
    GetLastActivePopup: bind(
      user32.func(STDCALL, 'GetLastActivePopup', 'void *', ['void *']),
    ),
    // LONG_PTR GetWindowLongPtrW(HWND hWnd, int nIndex);
    // x86 exports GetWindowLongW only, and returns a 32-bit LONG.
    GetWindowLongPtrW: is32BitArch()
      ? bind(user32.func(STDCALL, 'GetWindowLongW', 'int32', ['void *', 'int']))
      : bind(user32.func(STDCALL, 'GetWindowLongPtrW', 'intptr', ['void *', 'int'])),

    // ---------------- kernel32 ----------------
    // DWORD GetLastError(void);
    GetLastError: bind(kernel32.func(STDCALL, 'GetLastError', 'uint32', [])),
    // void SetLastError(DWORD dwErrCode);
    SetLastError: bind(kernel32.func(STDCALL, 'SetLastError', 'void', ['uint32'])),
    // HANDLE OpenProcess(DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwProcessId);
    OpenProcess: bind(
      kernel32.func(STDCALL, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
    ),
    // BOOL CloseHandle(HANDLE hObject);
    CloseHandle: bind(kernel32.func(STDCALL, 'CloseHandle', 'int', ['void *'])),
    // BOOL QueryFullProcessImageNameW(HANDLE, DWORD, LPWSTR, PDWORD lpdwSize);
    // lpdwSize is [in,out] and counted in CHARACTERS, not bytes.
    QueryFullProcessImageNameW: bind(
      kernel32.func(STDCALL, 'QueryFullProcessImageNameW', 'int', [
        'void *',
        'uint32',
        'void *',
        INOUT_U32,
      ]),
    ),
    // HANDLE GetCurrentProcess(void);  returns the pseudo-handle (HANDLE)-1.
    GetCurrentProcess: bind(kernel32.func(STDCALL, 'GetCurrentProcess', 'void *', [])),

    // ---------------- dwmapi ----------------
    // HRESULT DwmGetWindowAttribute(HWND, DWORD dwAttribute, PVOID pvAttribute, DWORD cb);
    DwmGetWindowAttribute: bind(
      dwmapi.func(STDCALL, 'DwmGetWindowAttribute', 'int32', [
        'void *',
        'uint32',
        'void *',
        'uint32',
      ]),
    ),

    // ---------------- advapi32 ----------------
    // BOOL OpenProcessToken(HANDLE, DWORD DesiredAccess, PHANDLE TokenHandle);
    OpenProcessToken: bind(
      advapi32.func(STDCALL, 'OpenProcessToken', 'int', ['void *', 'uint32', OUT_PTR]),
    ),
    // BOOL GetTokenInformation(HANDLE, TOKEN_INFORMATION_CLASS, LPVOID, DWORD, PDWORD);
    GetTokenInformation: bind(
      advapi32.func(STDCALL, 'GetTokenInformation', 'int', [
        'void *',
        'int',
        'void *',
        'uint32',
        OUT_U32,
      ]),
    ),

    // ---------------- winmm (optional) ----------------
    // MMRESULT timeBeginPeriod(UINT uPeriod);  /  MMRESULT timeEndPeriod(UINT uPeriod);
    timeBeginPeriod:
      winmm === null
        ? null
        : bind<(ms: number) => number>(
            winmm.func(STDCALL, 'timeBeginPeriod', 'uint32', ['uint32']),
          ),
    timeEndPeriod:
      winmm === null
        ? null
        : bind<(ms: number) => number>(
            winmm.func(STDCALL, 'timeEndPeriod', 'uint32', ['uint32']),
          ),
    winmmError,
  }
}

// =====================================================================================
// SECTION 5 — handles and wide strings
// =====================================================================================

/**
 * Normalise a handle to its numeric address so two handles can be compared.
 *
 * koffi 3.x returns pointers as BigInt, but going through `koffi.address()` for anything
 * else means a representation change degrades to a correct comparison rather than to
 * `String(obj)` making every handle look identical.
 */
export function handleAddress(handle: Win32Handle): bigint {
  if (handle === null || handle === undefined) return 0n
  if (typeof handle === 'bigint') return handle
  if (typeof handle === 'number') return Number.isFinite(handle) ? BigInt(handle) : 0n
  try {
    return koffi.address(handle)
  } catch {
    return 0n
  }
}

export function isNullHandle(handle: Win32Handle): boolean {
  return handleAddress(handle) === 0n
}

function sameHandle(a: Win32Handle, b: Win32Handle): boolean {
  return handleAddress(a) === handleAddress(b)
}

function handleToId(handle: Win32Handle): string | null {
  const address = handleAddress(handle)
  return address === 0n ? null : `0x${address.toString(16)}`
}

// Two separate scratch buffers, so reading a window title can never stomp a path that a
// caller is still holding a pointer into. MAX_PATH is 260 but long paths reach 32767.
let titleBuf: Buffer = Buffer.alloc(2048)
let pathBuf: Buffer = Buffer.alloc(2048)

function titleScratch(chars: number): Buffer {
  const bytes = chars * 2
  if (titleBuf.length < bytes) titleBuf = Buffer.alloc(bytes)
  return titleBuf
}

function pathScratch(chars: number): Buffer {
  const bytes = chars * 2
  if (pathBuf.length < bytes) pathBuf = Buffer.alloc(bytes)
  return pathBuf
}

function decodeWide(buf: Buffer, chars: number): string {
  if (chars <= 0) return ''
  // The explicit-length form is used rather than string16() because the Win32 APIs
  // return the length and a truncated buffer is not guaranteed to be NUL-terminated.
  const decoded: unknown = koffi.decode(buf, 'char16_t', chars)
  return typeof decoded === 'string' ? decoded : ''
}

// =====================================================================================
// SECTION 6 — result shapes the UI and the hold loop consume
// =====================================================================================

export interface SendFailure {
  requested: number
  inserted: number
  lastError: number
  reason: string
  at: number
}

export interface ReleaseResult {
  released: number
  error: string | null
}

/**
 * Three-state elevation answer, plus the honest fourth state for "we could not look".
 *
 * `probably-elevated` is not a hedge for its own sake: `OpenProcess` with
 * PROCESS_QUERY_INFORMATION being denied is exactly what a medium-integrity process sees
 * against a high-integrity one, and it is also what a protected (anti-cheat) process
 * looks like. Reporting it as "probably" is the truthful reading. R-05 asks the tester
 * to confirm the denial actually happens.
 */
export type ElevationState =
  | 'known-elevated'
  | 'known-not-elevated'
  | 'probably-elevated'
  | 'unknown'

export interface ElevationReport {
  state: ElevationState
  lastError: number | null
  reason: string
}

export interface ForegroundBlockingReport {
  /** True only when we have positive reason to think injection will land. */
  ok: boolean
  severity: 'ok' | 'warn' | 'blocked' | 'info'
  app: AppInfo | null
  self: ElevationReport
  target: ElevationReport
  /** Ready to render. No em dashes, no jargon the user cannot act on. */
  message: string
}

/** One enumerated application, before it is narrowed to the shared `AppInfo` shape. */
export interface WindowsAppEntry {
  identity: string
  name: string
  pid: number
  path: string | null
  executable: string | null
  title: string
  hwnd: string | null
  hwnds: string[]
  windowCount: number
  isForeground: boolean
  minimized: boolean
}

export interface WindowsDiagnostics {
  platform: string
  arch: string
  koffiVersion: string
  initialised: boolean
  initError: string | null
  expectedLayout: InputLayout
  measuredLayout: InputLayout | null
  recordConstants: { INPUT_SIZE: number; UNION_OFF: number; KI_EXTRA: number; MI_EXTRA: number }
  useVirtualKeys: boolean
  heldKeyIds: string[]
  heldButtonIds: MouseButtonId[]
  lastSendFailure: SendFailure | null
  timerPeriodDepth: number
  winmmAvailable: boolean
  winmmError: string | null
}

// =====================================================================================
// SECTION 7 — the adapter
// =====================================================================================

interface HeldKey {
  key: KeyDef
  encoding: KeyEncoding
}

interface HeldButton {
  button: MouseDef
  encoding: MouseEncoding
}

/**
 * A test-only seam. When set, it replaces the `SendInput` call so the batching, ordering
 * and held-state bookkeeping can be exercised on a machine that has no user32.dll. It is
 * reachable only through `__test` and is never set by application code.
 */
type SendHook = (buf: Buffer, count: number) => number
let sendHook: SendHook | null = null

/**
 * The Windows implementation of the shared `NativeInput` interface, plus the extras the
 * Windows layer needs that macOS does not (elevation reporting, timer resolution).
 *
 * `implements` both halves of the seam so the locked contract is compiler-enforced rather
 * than merely intended. `NativeInputExtras` is all-or-nothing, and all three are honest
 * on Windows: `keyDownRepeat` is a genuine typematic re-assert, `physicalModifiersClear`
 * reads the real key state, and `keyUpToPid` is a documented no-op because Windows has no
 * per-process input synthesis (see its comment).
 */
export class WindowsNativeInput implements NativeInput, NativeInputExtras {
  private bindings: Win32Bindings | null = null
  private bindError: Error | null = null
  private disposed = false
  private useVirtualKeys = false
  private timerPeriodDepth = 0
  private lastSendFailure: SendFailure | null = null
  private selfElevationCache: ElevationReport | null = null
  private lastEnumErrors: string[] = []

  /** Insertion-ordered, so release order is press order reversed. */
  private readonly heldKeys = new Map<string, HeldKey>()
  private readonly heldButtons = new Map<MouseButtonId, HeldButton>()

  // ---------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------

  /**
   * Bind the FFI and assert the struct layout.
   *
   * Rejects on any failure, and parks the same Error in `initError` so a caller that
   * cannot await (a diagnostics panel, a crash reporter) can still show a real message
   * rather than a blank screen. Idempotent: a second call returns the first outcome.
   */
  init(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('windows native adapter was disposed'))
    if (this.bindings) return Promise.resolve()
    if (this.bindError) return Promise.reject(this.bindError)

    if (!isWindows) {
      this.bindError = new Error(
        `The Windows input adapter was loaded on ${process.platform}. ` +
          `It can only bind user32.dll on Windows.`,
      )
      return Promise.reject(this.bindError)
    }
    try {
      this.bindings = bindWin32()
      return Promise.resolve()
    } catch (err) {
      this.bindError = err instanceof Error ? err : new Error(String(err))
      this.bindings = null
      return Promise.reject(this.bindError)
    }
  }

  /** The parked init failure, or null. Never throws. */
  get initError(): Error | null {
    return this.bindError
  }

  /** True once the FFI is bound and the layout assertion has passed. */
  get ready(): boolean {
    return this.bindings !== null
  }

  /**
   * Release everything, balance any outstanding timer period, and refuse further work.
   * Safe to call more than once, and safe to call before `init()`.
   */
  dispose(): void {
    if (this.disposed) return
    try {
      this.releaseAll()
    } catch {
      // dispose() runs on exit paths; it must never be the thing that throws.
    }
    while (this.timerPeriodDepth > 0) this.endHighResolutionTimers()
    this.disposed = true
  }

  private win(): Win32Bindings {
    if (this.disposed) throw new Error('windows native adapter was disposed')
    if (this.bindings) return this.bindings
    if (this.bindError) throw this.bindError
    throw new Error(
      isWindows
        ? 'The Windows input adapter is not initialised. Call init() and await it first.'
        : `The Windows input adapter was loaded on ${process.platform} and cannot touch ` +
          `user32.dll. Call init() to get the real reason.`,
    )
  }

  // ---------------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------------

  /**
   * Apply the injector-relevant slice of settings.
   *
   * Only `windowsUseVirtualKeys` matters here. Keys already held keep the encoding they
   * were pressed with, so flipping this mid-session cannot leave a key down that we then
   * try to release through the other path.
   */
  applySettings(settings: Settings): void {
    this.useVirtualKeys = settings.windowsUseVirtualKeys === true
  }

  setUseVirtualKeys(enabled: boolean): void {
    this.useVirtualKeys = enabled
  }

  // ---------------------------------------------------------------------------------
  // SendInput
  // ---------------------------------------------------------------------------------

  /**
   * Send `count` already-written records.
   *
   * The return-value contract (nf-winuser-sendinput):
   *   - returns the number of events inserted; anything less than `count` is a failure
   *   - "If the function returns zero, the input was already blocked by another thread"
   *     (BlockInput is active, or the secure desktop owns input)
   *   - and, verbatim: "This function fails when it is blocked by UIPI. Note that neither
   *     GetLastError nor the return value will indicate the failure was caused by UIPI
   *     blocking."
   *
   * So a full count is NOT proof of success. Nothing in this file, and nothing calling
   * it, may report "keys are being held" on the strength of this number alone.
   */
  private send(buf: Buffer, count: number): number {
    if (sendHook) return sendHook(buf, count)
    const w = this.win()
    // Zero the thread's last error first so a stale value cannot be misread. koffi
    // already protects GetLastError across the call boundary (CHANGELOG 2.6.10), but
    // this costs nothing and removes the doubt.
    w.SetLastError(WIN32_ERROR.SUCCESS)
    const inserted = w.SendInput(count, buf, INPUT_SIZE)
    if (inserted !== count) {
      const lastError = w.GetLastError()
      const failure: SendFailure = {
        requested: count,
        inserted,
        lastError,
        reason: describeSendInputError(inserted, lastError),
        at: Date.now(),
      }
      this.lastSendFailure = failure
      const error = new Error(
        `SendInput inserted ${inserted} of ${count} records ` +
          `(GetLastError=${lastError}): ${failure.reason}`,
      )
      Object.assign(error, { code: 'ESENDINPUT', lastError })
      throw error
    }
    this.lastSendFailure = null
    return inserted
  }

  getLastSendFailure(): SendFailure | null {
    return this.lastSendFailure
  }

  // ---------------------------------------------------------------------------------
  // key and button injection
  // ---------------------------------------------------------------------------------

  /**
   * Press a key and leave it down.
   *
   * The held-state entry is recorded BEFORE the call, and it stores the exact encoding
   * used, so a press that throws part-way (or that "succeeds" under UIPI while nothing
   * happens) still has a matching key-up waiting in `releaseAll()`. A stuck key in
   * someone's game is the worst failure this app can produce; bookkeeping that is too
   * eager is strictly safer than bookkeeping that is too clever.
   */
  keyDown(key: KeyDef): void {
    const encoding = encodeKey(key, this.useVirtualKeys)
    const buf = slotsFor(1)
    writeKeyRecord(buf, 0, {
      wVk: encoding.wVk,
      wScan: encoding.wScan,
      dwFlags: encoding.downFlags,
    })
    this.heldKeys.set(key.id, { key, encoding })
    this.send(buf, 1)
  }

  /**
   * Re-assert an already-held key, the way the keyboard's own typematic repeat does.
   *
   * Windows has no "this is an autorepeat" flag in KEYBDINPUT. Hardware repeat arrives
   * at applications as further WM_KEYDOWN messages with an incremented repeat count and
   * no intervening WM_KEYUP, so an injected repeat is simply the same key-down record
   * sent again. Sending an intermediate key-up would duplicate characters in a text
   * field, which is why it never happens here.
   *
   * The encoding the key was pressed with is reused, so flipping the virtual-key setting
   * mid-session cannot make a repeat arrive as a different key than the press did.
   */
  keyDownRepeat(key: KeyDef): void {
    const held = this.heldKeys.get(key.id)
    const encoding = held ? held.encoding : encodeKey(key, this.useVirtualKeys)
    const buf = slotsFor(1)
    writeKeyRecord(buf, 0, {
      wVk: encoding.wVk,
      wScan: encoding.wScan,
      dwFlags: encoding.downFlags,
    })
    if (!held) this.heldKeys.set(key.id, { key, encoding })
    this.send(buf, 1)
  }

  /**
   * macOS parity for `CGEventPostToPid`. Deliberately a no-op on Windows.
   *
   * There is no user-mode way to synthesize input into one named process here.
   * `SendInput` posts to the system input stream and the foreground window consumes it;
   * `PostMessageW(hwnd, WM_KEYUP, ...)` reaches a specific window but goes around the
   * input stream entirely, so `GetAsyncKeyState`, DirectInput and Raw Input never see it
   * and most games ignore it.
   *
   * The focus-loss path posts each release twice: once here and once globally through
   * `keyUp()`. On Windows the first post does nothing and the global one does all the
   * work, which is the correct behaviour, not a dropped release. It is a no-op rather
   * than a second global post so that focus loss cannot send duplicate key-ups.
   */
  keyUpToPid(_key: KeyDef, _pid: number): void {
    // intentionally empty; see the comment above
  }

  /**
   * True when the user is not physically holding Shift, Ctrl, Alt or either Windows key.
   *
   * The focus-gain gate waits on this. Someone who Alt+Tabs into the target is usually
   * still holding Alt at the instant focus lands, and pressing a held key into that
   * turns it into a chord, so the first press waits until their hands are off.
   *
   * `GetAsyncKeyState` cannot distinguish a physically-held modifier from one we injected
   * ourselves. That is fine here and only here: the gate runs before the first press of a
   * session, when we are holding nothing.
   */
  physicalModifiersClear(): boolean {
    const w = this.win()
    const down = (vk: number): boolean => (w.GetAsyncKeyState(vk) & 0x8000) !== 0
    return !(
      down(VK.SHIFT) ||
      down(VK.CONTROL) ||
      down(VK.MENU) ||
      down(VK.LWIN) ||
      down(VK.RWIN)
    )
  }

  /** Release a key. Safe for a key that is not down. The held entry is cleared either way. */
  keyUp(key: KeyDef): void {
    const held = this.heldKeys.get(key.id)
    const encoding = held ? held.encoding : encodeKey(key, this.useVirtualKeys)
    const buf = slotsFor(1)
    writeKeyRecord(buf, 0, {
      wVk: encoding.wVk,
      wScan: encoding.wScan,
      dwFlags: encoding.upFlags,
    })
    try {
      this.send(buf, 1)
    } finally {
      // Forget it whether or not the send worked. Retrying a failed up would fail the
      // same way, and a phantom entry would make releaseAll() send a duplicate.
      this.heldKeys.delete(key.id)
    }
  }

  /**
   * Press a mouse button and leave it down. No cursor movement is generated: dx and dy
   * are zero and MOUSEEVENTF_MOVE is not set.
   *
   * The wheel has no held state, so it is sent but not recorded. It emits discrete
   * detents; there is no up event to pair with, and putting it in the held map would
   * make `releaseAll()` try to release something that was never down.
   */
  mouseDown(button: MouseDef): void {
    const encoding = encodeMouseDown(button)
    const buf = slotsFor(1)
    writeMouseRecord(buf, 0, { dwFlags: encoding.dwFlags, mouseData: encoding.mouseData })
    const up = encodeMouseUp(button)
    if (up !== null) this.heldButtons.set(button.id, { button, encoding: up })
    this.send(buf, 1)
  }

  /** Release a mouse button. A no-op for the wheel, which has no up event. */
  mouseUp(button: MouseDef): void {
    const encoding = encodeMouseUp(button)
    if (encoding === null) {
      this.heldButtons.delete(button.id)
      return
    }
    const buf = slotsFor(1)
    writeMouseRecord(buf, 0, { dwFlags: encoding.dwFlags, mouseData: encoding.mouseData })
    try {
      this.send(buf, 1)
    } finally {
      this.heldButtons.delete(button.id)
    }
  }

  /**
   * Release everything we believe is down, in ONE `SendInput` call.
   *
   * `SendInput` inserts the array serially and guarantees that no other input is
   * interleaved with it, so from the target application's point of view this is atomic.
   * That is why it is one call and not a loop.
   *
   * Ordering inside the batch: mouse buttons first, then ordinary keys in reverse press
   * order, then modifiers last. Modifiers go last so that a chord like Shift+W never
   * momentarily becomes a bare W.
   *
   * The held state is snapshotted before the call and cleared in a `finally`, so a send
   * that throws still leaves us with an empty, honest picture of what is down instead of
   * a set we would keep re-releasing. Idempotent, and never throws: every exit path in
   * the app funnels here, including `uncaughtException`.
   */
  releaseAll(): ReleaseResult {
    const keys = [...this.heldKeys.values()]
    const buttons = [...this.heldButtons.values()]
    if (keys.length === 0 && buttons.length === 0) return { released: 0, error: null }

    const ordinary = keys.filter((h) => !h.key.isModifier).reverse()
    const modifiers = keys.filter((h) => h.key.isModifier).reverse()

    const total = buttons.length + ordinary.length + modifiers.length
    const buf = slotsFor(total)
    let i = 0
    for (const held of [...buttons].reverse()) {
      writeMouseRecord(buf, i++, {
        dwFlags: held.encoding.dwFlags,
        mouseData: held.encoding.mouseData,
      })
    }
    for (const held of [...ordinary, ...modifiers]) {
      writeKeyRecord(buf, i++, {
        wVk: held.encoding.wVk,
        wScan: held.encoding.wScan,
        dwFlags: held.encoding.upFlags,
      })
    }

    try {
      this.send(buf, i)
      return { released: i, error: null }
    } catch (err) {
      return { released: 0, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.heldKeys.clear()
      this.heldButtons.clear()
    }
  }

  getHeldKeyIds(): string[] {
    return [...this.heldKeys.keys()]
  }

  getHeldButtonIds(): MouseButtonId[] {
    return [...this.heldButtons.keys()]
  }

  // ---------------------------------------------------------------------------------
  // timer resolution
  // ---------------------------------------------------------------------------------

  /**
   * Ask Windows for a 1 ms timer period, for the duration of a session.
   *
   * The hold loop schedules on absolute deadlines and re-asserts every 25 ms; without
   * this the default timer resolution can be 15.6 ms, which turns a 33 ms repeat into
   * visible stutter. Reference-counted so nested arms cannot unbalance it, and every
   * begin must be matched by an end (Microsoft: "you must match each call to
   * timeBeginPeriod with a call to timeEndPeriod").
   *
   * Missing winmm is not fatal. Returns the MMRESULT, or null when unavailable.
   */
  beginHighResolutionTimers(period = 1): number | null {
    const fn = this.bindings?.timeBeginPeriod
    if (!fn) return null
    const result = fn(period)
    if (result === TIMERR.NOERROR) this.timerPeriodDepth += 1
    return result
  }

  /**
   * Balance one `beginHighResolutionTimers()`. Never goes negative, and always makes
   * progress: the depth is decremented even when winmm has gone away, so `dispose()`
   * draining the depth cannot spin.
   */
  endHighResolutionTimers(period = 1): number | null {
    if (this.timerPeriodDepth <= 0) return null
    this.timerPeriodDepth -= 1
    const fn = this.bindings?.timeEndPeriod
    if (!fn) return null
    return fn(period)
  }

  getTimerPeriodDepth(): number {
    return this.timerPeriodDepth
  }

  // ---------------------------------------------------------------------------------
  // permissions (there is no Windows equivalent)
  // ---------------------------------------------------------------------------------

  /**
   * macOS parity for `AXIsProcessTrusted()`.
   *
   * Windows has no permission gate on `SendInput`: no consent prompt, no entitlement, no
   * setting. Always true, so the shared UI branches on one value and simply does not
   * render the permission step here. What actually blocks injection on Windows is UIPI
   * (see `describeForegroundBlocking`) and kernel anti-cheat (see the checklist, R-08).
   */
  hasPermission(): boolean {
    return true
  }

  /** Nothing to open. Deliberately a no-op, so no "grant permission" button appears. */
  openPermissionSettings(): void {
    // intentionally empty
  }

  // ---------------------------------------------------------------------------------
  // focus
  // ---------------------------------------------------------------------------------

  /**
   * The pid of the foreground window's process, or null when we do not know.
   *
   * Null is not "no target": `GetForegroundWindow()` legitimately returns NULL during a
   * desktop switch, while the secure desktop (a UAC prompt, Ctrl+Alt+Del) is up, or
   * while a window is being destroyed. The caller MUST treat null as "not on target" and
   * release, which is the safe direction.
   */
  getFrontmostPid(): number | null {
    const w = this.win()
    const hwnd = w.GetForegroundWindow()
    if (isNullHandle(hwnd)) return null
    const pid = this.windowPid(hwnd)
    return pid === 0 ? null : pid
  }

  private windowPid(hwnd: Win32Handle): number {
    const w = this.win()
    const out: OutNumber = [0]
    const tid = w.GetWindowThreadProcessId(hwnd, out)
    if (!tid) return 0
    return out[0] >>> 0
  }

  /**
   * The window caption.
   *
   * Cheap and safe cross-process: for another process's window `GetWindowTextW` returns
   * the cached caption and does not send WM_GETTEXT, so a hung game cannot hang us.
   * ("This behavior is by design", per the docs.)
   */
  private windowTitle(hwnd: Win32Handle): string {
    const w = this.win()
    const length = w.GetWindowTextLengthW(hwnd)
    if (length <= 0) return ''
    const chars = Math.min(length + 1, 1024)
    const buf = titleScratch(chars)
    const written = w.GetWindowTextW(hwnd, buf, chars)
    return decodeWide(buf, written)
  }

  /**
   * The full image path for a pid, or null.
   *
   * PROCESS_QUERY_LIMITED_INFORMATION exists precisely so a lower-privileged caller can
   * do this; Microsoft documents it as sufficient for QueryFullProcessImageName and as
   * usable against processes we could not otherwise open.
   */
  private processImagePath(pid: number): string | null {
    const w = this.win()
    if (!pid) return null
    const handle = w.OpenProcess(PROCESS_ACCESS.QUERY_LIMITED_INFORMATION, 0, pid)
    if (isNullHandle(handle)) return null
    try {
      const chars = 1024
      const buf = pathScratch(chars)
      const size: OutNumber = [chars] // [in,out], counted in CHARACTERS
      if (!w.QueryFullProcessImageNameW(handle, PROCESS_NAME.WIN32, buf, size)) return null
      const text = decodeWide(buf, size[0])
      return text.length > 0 ? text : null
    } finally {
      w.CloseHandle(handle)
    }
  }

  /** The frontmost application, narrowed to the shared shape, or null when unknown. */
  getForegroundApplication(): AppInfo | null {
    const w = this.win()
    const hwnd = w.GetForegroundWindow()
    if (isNullHandle(hwnd)) return null
    const pid = this.windowPid(hwnd)
    if (!pid) return null
    const path = this.processImagePath(pid)
    const title = this.windowTitle(hwnd)
    return {
      identity: identityFor(path, pid),
      name: prettyName(basename(path), title),
      pid,
      path,
    }
  }

  // ---------------------------------------------------------------------------------
  // application enumeration
  // ---------------------------------------------------------------------------------

  private windowExStyle(hwnd: Win32Handle): number | null {
    const w = this.win()
    // GetWindowLongPtr returns 0 both for "the value is zero" and for failure, so the
    // documented way to tell them apart is to clear the last error first.
    w.SetLastError(WIN32_ERROR.SUCCESS)
    const raw = w.GetWindowLongPtrW(hwnd, GWL.EXSTYLE)
    const value = typeof raw === 'bigint' ? Number(BigInt.asUintN(32, raw)) : raw >>> 0
    if (value === 0 && w.GetLastError() !== WIN32_ERROR.SUCCESS) return null
    return value >>> 0
  }

  /** True when DWM reports the window cloaked, i.e. invisible despite WS_VISIBLE. */
  private isCloaked(hwnd: Win32Handle): boolean {
    const w = this.win()
    const out = Buffer.alloc(4)
    const hr = w.DwmGetWindowAttribute(hwnd, DWM.WA_CLOAKED, out, 4)
    // Any non-S_OK HRESULT means "we could not ask" (pre-Win8, DWM off, a bad handle).
    // Treat that as not cloaked so an unexpected HRESULT hides apps rather than crashing.
    if (hr !== S_OK) return false
    return out.readUInt32LE(0) !== 0
  }

  /** The raw DWMWA_CLOAKED bits for a window. Diagnostic only. */
  cloakReason(hwnd: Win32Handle): number {
    const w = this.win()
    const out = Buffer.alloc(4)
    if (w.DwmGetWindowAttribute(hwnd, DWM.WA_CLOAKED, out, 4) !== S_OK) return 0
    return out.readUInt32LE(0)
  }

  /**
   * Raymond Chen's Alt+Tab ownership rule, with the published typo fixed.
   *
   *   walk = GetAncestor(hwnd, GA_ROOTOWNER)
   *   while ((try = GetLastActivePopup(walk)) != walk) {
   *     if (IsWindowVisible(try)) break;   // break WITHOUT assigning
   *     walk = try;
   *   }
   *   return walk == hwnd
   *
   * The published snippet reads `(hwndTry = GetLastActivePopup(hwndWalk)) != hwndTry`,
   * which is always false. The comparison is meant to be against `hwndWalk`.
   *
   * The "break without assigning" is load-bearing: for an app showing a modal dialog it
   * makes the MAIN window the Alt+Tab representative and the dialog not, which is what a
   * one-entry-per-app list wants. Assigning inverts that.
   */
  private isAltTabWindow(hwnd: Win32Handle): boolean {
    const w = this.win()
    let walk = w.GetAncestor(hwnd, GA.ROOTOWNER)
    if (isNullHandle(walk)) walk = hwnd
    // Ownership chains are shallow. The guard exists so a cycle cannot spin us forever
    // inside a callback that user32 is waiting on.
    for (let guard = 0; guard < 32; guard += 1) {
      const candidate = w.GetLastActivePopup(walk)
      if (isNullHandle(candidate) || sameHandle(candidate, walk)) break
      if (w.IsWindowVisible(candidate)) break
      walk = candidate
    }
    return sameHandle(walk, hwnd)
  }

  /**
   * Enumerate the windows a user would call "an app I can switch to", one entry per
   * process.
   *
   * The six-stage filter, cheapest rejection first:
   *   1. IsWindowVisible
   *   2. GetWindow(GW_OWNER) is NULL, and the Alt+Tab ownership rule agrees
   *   3. GetWindowTextLengthW > 0
   *   4. not WS_EX_TOOLWINDOW, unless WS_EX_APPWINDOW
   *   5. DwmGetWindowAttribute(DWMWA_CLOAKED) is 0
   *   6. not our own pid
   *
   * Stage 5 is what removes the Windows 10/11 "ghosts": suspended UWP apps and windows
   * on another virtual desktop report as visible but are not on screen.
   *
   * CALLBACK LIFETIME, read before touching this:
   *
   *   `proc` is passed as a plain JS function, which makes it a koffi TRANSIENT callback.
   *   It is valid only while `EnumWindows` is running, which is exactly EnumWindows'
   *   contract (user32 calls it synchronously and never keeps it), and there is nothing
   *   to leak. Do NOT "be safe" and use `koffi.register`: registered callbacks come from
   *   a pool of 8192 slots for the whole process, and this function runs every time the
   *   app list refreshes, so each call would burn one permanently.
   *
   *   The body is entirely wrapped in try/catch and ALWAYS returns 1. koffi 3.2.1 was
   *   observed to propagate an exception thrown inside a transient callback out through
   *   the enclosing FFI call, which would abandon the enumeration mid-walk with user32
   *   still holding its window list. Errors are collected and reported, never thrown.
   */
  listWindows(options: { includeSelf?: boolean } = {}): WindowsAppEntry[] {
    const w = this.win()
    const includeSelf = options.includeSelf === true
    const selfPid = process.pid
    const foreground = w.GetForegroundWindow()
    const foregroundAddress = handleAddress(foreground)

    const byPid = new Map<number, WindowsAppEntry>()
    const errors: string[] = []

    const proc: EnumWindowsProc = (hwnd) => {
      try {
        if (!w.IsWindowVisible(hwnd)) return 1

        // Owned windows (dialogs, palettes, tool panels) collapse onto their owner.
        if (!isNullHandle(w.GetWindow(hwnd, GW.OWNER))) return 1
        if (!this.isAltTabWindow(hwnd)) return 1
        if (w.GetWindowTextLengthW(hwnd) <= 0) return 1

        const exStyle = this.windowExStyle(hwnd)
        if (exStyle === null) return 1
        if ((exStyle & WS_EX.TOOLWINDOW) !== 0 && (exStyle & WS_EX.APPWINDOW) === 0) return 1
        if (this.isCloaked(hwnd)) return 1

        const pid = this.windowPid(hwnd)
        if (!pid) return 1
        if (!includeSelf && pid === selfPid) return 1

        const title = this.windowTitle(hwnd)
        if (title.length === 0) return 1

        let entry = byPid.get(pid)
        if (!entry) {
          const path = this.processImagePath(pid)
          const executable = basename(path)
          entry = {
            identity: identityFor(path, pid),
            name: prettyName(executable, title),
            pid,
            path,
            executable,
            title,
            hwnd: handleToId(hwnd),
            hwnds: [],
            windowCount: 0,
            isForeground: false,
            minimized: true,
          }
          byPid.set(pid, entry)
        }
        const id = handleToId(hwnd)
        if (id !== null) entry.hwnds.push(id)
        entry.windowCount += 1

        const minimized = w.IsIconic(hwnd) !== 0
        const isForeground =
          foregroundAddress !== 0n && handleAddress(hwnd) === foregroundAddress
        // Pick the best representative window for the title: the foreground one if this
        // process owns it, otherwise the first non-minimised one.
        if (isForeground || (entry.minimized && !minimized)) {
          entry.title = title
          entry.hwnd = id
        }
        if (!minimized) entry.minimized = false
        if (isForeground) entry.isForeground = true
        return 1
      } catch (err) {
        // NEVER let this escape into user32.
        errors.push(err instanceof Error ? err.message : String(err))
        return 1
      }
    }

    w.SetLastError(WIN32_ERROR.SUCCESS)
    const ok = w.EnumWindows(proc, 0)
    if (!ok) {
      // EnumWindows returns 0 when the callback returned 0 (we never do) or on a real
      // failure, so a zero here with a real last error is worth surfacing.
      const lastError = w.GetLastError()
      if (lastError !== WIN32_ERROR.SUCCESS) {
        errors.push(`EnumWindows failed, GetLastError=${lastError}`)
      }
    }
    this.lastEnumErrors = errors

    const entries = [...byPid.values()]
    entries.sort(
      (a, b) =>
        Number(b.isForeground) - Number(a.isForeground) ||
        Number(a.minimized) - Number(b.minimized) ||
        a.name.localeCompare(b.name),
    )
    return entries
  }

  /** Non-fatal problems seen inside the last `listWindows()` enumeration. */
  getLastEnumerationErrors(): string[] {
    return [...this.lastEnumErrors]
  }

  /**
   * The app list, in the shared `AppInfo` shape.
   *
   * Deduped twice: once per process by the enumeration, and once by identity here. The
   * second pass matters because a browser or a launcher can own qualifying windows in
   * more than one process, and the registry keys apps by identity, not pid. The
   * foreground entry wins, then the first one seen.
   *
   * Identity is the lowercased full image path, which is what survives the target
   * restarting. The pid is only a runtime handle. When the path cannot be read (a
   * protected process) we fall back to `pid:<n>`, which is honest but not stable, and
   * the UI should treat it as a target that may not survive a restart.
   */
  listApplications(): AppInfo[] {
    const byIdentity = new Map<string, AppInfo>()
    for (const entry of this.listWindows()) {
      const existing = byIdentity.get(entry.identity)
      if (existing && !entry.isForeground) continue
      byIdentity.set(entry.identity, {
        identity: entry.identity,
        name: entry.name,
        pid: entry.pid,
        path: entry.path,
      })
    }
    return [...byIdentity.values()]
  }

  // ---------------------------------------------------------------------------------
  // elevation and UIPI
  // ---------------------------------------------------------------------------------

  private tokenElevationOf(handle: Win32Handle): ElevationReport {
    const w = this.win()
    const token: OutHandle = [null]
    if (!w.OpenProcessToken(handle, TOKEN.QUERY, token)) {
      const lastError = w.GetLastError()
      return {
        state: lastError === WIN32_ERROR.ACCESS_DENIED ? 'probably-elevated' : 'unknown',
        lastError,
        reason: 'the process opened but its token did not',
      }
    }
    const tokenHandle = token[0]
    try {
      const buf = Buffer.alloc(4) // TOKEN_ELEVATION { DWORD TokenIsElevated; }
      const returned: OutNumber = [0]
      if (!w.GetTokenInformation(tokenHandle, TOKEN.InfoElevation, buf, 4, returned)) {
        return {
          state: 'unknown',
          lastError: w.GetLastError(),
          reason: 'GetTokenInformation(TokenElevation) failed',
        }
      }
      const elevated = buf.readUInt32LE(0) !== 0
      return {
        state: elevated ? 'known-elevated' : 'known-not-elevated',
        lastError: null,
        reason: elevated ? 'the token reports elevated' : 'the token reports not elevated',
      }
    } finally {
      w.CloseHandle(tokenHandle)
    }
  }

  /**
   * Is THIS process elevated? Cached: it cannot change while we run.
   *
   * `GetCurrentProcess()` returns a pseudo-handle, (HANDLE)-1, which must never be
   * passed to CloseHandle. `tokenElevationOf` only closes the token it opened.
   */
  getSelfElevation(): ElevationReport {
    if (this.selfElevationCache) return this.selfElevationCache
    const w = this.win()
    const report = this.tokenElevationOf(w.GetCurrentProcess())
    this.selfElevationCache = report
    return report
  }

  /**
   * Best-effort elevation check for another pid.
   *
   * `OpenProcessToken` needs PROCESS_QUERY_INFORMATION, and a medium-integrity process is
   * normally refused that right against a high-integrity process of the same user. A
   * clean ERROR_ACCESS_DENIED is therefore a strong signal that the target is elevated or
   * protected, and it is reported as `probably-elevated` rather than guessed either way.
   */
  getProcessElevation(pid: number): ElevationReport {
    const w = this.win()
    if (!pid) return { state: 'unknown', lastError: null, reason: 'no pid' }
    const handle = w.OpenProcess(PROCESS_ACCESS.QUERY_INFORMATION, 0, pid)
    if (isNullHandle(handle)) {
      const lastError = w.GetLastError()
      if (lastError === WIN32_ERROR.ACCESS_DENIED) {
        return {
          state: 'probably-elevated',
          lastError,
          reason:
            'OpenProcess(PROCESS_QUERY_INFORMATION) was denied, which normally means the ' +
            'target runs at a higher integrity level or is protected by anti-cheat',
        }
      }
      return { state: 'unknown', lastError, reason: `OpenProcess failed (${lastError})` }
    }
    try {
      return this.tokenElevationOf(handle)
    } finally {
      w.CloseHandle(handle)
    }
  }

  /**
   * One call the UI can render: "will pressing Start actually do anything against
   * whatever is in front right now?"
   *
   * This exists because `SendInput` lies. Under UIPI it reports the full count inserted
   * and leaves GetLastError at zero while nothing reaches the target. Without this, the
   * app would confidently say "holding W" into a void.
   */
  describeForegroundBlocking(): ForegroundBlockingReport {
    const unknown: ElevationReport = { state: 'unknown', lastError: null, reason: 'not checked' }
    const app = this.getForegroundApplication()
    if (!app) {
      return {
        ok: false,
        severity: 'info',
        app: null,
        self: unknown,
        target: unknown,
        message: 'There is no foreground window right now, so there is nothing to check.',
      }
    }
    const self = this.getSelfElevation()
    const target = this.getProcessElevation(app.pid)

    if (self.state === 'known-elevated') {
      return {
        ok: true,
        severity: 'ok',
        app,
        self,
        target,
        message: `KeyPress Ultimate is running as administrator, so it can inject into ${app.name}.`,
      }
    }
    if (target.state === 'known-elevated') {
      return {
        ok: false,
        severity: 'blocked',
        app,
        self,
        target,
        message:
          `${app.name} is running as administrator, restart KeyPress Ultimate as ` +
          `administrator. Windows blocks input from a normal app into an elevated one, ` +
          `so the keys will not reach ${app.name} until both are running the same way.`,
      }
    }
    if (target.state === 'probably-elevated') {
      return {
        ok: false,
        severity: 'warn',
        app,
        self,
        target,
        message:
          `Windows would not let KeyPress Ultimate inspect ${app.name}, which usually means ` +
          `it is running as administrator or is protected by anti-cheat. Keys may silently ` +
          `do nothing. If nothing happens, restart KeyPress Ultimate as administrator.`,
      }
    }
    return {
      ok: true,
      severity: 'ok',
      app,
      self,
      target,
      message: `${app.name} looks reachable.`,
    }
  }

  /**
   * Diagnostic only, and never on a timer.
   *
   * `SendInput` cannot report a UIPI block, but the theory is that a blocked call also
   * never reaches the asynchronous key-state table. So: tap a key down, read
   * `GetAsyncKeyState`, tap it up. This genuinely presses a key, so it must sit behind an
   * explicit "Test injection" button.
   *
   * The theory is UNVERIFIED, and the documented behaviour of `BlockInput` is the
   * opposite ("calling the SendInput function while input is blocked will change the
   * asynchronous keyboard input-state table"), so a false "it works" is possible. See the
   * checklist, R-07: if the elevated case does not come back false, this should be
   * removed rather than shipped as reassurance.
   */
  probeInjectionWorks(virtualKey: number = VK.SCROLL): { ok: boolean; reason: string } {
    const w = this.win()
    const raw = w.MapVirtualKeyW(virtualKey >>> 0, MAPVK.VK_TO_VSC_EX)
    if (!raw) return { ok: false, reason: 'no scan code for the probe key' }
    const sc = encodeScan(raw)
    const downFlags = KEYEVENTF.SCANCODE | (sc.extended ? KEYEVENTF.EXTENDEDKEY : 0)

    const down = slotsFor(1)
    writeKeyRecord(down, 0, { wScan: sc.wScan, dwFlags: downFlags })
    try {
      this.send(down, 1)
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    const pressed = (w.GetAsyncKeyState(virtualKey) & 0x8000) !== 0
    const up = slotsFor(1)
    writeKeyRecord(up, 0, { wScan: sc.wScan, dwFlags: downFlags | KEYEVENTF.KEYUP })
    try {
      this.send(up, 1)
    } catch {
      // Best effort. The probe key going up matters more than reporting why it did not.
    }
    return {
      ok: pressed,
      reason: pressed
        ? 'injection reached the input stream'
        : 'injection did not reach the input stream (UIPI, anti-cheat, or blocked input)',
    }
  }

  // ---------------------------------------------------------------------------------
  // diagnostics
  // ---------------------------------------------------------------------------------

  getDiagnostics(): WindowsDiagnostics {
    return {
      platform: process.platform,
      arch: process.arch,
      koffiVersion: koffiVersion(),
      initialised: this.bindings !== null,
      initError: this.bindError ? this.bindError.message : null,
      expectedLayout: expectedInputLayout(),
      measuredLayout: this.bindings ? this.bindings.layout : null,
      recordConstants: {
        INPUT_SIZE,
        UNION_OFF,
        KI_EXTRA,
        MI_EXTRA,
      },
      useVirtualKeys: this.useVirtualKeys,
      heldKeyIds: this.getHeldKeyIds(),
      heldButtonIds: this.getHeldButtonIds(),
      lastSendFailure: this.lastSendFailure,
      timerPeriodDepth: this.timerPeriodDepth,
      winmmAvailable: this.bindings?.timeBeginPeriod != null,
      winmmError: this.bindings ? this.bindings.winmmError : null,
    }
  }
}

// =====================================================================================
// SECTION 8 — helpers
// =====================================================================================

function describeSendInputError(inserted: number, lastError: number): string {
  if (inserted === 0 && lastError === WIN32_ERROR.SUCCESS) {
    return (
      'Input is currently blocked by another thread (BlockInput), or the secure desktop ' +
      'or a UAC prompt owns the input stream.'
    )
  }
  switch (lastError) {
    case WIN32_ERROR.ACCESS_DENIED:
      return (
        'Access denied. The foreground window very likely belongs to a process running ' +
        'at a higher integrity level, an app started as administrator.'
      )
    case WIN32_ERROR.INVALID_PARAMETER:
      return 'Invalid parameter, almost always a wrong cbSize or a malformed INPUT record.'
    case WIN32_ERROR.NOACCESS:
      return 'Invalid pointer passed to SendInput (the buffer was freed or moved).'
    default:
      return `Unexpected Win32 error ${lastError}.`
  }
}

function basename(path: string | null): string | null {
  if (!path) return null
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index >= 0 ? path.slice(index + 1) : path
}

function prettyName(executable: string | null, title: string): string {
  const stem = executable ? executable.replace(/\.exe$/i, '') : null
  return stem || title || 'Unknown'
}

/** Lowercased image path, which is stable across restarts of the target. */
function identityFor(path: string | null, pid: number): string {
  return path ? path.toLowerCase() : `pid:${pid}`
}

function koffiVersion(): string {
  try {
    const version: unknown = (koffi as unknown as { version?: unknown }).version
    return typeof version === 'string' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

// =====================================================================================
// SECTION 9 — module surface
// =====================================================================================

/**
 * The process-wide adapter.
 *
 * Constructing it does nothing but allocate; nothing touches a DLL until `init()`. The
 * injector holds exactly one of these, so the held-key bookkeeping has a single owner.
 */
export const windowsNative = new WindowsNativeInput()

export function createWindowsNativeInput(): WindowsNativeInput {
  return new WindowsNativeInput()
}

/** The parked init failure for the shared adapter, or null. Never throws. */
export function getInitError(): Error | null {
  return windowsNative.initError
}

/**
 * `timeBeginPeriod(1)` from winmm.dll, for the hold loop to call when a session arms.
 * Returns the MMRESULT (0 is TIMERR_NOERROR), or null when winmm is unavailable.
 */
export function timeBeginPeriod(period = 1): number | null {
  return windowsNative.beginHighResolutionTimers(period)
}

/**
 * `timeEndPeriod(1)`, which must balance every `timeBeginPeriod`. Call it on disarm and
 * again on every exit path.
 */
export function timeEndPeriod(period = 1): number | null {
  return windowsNative.endHighResolutionTimers(period)
}

/**
 * Internals exposed for the layout tests, which prove the hand-written records are
 * byte-identical to what koffi's own struct and union marshaller produces. Not for
 * application code: `installFakeSender` in particular bypasses `SendInput` entirely.
 */
export const __test = Object.freeze({
  INPUT_SIZE,
  UNION_OFF,
  KI_EXTRA,
  MI_EXTRA,
  writeKeyRecord,
  writeMouseRecord,
  slotsFor,
  encodeScan,
  encodeKey,
  encodeMouseDown,
  encodeMouseUp,
  probeStructLayout,
  assertStructLayout,
  describeSendInputError,
  basename,
  prettyName,
  identityFor,
  buffer: (): Buffer => inputBuf,
  installFakeSender: (hook: SendHook | null): void => {
    sendHook = hook
  },
})
