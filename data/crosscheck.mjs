// Independent audit: compare every macKeyCode in keys.json against the
// kVK_* constants parsed straight out of Apple's HIToolbox/Events.h.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// This audit compares against a header that only exists inside the macOS SDK.
// On Windows and Linux CI runners there is nothing to compare against, so skip
// with a success exit code rather than failing a build for the wrong reason.
if (process.platform !== 'darwin') {
  console.log(`SKIP crosscheck: needs the macOS SDK, running on ${process.platform}.`);
  process.exit(0);
}

// Resolve the SDK at runtime. Hardcoding the Xcode.app path breaks on machines
// using the standalone Command Line Tools, and breaks again on every Xcode or
// macOS version bump that moves the SDK.
const REL = 'System/Library/Frameworks/Carbon.framework/Versions/A/Frameworks/HIToolbox.framework/Versions/A/Headers/Events.h';
let H;
try {
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  if (!sdk) throw new Error('xcrun --show-sdk-path printed nothing');
  H = path.join(sdk, REL);
} catch (err) {
  console.log(`SKIP crosscheck: could not resolve the macOS SDK (${err.message}). Install the Xcode Command Line Tools to run this audit.`);
  process.exit(0);
}
if (!fs.existsSync(H)) {
  console.log(`SKIP crosscheck: SDK resolved but ${REL} is not in it (${H}).`);
  process.exit(0);
}
const kvk = {};
for (const l of fs.readFileSync(H, 'utf8').split('\n')) {
  const m = l.match(/^\s*(kVK_\w+)\s*=\s*(0x[0-9A-Fa-f]+)/);
  if (m) kvk[m[1]] = parseInt(m[2], 16);
}
const map = { 'key-escape':'kVK_Escape','key-space':'kVK_Space','key-enter':'kVK_Return','key-tab':'kVK_Tab',
 'key-backspace':'kVK_Delete','key-delete':'kVK_ForwardDelete','key-caps-lock':'kVK_CapsLock',
 'key-left-shift':'kVK_Shift','key-right-shift':'kVK_RightShift','key-left-ctrl':'kVK_Control',
 'key-right-ctrl':'kVK_RightControl','key-left-alt':'kVK_Option','key-right-alt':'kVK_RightOption',
 'key-left-meta':'kVK_Command','key-right-meta':'kVK_RightCommand','key-menu':'kVK_ContextualMenu',
 'key-fn':'kVK_Function','key-insert':'kVK_Help','key-home':'kVK_Home','key-end':'kVK_End',
 'key-page-up':'kVK_PageUp','key-page-down':'kVK_PageDown','arrow-up':'kVK_UpArrow','arrow-down':'kVK_DownArrow',
 'arrow-left':'kVK_LeftArrow','arrow-right':'kVK_RightArrow','key-minus':'kVK_ANSI_Minus','key-equal':'kVK_ANSI_Equal',
 'key-bracket-left':'kVK_ANSI_LeftBracket','key-bracket-right':'kVK_ANSI_RightBracket','key-backslash':'kVK_ANSI_Backslash',
 'key-semicolon':'kVK_ANSI_Semicolon','key-quote':'kVK_ANSI_Quote','key-backquote':'kVK_ANSI_Grave',
 'key-comma':'kVK_ANSI_Comma','key-period':'kVK_ANSI_Period','key-slash':'kVK_ANSI_Slash',
 'numpad-num-lock':'kVK_ANSI_KeypadClear','numpad-divide':'kVK_ANSI_KeypadDivide','numpad-multiply':'kVK_ANSI_KeypadMultiply',
 'numpad-subtract':'kVK_ANSI_KeypadMinus','numpad-add':'kVK_ANSI_KeypadPlus','numpad-enter':'kVK_ANSI_KeypadEnter',
 'numpad-decimal':'kVK_ANSI_KeypadDecimal','numpad-equals':'kVK_ANSI_KeypadEquals' };
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') map[`key-${c.toLowerCase()}`] = `kVK_ANSI_${c}`;
for (const d of '0123456789') map[`key-${d}`] = `kVK_ANSI_${d}`;
for (let i=0;i<=9;i++) map[`numpad-${i}`] = `kVK_ANSI_Keypad${i}`;
for (let i=1;i<=20;i++) map[`key-f${i}`] = `kVK_F${i}`;

const keys = JSON.parse(fs.readFileSync(path.join(here, 'keys.json'), 'utf8'));
const byId = Object.fromEntries(keys.map(k=>[k.id,k]));
let bad=0, n=0, nulls=[];
for (const [id, name] of Object.entries(map)) {
  const k = byId[id];
  if (!k) { console.log(`MISSING KEY ${id}`); bad++; continue; }
  if (!(name in kvk)) { console.log(`MISSING CONSTANT ${name}`); bad++; continue; }
  n++;
  if (k.macKeyCode !== kvk[name]) { console.log(`MISMATCH ${id}: json=${k.macKeyCode} ${name}=${kvk[name]}`); bad++; }
}
for (const k of keys) if (k.macKeyCode === null) nulls.push(k.id);
console.log(`\nCross-checked ${n} macKeyCodes directly against Events.h -> ${bad} mismatches`);
console.log(`Keys with macKeyCode=null (${nulls.length}): ${nulls.join(', ')}`);
process.exit(bad?1:0);
