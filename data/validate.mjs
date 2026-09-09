import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

let fails = 0, checks = 0;
const fail = (m) => { fails++; console.log('  FAIL: ' + m); };
const ok = (m) => console.log('  ok  : ' + m);
function check(cond, msg) { checks++; if (cond) { ok(msg); } else { fail(msg); } }

const keys = JSON.parse(fs.readFileSync(path.join(here, 'keys.json'), 'utf8'));
const mouse = JSON.parse(fs.readFileSync(path.join(here, 'mouse.json'), 'utf8'));

console.log('=== keys.json ===');
check(Array.isArray(keys), 'top level is an array');
check(keys.length === 114, `key count is 114 (got ${keys.length})`);

const SECTIONS = new Set(['function', 'alphanum', 'navigation', 'numpad']);
const isInt = (v) => Number.isInteger(v);
const isNullOrInt = (v) => v === null || Number.isInteger(v);
const isNullOrStr = (v) => v === null || typeof v === 'string';

let typeErrors = 0;
for (const k of keys) {
  const e = [];
  if (typeof k.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(k.id)) e.push('id not kebab-case string');
  if (typeof k.label !== 'string' || !k.label.length) e.push('label');
  if (!isNullOrStr(k.subLabel)) e.push('subLabel');
  if (!isNullOrStr(k.macLabel)) e.push('macLabel');
  if (!isNullOrStr(k.winLabel)) e.push('winLabel');
  if (!SECTIONS.has(k.section)) e.push('section');
  if (!isInt(k.row) || k.row < 0) e.push('row');
  if (typeof k.unitWidth !== 'number' || k.unitWidth <= 0) e.push('unitWidth');
  if (typeof k.unitHeight !== 'number' || k.unitHeight <= 0) e.push('unitHeight');
  if (!isNullOrInt(k.macKeyCode)) e.push('macKeyCode');
  if (!isNullOrInt(k.winVirtualKey)) e.push('winVirtualKey');
  if (!isNullOrInt(k.winScanCode)) e.push('winScanCode');
  if (typeof k.winExtended !== 'boolean') e.push('winExtended');
  if (typeof k.isModifier !== 'boolean') e.push('isModifier');
  if (typeof k.holdable !== 'boolean') e.push('holdable');
  if (!isNullOrStr(k.notes)) e.push('notes');
  if (k.macKeyCode !== null && (k.macKeyCode < 0 || k.macKeyCode > 0x7f)) e.push('macKeyCode out of CGKeyCode range');
  if (k.winVirtualKey !== null && (k.winVirtualKey < 1 || k.winVirtualKey > 0xfe)) e.push('winVirtualKey out of range');
  if (k.macKeyCode === null && k.winVirtualKey === null) e.push('key is unusable on both platforms');
  if (e.length) { typeErrors++; fail(`${k.id}: ${e.join(', ')}`); }
}
check(typeErrors === 0, `all ${keys.length} entries have required fields with correct types`);

// holdable: only the three lock keys are non-holdable. They toggle on the DOWN
// edge, so holding them produces no sustained state (spec section 4).
const NON_HOLDABLE = ['key-caps-lock', 'key-scroll-lock', 'numpad-num-lock'];
const notHoldable = keys.filter(k => !k.holdable).map(k => k.id).sort();
check(JSON.stringify(notHoldable) === JSON.stringify([...NON_HOLDABLE].sort()),
  `exactly the three lock keys are holdable:false (got ${notHoldable.join(', ') || 'none'})`);

// duplicate ids
const ids = keys.map(k => k.id);
const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
check(dupIds.length === 0, `no duplicate ids${dupIds.length ? ' -> ' + [...new Set(dupIds)].join(', ') : ''}`);

// uniqueness of platform codes
function uniq(field) {
  const seen = new Map(), dups = [];
  for (const k of keys) {
    const v = k[field];
    if (v === null) continue;
    if (seen.has(v)) dups.push(`0x${v.toString(16)} shared by ${seen.get(v)} and ${k.id}`);
    else seen.set(v, k.id);
  }
  return dups;
}
const dm = uniq('macKeyCode');
check(dm.length === 0, `every non-null macKeyCode is unique${dm.length ? '\n         ' + dm.join('\n         ') : ''}`);
// Windows genuinely aliases some VKs across two physical keys; the pair is
// disambiguated by KEYEVENTF_EXTENDEDKEY + scancode, not by the VK. Any
// collision outside this documented allowlist is a data error.
const VK_ALIAS_ALLOWED = [['key-enter', 'numpad-enter']];
const dvRaw = uniq('winVirtualKey');
const allowed = new Set(VK_ALIAS_ALLOWED.map(p => p.slice().sort().join('|')));
const dv = dvRaw.filter(d => {
  const m = d.match(/shared by (\S+) and (\S+)/);
  return !(m && allowed.has([m[1], m[2]].sort().join('|')));
});
check(dv.length === 0, `winVirtualKey collisions limited to documented Windows aliases${dv.length ? '\n         ' + dv.join('\n         ') : ''}`);
check(dvRaw.length === VK_ALIAS_ALLOWED.length, `exactly ${VK_ALIAS_ALLOWED.length} known VK alias pair (Enter / numpad Enter share VK_RETURN by design)`);

// what MUST be unique for injection to be unambiguous:
const seenTriple = new Map(); const tripleDups = [];
for (const k of keys) {
  if (k.winVirtualKey === null) continue;
  const t = `${k.winVirtualKey}|${k.winExtended}|${k.winScanCode}`;
  if (seenTriple.has(t)) tripleDups.push(`${seenTriple.get(t)} vs ${k.id} (${t})`);
  else seenTriple.set(t, k.id);
}
check(tripleDups.length === 0, `every (winVirtualKey, winExtended, winScanCode) triple is unique${tripleDups.length ? ' -> ' + tripleDups.join('; ') : ''}`);

// ---------------------------------------------------------------------------
// Scan-code INJECTION identity.
//
// winScanCode + winExtended describe what goes into SendInput, not what Windows
// reports in a WM_KEYDOWN lParam. With KEYEVENTF_SCANCODE the wVk field is ignored
// entirely, so the (winScanCode, winExtended) pair IS the key as far as the target
// app is concerned. Two keys sharing that pair means one of them injects as the
// other. See PAUSE_NUMLOCK_NOTE in data/generate.mjs.
//
// Keys with winScanCode null are excluded: they have no scancode identity and
// encodeKey() sends them by virtual key instead.
const seenScan = new Map(); const scanDups = [];
for (const k of keys) {
  if (k.winScanCode === null) continue;
  if (k.winVirtualKey === null) continue; // not injectable on Windows at all
  const pair = `0x${k.winScanCode.toString(16).padStart(2, '0')}|${k.winExtended ? 'E0' : 'bare'}`;
  if (seenScan.has(pair)) scanDups.push(`${seenScan.get(pair)} vs ${k.id} (${pair})`);
  else seenScan.set(pair, k.id);
}
check(scanDups.length === 0,
  `every (winScanCode, winExtended) pair is unique, so no key injects as another${scanDups.length ? ' -> ' + scanDups.join('; ') : ''}`);

// The Pause / Num Lock pair, pinned by hand because getting it backwards is silent
// and user-visible: a bare Set-1 scan code 0x45 is VK_NUMLOCK, so a Pause injected
// as 0x45 toggles the user's Num Lock instead (roughly ten times a second in tap
// mode). Chromium's dom_code_data.inc records the values Windows REPORTS
// (Pause 0x0045, NumLock 0xE045); these are the values SendInput ACCEPTS.
const find = (id) => keys.find(k => k.id === id) ?? {};
const pause = find('key-pause'), numLock = find('numpad-num-lock');
check(pause.winScanCode === null,
  `key-pause has winScanCode null so encodeKey takes the virtual-key path (bare 0x45 would be Num Lock, got ${pause.winScanCode})`);
check(pause.winVirtualKey === 0x13,
  `key-pause carries VK_PAUSE 0x13, the only form of Pause SendInput can express (got ${pause.winVirtualKey})`);
check(numLock.winScanCode === 0x45 && numLock.winExtended === false,
  `numpad-num-lock injects as bare scan 0x45 with no extended flag; 0xE0 0x45 has no entry in the E0 table and would do nothing (got 0x${(numLock.winScanCode ?? 0).toString(16)} / extended=${numLock.winExtended})`);
check(numLock.winVirtualKey === 0x90,
  `numpad-num-lock carries VK_NUMLOCK 0x90 (got ${numLock.winVirtualKey})`);

// base ANSI-104 must be exactly 104 keys
const base = keys.filter(k => !k.extra);
check(base.length === 104, `base (non-extra) set is exactly 104 keys (got ${base.length})`);

// geometry: each alphanum row must total 15u; function row 15u incl. gaps
const ROWSUM = { alphanum: [15, 15, 15, 15, 15] };
for (const [sec, expected] of Object.entries(ROWSUM)) {
  expected.forEach((want, row) => {
    const got = base.filter(k => k.section === sec && k.row === row).reduce((a, k) => a + k.unitWidth, 0);
    check(Math.abs(got - want) < 1e-9, `${sec} row ${row} sums to ${want}u (got ${got}u)`);
  });
}
const fnRow = base.filter(k => k.section === 'function' && k.row === 0);
check(fnRow.length === 13, `function row 0 has 13 keys, Esc + F1-F12 (got ${fnRow.length})`);
const fnW = fnRow.reduce((a, k) => a + k.unitWidth, 0);
check(fnW + 2 === 15, `function row 0: ${fnW}u of keys + 2u of gaps = 15u`);

// numpad rows
const npRow = (r) => base.filter(k => k.section === 'numpad' && k.row === r);
check(npRow(0).reduce((a, k) => a + k.unitWidth, 0) === 4, 'numpad row 0 spans 4u');
check(npRow(4).reduce((a, k) => a + k.unitWidth, 0) === 3, 'numpad row 4 spans 3u (0 is 2u wide, . is 1u; + and Enter overhang from above)');
const tall = keys.filter(k => k.unitHeight === 2).map(k => k.id).sort();
check(JSON.stringify(tall) === JSON.stringify(['numpad-add', 'numpad-enter']), `exactly numpad-add and numpad-enter are 2u tall (got ${tall.join(', ')})`);

// navigation cluster
for (const r of [0, 1, 2]) check(base.filter(k => k.section === 'navigation' && k.row === r).length === 3, `navigation row ${r} has 3 keys`);
check(base.filter(k => k.section === 'navigation' && k.row === 3).length === 1, 'navigation row 3 has 1 key (Up arrow)');
check(base.filter(k => k.section === 'navigation' && k.row === 4).length === 3, 'navigation row 4 has 3 keys (Left/Down/Right)');

// required coverage
const need = ['key-escape','key-space','key-enter','key-backspace','key-tab','key-caps-lock','key-menu',
  'key-left-shift','key-right-shift','key-left-ctrl','key-right-ctrl','key-left-alt','key-right-alt',
  'key-left-meta','key-right-meta','key-print-screen','key-scroll-lock','key-pause','key-insert','key-home',
  'key-page-up','key-delete','key-end','key-page-down','arrow-up','arrow-down','arrow-left','arrow-right',
  'numpad-num-lock','numpad-divide','numpad-multiply','numpad-subtract','numpad-add','numpad-enter','numpad-decimal'];
for (let i = 0; i <= 9; i++) need.push(`numpad-${i}`);
for (let i = 1; i <= 20; i++) need.push(`key-f${i}`);
for (const c of 'abcdefghijklmnopqrstuvwxyz') need.push(`key-${c}`);
for (const d of '0123456789') need.push(`key-${d}`);
const missing = need.filter(n => !ids.includes(n));
check(missing.length === 0, `all ${need.length} required key ids present${missing.length ? ' -> missing ' + missing.join(', ') : ''}`);

// spot-check against Apple Events.h values quoted in the brief
const EXPECT_MAC = { 'key-a': 0x00, 'key-enter': 0x24, 'key-space': 0x31, 'key-escape': 0x35,
  'key-left-meta': 0x37, 'key-right-meta': 0x36, 'key-left-shift': 0x38, 'key-right-shift': 0x3c,
  'key-left-ctrl': 0x3b, 'key-right-ctrl': 0x3e, 'key-left-alt': 0x3a, 'key-right-alt': 0x3d,
  'key-f1': 0x7a, 'key-f13': 0x69, 'key-f20': 0x5a, 'numpad-0': 0x52, 'numpad-enter': 0x4c,
  'key-backspace': 0x33, 'key-delete': 0x75, 'key-caps-lock': 0x39 };
const byId = Object.fromEntries(keys.map(k => [k.id, k]));
const macBad = Object.entries(EXPECT_MAC).filter(([id, v]) => byId[id].macKeyCode !== v)
  .map(([id, v]) => `${id} expected 0x${v.toString(16)} got ${byId[id].macKeyCode}`);
check(macBad.length === 0, `macKeyCode spot-checks match HIToolbox/Events.h${macBad.length ? ' -> ' + macBad.join('; ') : ''}`);

const EXPECT_VK = { 'key-a': 0x41, 'key-0': 0x30, 'key-enter': 0x0d, 'key-space': 0x20, 'key-escape': 0x1b,
  'key-left-shift': 0xa0, 'key-right-shift': 0xa1, 'key-left-ctrl': 0xa2, 'key-right-ctrl': 0xa3,
  'key-left-alt': 0xa4, 'key-right-alt': 0xa5, 'key-left-meta': 0x5b, 'key-right-meta': 0x5c,
  'key-menu': 0x5d, 'key-f1': 0x70, 'key-f24': undefined, 'numpad-0': 0x60, 'numpad-9': 0x69,
  'numpad-num-lock': 0x90, 'key-scroll-lock': 0x91, 'key-pause': 0x13, 'key-print-screen': 0x2c };
const vkBad = Object.entries(EXPECT_VK).filter(([id, v]) => v !== undefined && byId[id].winVirtualKey !== v)
  .map(([id, v]) => `${id} expected 0x${v.toString(16)} got ${byId[id].winVirtualKey}`);
check(vkBad.length === 0, `winVirtualKey spot-checks match Microsoft Winuser.h${vkBad.length ? ' -> ' + vkBad.join('; ') : ''}`);

// extended-flag sanity
const mustBeExt = ['key-insert','key-home','key-page-up','key-delete','key-end','key-page-down',
  'arrow-up','arrow-down','arrow-left','arrow-right','key-right-ctrl','key-right-alt',
  'key-left-meta','key-right-meta','key-menu','numpad-divide','numpad-enter'];
const extBad = mustBeExt.filter(id => byId[id].winExtended !== true);
check(extBad.length === 0, `all E0-prefixed keys have winExtended=true${extBad.length ? ' -> ' + extBad.join(', ') : ''}`);
// numpad-num-lock is in this list on purpose: Windows REPORTS it as 0xE045 (kbdus
// tags ausVK[0x45] with KBDEXT), but the E0 scan-code table has no 0x45 entry, so
// injecting it extended resolves to no virtual key. See PAUSE_NUMLOCK_NOTE.
const mustNotBeExt = ['key-right-shift','numpad-multiply','numpad-add','numpad-subtract','key-a','numpad-0','numpad-num-lock'];
const extBad2 = mustNotBeExt.filter(id => byId[id].winExtended !== false);
check(extBad2.length === 0, `non-extended keys have winExtended=false${extBad2.length ? ' -> ' + extBad2.join(', ') : ''}`);

console.log('\n=== mouse.json ===');
check(Array.isArray(mouse), 'top level is an array');
const mids = mouse.map(m => m.id);
check(new Set(mids).size === mids.length, 'no duplicate mouse ids');
// ids are the MouseButtonId union in src/shared/types.ts, exactly and in order.
const MOUSE_BUTTON_IDS = ['left', 'right', 'middle', 'back', 'forward', 'wheel-up', 'wheel-down'];
check(JSON.stringify(mids) === JSON.stringify(MOUSE_BUTTON_IDS),
  `mouse ids are exactly the MouseButtonId union, in order (got ${mids.join(', ')})`);
let mErr = 0;
for (const m of mouse) {
  const e = [];
  if (typeof m.id !== 'string') e.push('id');
  if (typeof m.label !== 'string') e.push('label');
  if (typeof m.description !== 'string' || !m.description.length) e.push('description');
  if (!isNullOrInt(m.macButton)) e.push('macButton');
  if (!isNullOrInt(m.macDownType)) e.push('macDownType');
  if (!isNullOrInt(m.macUpType)) e.push('macUpType');
  if (!isNullOrInt(m.winFlagDown)) e.push('winFlagDown');
  if (!isNullOrInt(m.winFlagUp)) e.push('winFlagUp');
  if (!isInt(m.winMouseData)) e.push('winMouseData');
  if (typeof m.holdable !== 'boolean') e.push('holdable');
  if (e.length) { mErr++; fail(`${m.id}: ${e.join(', ')}`); }
}
check(mErr === 0, `all ${mouse.length} mouse entries have required fields with correct types`);
const holdables = mouse.filter(m => m.holdable);
check(holdables.length === 5, `exactly 5 holdable buttons: left, right, middle, back, forward (got ${holdables.length})`);
check(holdables.every(m => m.winFlagUp !== null && m.macUpType !== null),
  'every holdable button has a real up-flag / up-event (a press can always be released)');
check(mouse.filter(m => !m.holdable).every(m => typeof m.repeatIntervalMsDefault === 'number'),
  'every non-holdable (wheel) entry carries a repeatIntervalMsDefault');
const xb = mouse.filter(m => m.winFlagDown === 0x0080);
check(xb.length === 2 && xb.map(m => m.winMouseData).sort().join() === '1,2',
  'back/forward use MOUSEEVENTF_XDOWN with mouseData XBUTTON1=1 / XBUTTON2=2');
const macBtns = mouse.filter(m => m.macButton !== null).map(m => m.macButton);
check(new Set(macBtns).size === macBtns.length && macBtns.join() === '0,1,2,3,4',
  'mac button numbers are 0,1,2,3,4 and unique');

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: ${checks - fails}/${checks} checks passed.`);
process.exit(fails === 0 ? 0 : 1);
