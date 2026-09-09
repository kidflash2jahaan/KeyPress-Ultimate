// Generates keys.json + mouse.json for KeyPress Ultimate.
// macKeyCode + winScanCode + winExtended are DERIVED from Chromium's
// dom_code_data.inc (built from HIToolbox/Events.h + Microsoft's scancode spec),
// so they are not hand-typed. winVirtualKey comes from Microsoft's VK table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INC = path.join(here, 'dom_code_data.inc');

// ---- parse the authoritative table -------------------------------------
const table = new Map(); // DomCode string -> {win, mac}
for (const line of fs.readFileSync(INC, 'utf8').split('\n')) {
  const m = line.match(/DOM_CODE\(\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*"([^"]*)"/);
  if (!m) continue;
  table.set(m[6], { win: parseInt(m[4], 16), mac: parseInt(m[5], 16) });
}

function fromTable(domCode) {
  const e = table.get(domCode);
  if (!e) throw new Error(`DomCode not found in dom_code_data.inc: ${domCode}`);
  const extended = (e.win & 0xff00) === 0xe000;
  return {
    macKeyCode: e.mac === 0xffff ? null : e.mac,
    winScanCode: e.win === 0 ? null : (e.win & 0xff),
    winExtended: extended,
  };
}

// ---- Windows virtual keys (Microsoft Winuser.h table) ------------------
const VK = {
  BACK: 0x08, TAB: 0x09, RETURN: 0x0d, PAUSE: 0x13, CAPITAL: 0x14, ESCAPE: 0x1b,
  SPACE: 0x20, PRIOR: 0x21, NEXT: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  SNAPSHOT: 0x2c, INSERT: 0x2d, DELETE: 0x2e,
  LWIN: 0x5b, RWIN: 0x5c, APPS: 0x5d,
  NUMPAD0: 0x60, MULTIPLY: 0x6a, ADD: 0x6b, SUBTRACT: 0x6d, DECIMAL: 0x6e, DIVIDE: 0x6f,
  F1: 0x70, NUMLOCK: 0x90, SCROLL: 0x91,
  LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5,
  OEM_1: 0xba, OEM_PLUS: 0xbb, OEM_COMMA: 0xbc, OEM_MINUS: 0xbd, OEM_PERIOD: 0xbe,
  OEM_2: 0xbf, OEM_3: 0xc0, OEM_4: 0xdb, OEM_5: 0xdc, OEM_6: 0xdd, OEM_7: 0xde,
};

const keys = [];
function K(o) {
  const t = o.domCode ? fromTable(o.domCode) : {};
  const key = {
    id: o.id,
    label: o.label,
    subLabel: o.subLabel ?? null,
    macLabel: o.macLabel ?? null,
    winLabel: o.winLabel ?? null,
    section: o.section,
    row: o.row,
    unitWidth: o.unitWidth ?? 1,
    unitHeight: o.unitHeight ?? 1,
    macKeyCode: 'macKeyCode' in o ? o.macKeyCode : (t.macKeyCode ?? null),
    winVirtualKey: 'winVirtualKey' in o ? o.winVirtualKey : null,
    winScanCode: 'winScanCode' in o ? o.winScanCode : (t.winScanCode ?? null),
    winExtended: 'winExtended' in o ? o.winExtended : (t.winExtended ?? false),
    isModifier: !!o.isModifier,
    // KeyDef.holdable. False only for the three lock keys, which toggle on the
    // DOWN edge: holding them produces no sustained state, it just flips the
    // lock once (and risks the OS auto-repeating the toggle). Spec section 4.
    holdable: o.holdable ?? true,
    domCode: o.domCode ?? null,
    extra: !!o.extra,
    platformExclusive: o.platformExclusive ?? null,
    notes: o.notes ?? null,
  };
  keys.push(key);
}

// ===== FUNCTION SECTION, row 0: Esc + F1-F12 ============================
K({ id: 'key-escape', label: 'Esc', macLabel: '⎋ Esc', winLabel: 'Esc', section: 'function', row: 0,
    domCode: 'Escape', winVirtualKey: VK.ESCAPE });
for (let i = 1; i <= 12; i++) {
  K({ id: `key-f${i}`, label: `F${i}`, section: 'function', row: 0,
      domCode: `F${i}`, winVirtualKey: VK.F1 + (i - 1),
      notes: i <= 12 ? 'On Apple keyboards this key sends the F-key only when fn is held or "Use F1, F2 etc. as standard function keys" is enabled; synthesized CGEvents are unaffected by that setting.' : null });
}

// ===== FUNCTION SECTION, row 1: F13-F20 (extended / Mac-heavy) =========
for (let i = 13; i <= 20; i++) {
  K({ id: `key-f${i}`, label: `F${i}`, section: 'function', row: 1, extra: true,
      domCode: `F${i}`, winVirtualKey: VK.F1 + (i - 1),
      notes: 'Not present on a standard ANSI-104 board. Present on Apple Extended keyboards; F13/F14/F15 physically occupy the PrintScreen/ScrollLock/Pause positions on Apple layouts.' });
}

// ===== ALPHANUM row 0: number row ======================================
K({ id: 'key-backquote', label: '`', subLabel: '~', section: 'alphanum', row: 0, domCode: 'Backquote', winVirtualKey: VK.OEM_3 });
const digits = [['1','!'],['2','@'],['3','#'],['4','$'],['5','%'],['6','^'],['7','&'],['8','*'],['9','('],['0',')']];
digits.forEach(([d, sh]) => {
  K({ id: `key-${d}`, label: d, subLabel: sh, section: 'alphanum', row: 0,
      domCode: `Digit${d}`, winVirtualKey: 0x30 + Number(d) });
});
K({ id: 'key-minus', label: '-', subLabel: '_', section: 'alphanum', row: 0, domCode: 'Minus', winVirtualKey: VK.OEM_MINUS });
K({ id: 'key-equal', label: '=', subLabel: '+', section: 'alphanum', row: 0, domCode: 'Equal', winVirtualKey: VK.OEM_PLUS });
K({ id: 'key-backspace', label: 'Backspace', macLabel: '⌫ Delete', winLabel: 'Backspace', section: 'alphanum', row: 0,
    unitWidth: 2, domCode: 'Backspace', winVirtualKey: VK.BACK,
    notes: 'macOS calls this Delete (kVK_Delete 0x33). The forward-delete key is a separate entry (key-delete).' });

// ===== ALPHANUM row 1: QWERTY ==========================================
K({ id: 'key-tab', label: 'Tab', macLabel: '⇥ Tab', winLabel: 'Tab', section: 'alphanum', row: 1,
    unitWidth: 1.5, domCode: 'Tab', winVirtualKey: VK.TAB });
for (const c of 'QWERTYUIOP') {
  K({ id: `key-${c.toLowerCase()}`, label: c, section: 'alphanum', row: 1,
      domCode: `Key${c}`, winVirtualKey: c.charCodeAt(0) });
}
K({ id: 'key-bracket-left', label: '[', subLabel: '{', section: 'alphanum', row: 1, domCode: 'BracketLeft', winVirtualKey: VK.OEM_4 });
K({ id: 'key-bracket-right', label: ']', subLabel: '}', section: 'alphanum', row: 1, domCode: 'BracketRight', winVirtualKey: VK.OEM_6 });
K({ id: 'key-backslash', label: '\\', subLabel: '|', section: 'alphanum', row: 1, unitWidth: 1.5, domCode: 'Backslash', winVirtualKey: VK.OEM_5 });

// ===== ALPHANUM row 2: home row ========================================
K({ id: 'key-caps-lock', label: 'Caps Lock', macLabel: '⇪ Caps Lock', winLabel: 'Caps Lock', section: 'alphanum', row: 2,
    unitWidth: 1.75, domCode: 'CapsLock', winVirtualKey: VK.CAPITAL, holdable: false,
    notes: 'A lock key: holding it down does not produce a sustained state, it toggles LED state on the down edge. Not recommended for hold-mode.' });
for (const c of 'ASDFGHJKL') {
  K({ id: `key-${c.toLowerCase()}`, label: c, section: 'alphanum', row: 2,
      domCode: `Key${c}`, winVirtualKey: c.charCodeAt(0) });
}
K({ id: 'key-semicolon', label: ';', subLabel: ':', section: 'alphanum', row: 2, domCode: 'Semicolon', winVirtualKey: VK.OEM_1 });
K({ id: 'key-quote', label: "'", subLabel: '"', section: 'alphanum', row: 2, domCode: 'Quote', winVirtualKey: VK.OEM_7 });
K({ id: 'key-enter', label: 'Enter', macLabel: 'Return', winLabel: 'Enter', section: 'alphanum', row: 2,
    unitWidth: 2.25, domCode: 'Enter', winVirtualKey: VK.RETURN });

// ===== ALPHANUM row 3: bottom letter row ===============================
K({ id: 'key-left-shift', label: 'Shift', macLabel: '⇧ Shift', winLabel: 'Shift', section: 'alphanum', row: 3,
    unitWidth: 2.25, domCode: 'ShiftLeft', winVirtualKey: VK.LSHIFT, isModifier: true });
for (const c of 'ZXCVBNM') {
  K({ id: `key-${c.toLowerCase()}`, label: c, section: 'alphanum', row: 3,
      domCode: `Key${c}`, winVirtualKey: c.charCodeAt(0) });
}
K({ id: 'key-comma', label: ',', subLabel: '<', section: 'alphanum', row: 3, domCode: 'Comma', winVirtualKey: VK.OEM_COMMA });
K({ id: 'key-period', label: '.', subLabel: '>', section: 'alphanum', row: 3, domCode: 'Period', winVirtualKey: VK.OEM_PERIOD });
K({ id: 'key-slash', label: '/', subLabel: '?', section: 'alphanum', row: 3, domCode: 'Slash', winVirtualKey: VK.OEM_2 });
K({ id: 'key-right-shift', label: 'Shift', macLabel: '⇧ Shift', winLabel: 'Shift', section: 'alphanum', row: 3,
    unitWidth: 2.75, domCode: 'ShiftRight', winVirtualKey: VK.RSHIFT, isModifier: true });

// ===== ALPHANUM row 4: modifier / space row ============================
const MODNOTE = 'macOS delivers modifier state via kCGEventFlagsChanged, not KeyDown/KeyUp. To hold this key the app must post a flagsChanged event with the correct CGEventFlags mask AND the correct keycode, and keep re-asserting the mask on every subsequent synthetic event.';
K({ id: 'key-left-ctrl', label: 'Ctrl', macLabel: '⌃ Control', winLabel: 'Ctrl', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'ControlLeft', winVirtualKey: VK.LCONTROL, isModifier: true, notes: MODNOTE });
K({ id: 'key-left-meta', label: 'Meta', macLabel: '⌘ Command', winLabel: 'Win', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'MetaLeft', winVirtualKey: VK.LWIN, isModifier: true, notes: MODNOTE });
K({ id: 'key-left-alt', label: 'Alt', macLabel: '⌥ Option', winLabel: 'Alt', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'AltLeft', winVirtualKey: VK.LMENU, isModifier: true, notes: MODNOTE });
K({ id: 'key-space', label: 'Space', section: 'alphanum', row: 4, unitWidth: 6.25, domCode: 'Space', winVirtualKey: VK.SPACE });
K({ id: 'key-right-alt', label: 'Alt', macLabel: '⌥ Option', winLabel: 'Alt', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'AltRight', winVirtualKey: VK.RMENU, isModifier: true, notes: MODNOTE });
K({ id: 'key-right-meta', label: 'Meta', macLabel: '⌘ Command', winLabel: 'Win', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'MetaRight', winVirtualKey: VK.RWIN, isModifier: true, notes: MODNOTE });
K({ id: 'key-menu', label: 'Menu', macLabel: 'Menu', winLabel: 'Menu', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'ContextMenu', winVirtualKey: VK.APPS,
    notes: 'No physical equivalent on Apple keyboards, but kVK_ContextualMenu (0x6E) exists and can be synthesized.' });
K({ id: 'key-right-ctrl', label: 'Ctrl', macLabel: '⌃ Control', winLabel: 'Ctrl', section: 'alphanum', row: 4,
    unitWidth: 1.25, domCode: 'ControlRight', winVirtualKey: VK.RCONTROL, isModifier: true, notes: MODNOTE });

// ===== NAVIGATION ======================================================
K({ id: 'key-print-screen', label: 'PrtSc', winLabel: 'Print Screen', section: 'navigation', row: 0,
    domCode: 'PrintScreen', winVirtualKey: VK.SNAPSHOT, platformExclusive: 'win',
    notes: 'No macOS keycode. On Apple Extended layouts this physical position is F13. Windows: real hardware sends E0 2A E0 37; MapVirtualKey(VK_SNAPSHOT, MAPVK_VK_TO_VSC) returns 0x54 (SysReq) on many systems, so prefer VK-based SendInput over scancode injection here.' });
K({ id: 'key-scroll-lock', label: 'ScrLk', winLabel: 'Scroll Lock', section: 'navigation', row: 0,
    domCode: 'ScrollLock', winVirtualKey: VK.SCROLL, platformExclusive: 'win', holdable: false,
    notes: 'No macOS keycode. On Apple Extended layouts this physical position is F14. Lock key: not meaningful to hold.' });
K({ id: 'key-pause', label: 'Pause', subLabel: 'Break', winLabel: 'Pause', section: 'navigation', row: 0,
    domCode: 'Pause', winVirtualKey: VK.PAUSE, platformExclusive: 'win',
    notes: 'No macOS keycode. On Apple Extended layouts this physical position is F15. Real hardware sends the E1 1D 45 prefixed sequence which SendInput cannot express; use VK-based injection.' });
K({ id: 'key-insert', label: 'Insert', macLabel: 'Help', winLabel: 'Insert', section: 'navigation', row: 1,
    domCode: 'Insert', winVirtualKey: VK.INSERT,
    notes: 'macOS has no Insert. This physical position is Help on the Apple Extended Keyboard; kVK_Help = 0x72 is the correct Mac keycode.' });
K({ id: 'key-home', label: 'Home', section: 'navigation', row: 1, domCode: 'Home', winVirtualKey: VK.HOME });
K({ id: 'key-page-up', label: 'Page Up', subLabel: 'PgUp', section: 'navigation', row: 1, domCode: 'PageUp', winVirtualKey: VK.PRIOR });
K({ id: 'key-delete', label: 'Delete', macLabel: '⌦ Delete', winLabel: 'Delete', section: 'navigation', row: 2,
    domCode: 'Delete', winVirtualKey: VK.DELETE,
    notes: 'Forward delete. macOS kVK_ForwardDelete = 0x75. Distinct from Backspace (key-backspace).' });
K({ id: 'key-end', label: 'End', section: 'navigation', row: 2, domCode: 'End', winVirtualKey: VK.END });
K({ id: 'key-page-down', label: 'Page Down', subLabel: 'PgDn', section: 'navigation', row: 2, domCode: 'PageDown', winVirtualKey: VK.NEXT });
K({ id: 'arrow-up', label: '↑', section: 'navigation', row: 3, domCode: 'ArrowUp', winVirtualKey: VK.UP });
K({ id: 'arrow-left', label: '←', section: 'navigation', row: 4, domCode: 'ArrowLeft', winVirtualKey: VK.LEFT });
K({ id: 'arrow-down', label: '↓', section: 'navigation', row: 4, domCode: 'ArrowDown', winVirtualKey: VK.DOWN });
K({ id: 'arrow-right', label: '→', section: 'navigation', row: 4, domCode: 'ArrowRight', winVirtualKey: VK.RIGHT });
K({ id: 'key-fn', label: 'fn', macLabel: 'fn', section: 'navigation', row: 5, extra: true, platformExclusive: 'mac',
    domCode: 'Fn', macKeyCode: 0x3f, winVirtualKey: null, winScanCode: null, winExtended: false, isModifier: true,
    notes: 'kVK_Function = 0x3F from HIToolbox/Events.h. The fn key is handled below the CGEvent layer on Apple hardware and is very likely NOT injectable via CGEventPost - needs supervised human test before exposing in the UI.' });

// ===== NUMPAD ==========================================================
K({ id: 'numpad-num-lock', label: 'Num Lock', macLabel: 'Clear', winLabel: 'Num Lock', section: 'numpad', row: 0,
    domCode: 'NumLock', winVirtualKey: VK.NUMLOCK, holdable: false,
    notes: 'Same physical position as Clear on Apple numpads; kVK_ANSI_KeypadClear = 0x47. Windows scancode 0x45 collides with Pause; the extended flag is what disambiguates NumLock from Pause when injecting scancodes. Lock key: not meaningful to hold.' });
K({ id: 'numpad-divide', label: '/', section: 'numpad', row: 0, domCode: 'NumpadDivide', winVirtualKey: VK.DIVIDE });
K({ id: 'numpad-multiply', label: '*', section: 'numpad', row: 0, domCode: 'NumpadMultiply', winVirtualKey: VK.MULTIPLY });
K({ id: 'numpad-subtract', label: '-', section: 'numpad', row: 0, domCode: 'NumpadSubtract', winVirtualKey: VK.SUBTRACT });

const padNav = { 7: 'Home', 8: '↑', 9: 'PgUp', 4: '←', 5: null, 6: '→', 1: 'End', 2: '↓', 3: 'PgDn' };
for (const n of [7, 8, 9]) K({ id: `numpad-${n}`, label: String(n), subLabel: padNav[n], section: 'numpad', row: 1, domCode: `Numpad${n}`, winVirtualKey: VK.NUMPAD0 + n });
K({ id: 'numpad-add', label: '+', section: 'numpad', row: 1, unitHeight: 2, domCode: 'NumpadAdd', winVirtualKey: VK.ADD });
for (const n of [4, 5, 6]) K({ id: `numpad-${n}`, label: String(n), subLabel: padNav[n], section: 'numpad', row: 2, domCode: `Numpad${n}`, winVirtualKey: VK.NUMPAD0 + n });
for (const n of [1, 2, 3]) K({ id: `numpad-${n}`, label: String(n), subLabel: padNav[n], section: 'numpad', row: 3, domCode: `Numpad${n}`, winVirtualKey: VK.NUMPAD0 + n });
K({ id: 'numpad-enter', label: 'Enter', macLabel: 'Enter', winLabel: 'Enter', section: 'numpad', row: 3, unitHeight: 2,
    domCode: 'NumpadEnter', winVirtualKey: VK.RETURN,
    notes: 'Shares VK_RETURN with the main Enter key on Windows; the KEYEVENTF_EXTENDEDKEY flag plus scancode 0x1C is what distinguishes it. macOS has a genuinely distinct keycode (kVK_ANSI_KeypadEnter = 0x4C).' });
K({ id: 'numpad-0', label: '0', subLabel: 'Ins', section: 'numpad', row: 4, unitWidth: 2, domCode: 'Numpad0', winVirtualKey: VK.NUMPAD0 });
K({ id: 'numpad-decimal', label: '.', subLabel: 'Del', section: 'numpad', row: 4, domCode: 'NumpadDecimal', winVirtualKey: VK.DECIMAL });
K({ id: 'numpad-equals', label: '=', section: 'numpad', row: 5, extra: true, platformExclusive: 'mac',
    domCode: 'NumpadEqual', winVirtualKey: null,
    notes: 'Apple numpads carry = where a PC numpad has Num Lock. Windows has no standard virtual key for keypad-equals (VK_OEM_NEC_EQUAL 0x92 is NEC PC-98 only), so winVirtualKey is null; scancode 0x59 is still valid for scancode-based injection.' });

// ===== MOUSE ===========================================================
// CGEventType / CGMouseButton values verified by compiling against
// ApplicationServices on macOS 26.6 (see notes in layout-notes.md).
const CG = { LDOWN: 1, LUP: 2, RDOWN: 3, RUP: 4, ODOWN: 25, OUP: 26, SCROLL: 22 };
const MEF = { LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
              MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, XDOWN: 0x0080, XUP: 0x0100, WHEEL: 0x0800, HWHEEL: 0x1000 };

// MouseDef field names are contract-locked in src/shared/types.ts:
// id / label / description / holdable / macButton / macDownType / macUpType /
// winFlagDown / winFlagUp / winMouseData. The macDraggedType, *Constant and
// repeatIntervalMsDefault fields are extra provenance the injector and UI read
// through data/mouse.json directly; they are not part of MouseDef.
const mouse = [
  { id: 'left', label: 'Left Button', description: 'Primary mouse button.',
    macButton: 0, macButtonConstant: 'kCGMouseButtonLeft',
    macDownType: CG.LDOWN, macUpType: CG.LUP, macDraggedType: 6,
    macDownTypeConstant: 'kCGEventLeftMouseDown', macUpTypeConstant: 'kCGEventLeftMouseUp',
    winFlagDown: MEF.LEFTDOWN, winFlagUp: MEF.LEFTUP, winMouseData: 0,
    holdable: true, notes: null },
  { id: 'right', label: 'Right Button', description: 'Secondary mouse button / context menu.',
    macButton: 1, macButtonConstant: 'kCGMouseButtonRight',
    macDownType: CG.RDOWN, macUpType: CG.RUP, macDraggedType: 7,
    macDownTypeConstant: 'kCGEventRightMouseDown', macUpTypeConstant: 'kCGEventRightMouseUp',
    winFlagDown: MEF.RIGHTDOWN, winFlagUp: MEF.RIGHTUP, winMouseData: 0,
    holdable: true, notes: null },
  { id: 'middle', label: 'Middle Button', description: 'Scroll-wheel click.',
    macButton: 2, macButtonConstant: 'kCGMouseButtonCenter',
    macDownType: CG.ODOWN, macUpType: CG.OUP, macDraggedType: 27,
    macDownTypeConstant: 'kCGEventOtherMouseDown', macUpTypeConstant: 'kCGEventOtherMouseUp',
    winFlagDown: MEF.MIDDLEDOWN, winFlagUp: MEF.MIDDLEUP, winMouseData: 0,
    holdable: true,
    notes: 'Middle and above use kCGEventOtherMouseDown/Up; the button index must be written into the event with CGEventSetIntegerValueField(ev, kCGMouseEventButtonNumber, n).' },
  { id: 'back', label: 'Back (Button 4)', description: 'Thumb button, browser Back.',
    macButton: 3, macButtonConstant: 'kCGMouseButtonCenter + 1 (button number 3)',
    macDownType: CG.ODOWN, macUpType: CG.OUP, macDraggedType: 27,
    macDownTypeConstant: 'kCGEventOtherMouseDown', macUpTypeConstant: 'kCGEventOtherMouseUp',
    winFlagDown: MEF.XDOWN, winFlagUp: MEF.XUP, winMouseData: 1,
    holdable: true,
    notes: 'Windows: XBUTTON1 = 0x0001 goes in MOUSEINPUT.mouseData alongside MOUSEEVENTF_XDOWN/XUP. macOS: kCGEventOtherMouseDown with kCGMouseEventButtonNumber = 3.' },
  { id: 'forward', label: 'Forward (Button 5)', description: 'Thumb button, browser Forward.',
    macButton: 4, macButtonConstant: 'kCGMouseButtonCenter + 2 (button number 4)',
    macDownType: CG.ODOWN, macUpType: CG.OUP, macDraggedType: 27,
    macDownTypeConstant: 'kCGEventOtherMouseDown', macUpTypeConstant: 'kCGEventOtherMouseUp',
    winFlagDown: MEF.XDOWN, winFlagUp: MEF.XUP, winMouseData: 2,
    holdable: true,
    notes: 'Windows: XBUTTON2 = 0x0002 in mouseData. macOS: button number 4.' },
  { id: 'wheel-up', label: 'Wheel Up', description: 'Scroll wheel rotated forward. NOT a holdable button.',
    macButton: null, macButtonConstant: null,
    macDownType: CG.SCROLL, macUpType: null, macDraggedType: null,
    macDownTypeConstant: 'kCGEventScrollWheel', macUpTypeConstant: null,
    winFlagDown: MEF.WHEEL, winFlagUp: null, winMouseData: 120,
    holdable: false, repeatIntervalMsDefault: 50,
    notes: 'A wheel has no held state - it emits discrete detents, so there is no down/up pair to hold. If selected, the app must emit a repeating discrete scroll at repeatIntervalMsDefault. Windows: WHEEL_DELTA = 120 per detent. macOS: CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, +1).' },
  { id: 'wheel-down', label: 'Wheel Down', description: 'Scroll wheel rotated backward. NOT a holdable button.',
    macButton: null, macButtonConstant: null,
    macDownType: CG.SCROLL, macUpType: null, macDraggedType: null,
    macDownTypeConstant: 'kCGEventScrollWheel', macUpTypeConstant: null,
    winFlagDown: MEF.WHEEL, winFlagUp: null, winMouseData: -120,
    holdable: false, repeatIntervalMsDefault: 50,
    notes: 'See the wheel-up entry. mouseData is a signed value: -120 for one detent toward the user. macOS uses delta -1.' },
];

fs.writeFileSync(path.join(here, 'keys.json'), JSON.stringify(keys, null, 2) + '\n');
fs.writeFileSync(path.join(here, 'mouse.json'), JSON.stringify(mouse, null, 2) + '\n');
console.log(`wrote ${keys.length} keys, ${mouse.length} mouse buttons`);
