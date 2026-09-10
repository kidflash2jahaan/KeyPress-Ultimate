"use strict";
const electron = require("electron");
const keys = require("./chunks/keys-ITOzOraM.js");
const index = require("./chunks/index-pPLmakq_.js");
const nodeFsModule = require("node:fs");
const node_os = require("node:os");
const nodePath = require("node:path");
const node_child_process = require("node:child_process");
const node_crypto = require("node:crypto");
const fsp = require("node:fs/promises");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const nodeFsModule__namespace = /* @__PURE__ */ _interopNamespaceDefault(nodeFsModule);
const nodePath__namespace = /* @__PURE__ */ _interopNamespaceDefault(nodePath);
const fsp__namespace = /* @__PURE__ */ _interopNamespaceDefault(fsp);
const DEFAULT_APP_LIST_TTL_MS = 1500;
function normalizeIdentity(identity) {
  return identity.trim().toLowerCase();
}
function byName(a, b) {
  return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
}
function createAppRegistry(deps) {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_APP_LIST_TTL_MS;
  const selfIdentity = deps.selfIdentity === void 0 || deps.selfIdentity === null ? null : normalizeIdentity(deps.selfIdentity);
  const selfPids = new Set(deps.selfPids ?? []);
  let entries = [];
  let pidsByIdentity = /* @__PURE__ */ new Map();
  let identityByPid = /* @__PURE__ */ new Map();
  let byIdentity = /* @__PURE__ */ new Map();
  let fetchedAt = null;
  function rebuild(raw) {
    const nextEntries = [];
    const nextPids = /* @__PURE__ */ new Map();
    const nextIdentityByPid = /* @__PURE__ */ new Map();
    const nextByIdentity = /* @__PURE__ */ new Map();
    for (const app of raw) {
      if (typeof app.identity !== "string") continue;
      const key = normalizeIdentity(app.identity);
      if (key === "") continue;
      if (selfIdentity !== null && key === selfIdentity) continue;
      if (selfPids.has(app.pid)) continue;
      nextIdentityByPid.set(app.pid, key);
      const pids = nextPids.get(key);
      if (pids === void 0) {
        nextPids.set(key, [app.pid]);
      } else if (!pids.includes(app.pid)) {
        pids.push(app.pid);
      }
      if (!nextByIdentity.has(key)) {
        const entry = { ...app };
        nextByIdentity.set(key, entry);
        nextEntries.push(entry);
      }
    }
    nextEntries.sort(byName);
    entries = nextEntries;
    pidsByIdentity = nextPids;
    identityByPid = nextIdentityByPid;
    byIdentity = nextByIdentity;
  }
  function fetch() {
    fetchedAt = now();
    let raw;
    try {
      raw = deps.native.listApplications();
    } catch {
      return;
    }
    rebuild(Array.isArray(raw) ? raw : []);
  }
  function ensureFresh() {
    if (fetchedAt === null || now() - fetchedAt >= ttlMs) fetch();
  }
  function snapshot() {
    return entries.map((app) => ({ ...app }));
  }
  return {
    list() {
      ensureFresh();
      return snapshot();
    },
    refresh() {
      fetch();
      return snapshot();
    },
    findByIdentity(identity) {
      ensureFresh();
      const found = byIdentity.get(normalizeIdentity(identity));
      return found === void 0 ? null : { ...found };
    },
    findByPid(pid) {
      ensureFresh();
      const key = identityByPid.get(pid);
      if (key === void 0) return null;
      const found = byIdentity.get(key);
      return found === void 0 ? null : { ...found };
    },
    isRunning(identity) {
      ensureFresh();
      return byIdentity.has(normalizeIdentity(identity));
    },
    resolveTargets(identities) {
      ensureFresh();
      const wanted = new Set(identities.map(normalizeIdentity));
      return entries.filter((app) => wanted.has(normalizeIdentity(app.identity))).map((app) => ({ ...app }));
    },
    pidsForTargets(identities) {
      ensureFresh();
      const pids = [];
      for (const identity of identities) {
        for (const pid of pidsByIdentity.get(normalizeIdentity(identity)) ?? []) {
          if (!pids.includes(pid)) pids.push(pid);
        }
      }
      return pids;
    },
    invalidate() {
      fetchedAt = null;
    }
  };
}
const FOCUS_POLL_MS = 250;
function createFocusWatcher(deps) {
  const intervalMs = deps.intervalMs ?? FOCUS_POLL_MS;
  const scheduler = deps.scheduler ?? {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle2) => globalThis.clearInterval(handle2)
  };
  const listeners = /* @__PURE__ */ new Set();
  let handle = null;
  let currentPid = null;
  let currentApp = null;
  let started = false;
  function readPid() {
    try {
      const pid = deps.native.getFrontmostPid();
      return typeof pid === "number" && Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }
  const selfPids = new Set(deps.selfPids ?? []);
  function resolve(pid) {
    if (pid === null) return null;
    if (deps.selfApp != null && selfPids.has(pid)) return deps.selfApp;
    if (deps.registry === void 0) return null;
    try {
      return deps.registry.findByPid(pid);
    } catch {
      return null;
    }
  }
  function poll() {
    const pid = readPid();
    const app = resolve(pid);
    const changed = pid !== currentPid || (app?.identity ?? null) !== (currentApp?.identity ?? null);
    if (!changed) return;
    currentPid = pid;
    currentApp = app;
    for (const listener of [...listeners]) {
      try {
        listener(app === null ? null : { ...app }, pid);
      } catch {
      }
    }
  }
  return {
    poll,
    start() {
      if (started) return;
      started = true;
      poll();
      handle = scheduler.setInterval(poll, intervalMs);
    },
    stop() {
      if (handle !== null) scheduler.clearInterval(handle);
      handle = null;
      started = false;
    },
    current() {
      return currentApp === null ? null : { ...currentApp };
    },
    currentPid() {
      return currentPid;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
function createIconCache(deps) {
  const size = deps.size ?? "normal";
  const cache = /* @__PURE__ */ new Map();
  function load(path) {
    return deps.getFileIcon(path, { size }).then((image) => {
      if (image.isEmpty()) return null;
      const url = image.toDataURL();
      return typeof url === "string" && url !== "" ? url : null;
    }).catch(() => null);
  }
  function get(path) {
    if (typeof path !== "string" || path.trim() === "") return Promise.resolve(null);
    const existing = cache.get(path);
    if (existing !== void 0) return existing;
    const pending = load(path);
    cache.set(path, pending);
    return pending;
  }
  return {
    get,
    async decorate(apps) {
      return Promise.all(
        apps.map(async (app) => {
          const iconDataUrl = await get(app.path);
          return iconDataUrl === null ? { ...app } : { ...app, iconDataUrl };
        })
      );
    },
    clear() {
      cache.clear();
    },
    count() {
      return cache.size;
    }
  };
}
const JOURNAL_FILENAME = "held-keys.json";
const JOURNAL_VERSION = 1;
const nodeJournalFileSystem = {
  existsSync: (path) => nodeFsModule.existsSync(path),
  mkdirSync: (path, options) => {
    nodeFsModule.mkdirSync(path, options);
  },
  readFileSync: (path) => nodeFsModule.readFileSync(path, "utf8"),
  openSync: (path, flags) => nodeFsModule.openSync(path, flags),
  writeSync: (fd, data) => nodeFsModule.writeSync(fd, data),
  fsyncSync: (fd) => {
    nodeFsModule.fsyncSync(fd);
  },
  closeSync: (fd) => {
    nodeFsModule.closeSync(fd);
  },
  renameSync: (from, to) => {
    nodeFsModule.renameSync(from, to);
  },
  unlinkSync: (path) => {
    nodeFsModule.unlinkSync(path);
  }
};
class HoldJournal {
  path;
  #tempPath;
  #directory;
  #fs;
  #onError;
  constructor(options) {
    this.#directory = options.directory;
    this.path = nodePath.join(options.directory, JOURNAL_FILENAME);
    this.#tempPath = `${this.path}.tmp`;
    this.#fs = options.fs ?? nodeJournalFileSystem;
    this.#onError = options.onError ?? (() => void 0);
  }
  /**
   * Durably record what is about to be held. Must complete before the first
   * key-down is posted. Never throws: a session that cannot write a journal is
   * still safer to run than no session at all, because every in-process
   * failsafe still works. The caller is told through `onError`.
   */
  write(draft) {
    const entry = { version: JOURNAL_VERSION, ...draft };
    let fd = null;
    try {
      this.#fs.mkdirSync(this.#directory, { recursive: true });
      fd = this.#fs.openSync(this.#tempPath, "w");
      this.#fs.writeSync(fd, JSON.stringify(entry));
      this.#fs.fsyncSync(fd);
      this.#fs.closeSync(fd);
      fd = null;
      this.#fs.renameSync(this.#tempPath, this.path);
      this.#fsyncDirectory();
      return true;
    } catch (error) {
      if (fd !== null) {
        try {
          this.#fs.closeSync(fd);
        } catch {
        }
      }
      this.#onError("write", error);
      return false;
    }
  }
  /** True when a journal file is present, parseable or not. */
  exists() {
    try {
      return this.#fs.existsSync(this.path);
    } catch (error) {
      this.#onError("read", error);
      return false;
    }
  }
  read() {
    try {
      if (!this.#fs.existsSync(this.path)) return null;
      return parseJournal(this.#fs.readFileSync(this.path));
    } catch (error) {
      this.#onError("read", error);
      return null;
    }
  }
  /**
   * Delete the journal. Call this ONLY once a release is confirmed. Idempotent,
   * and a missing file is success.
   */
  clear() {
    try {
      if (!this.#fs.existsSync(this.path)) return true;
      this.#fs.unlinkSync(this.path);
      return true;
    } catch (error) {
      this.#onError("clear", error);
      return false;
    }
  }
  /**
   * Directory fsync, so the rename itself is durable and not just the file
   * contents. Fails on Windows, where directories cannot be opened for fsync,
   * and that is fine: NTFS metadata journalling already covers the rename.
   */
  #fsyncDirectory() {
    let dirFd = null;
    try {
      dirFd = this.#fs.openSync(this.#directory, "r");
      this.#fs.fsyncSync(dirFd);
    } catch {
    } finally {
      if (dirFd !== null) {
        try {
          this.#fs.closeSync(dirFd);
        } catch {
        }
      }
    }
  }
}
function parseJournal(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed;
  const pid = record["pid"];
  const startedAt = record["startedAt"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const injectorPid = record["injectorPid"];
  return {
    version: typeof record["version"] === "number" ? record["version"] : 0,
    pid,
    injectorPid: typeof injectorPid === "number" ? injectorPid : null,
    startedAt,
    keyIds: stringArray(record["keyIds"]),
    buttonIds: stringArray(record["buttonIds"])
  };
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}
function recoverStaleJournal(options) {
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const bootTimeMs = options.bootTimeMs ?? defaultBootTimeMs;
  const onError = options.onError ?? (() => void 0);
  const entry = options.journal.read();
  if (entry === null) {
    if (!options.journal.exists()) {
      return { outcome: "no-journal", releasedCount: 0, message: null, journal: null };
    }
    options.journal.clear();
    return { outcome: "unreadable", releasedCount: 0, message: null, journal: null };
  }
  const bootedAt = bootTimeMs();
  const predatesBoot = Number.isFinite(bootedAt) && entry.startedAt < bootedAt;
  if (!predatesBoot && isAlive(entry.pid)) {
    return { outcome: "owner-alive", releasedCount: 0, message: null, journal: entry };
  }
  const plan = buildReplayPlan(entry);
  if (plan.keyIds.length === 0 && plan.buttonIds.length === 0) {
    options.journal.clear();
    return { outcome: "nothing-held", releasedCount: 0, message: null, journal: entry };
  }
  let released;
  try {
    released = options.replay(plan);
  } catch (error) {
    onError(error);
    return {
      outcome: "replay-failed",
      releasedCount: 0,
      message: "KeyPress Ultimate found keys left down by an earlier run but could not release them. Tap them once on your keyboard to clear them.",
      journal: entry
    };
  }
  options.journal.clear();
  return {
    outcome: "recovered",
    releasedCount: released,
    message: recoveryMessage(released),
    journal: entry
  };
}
function buildReplayPlan(entry, isModifier = defaultIsModifier) {
  const reversed = [...entry.keyIds].reverse();
  return {
    keyIds: [
      ...reversed.filter((id) => !isModifier(id)),
      ...reversed.filter((id) => isModifier(id))
    ],
    buttonIds: [...entry.buttonIds].reverse()
  };
}
function defaultIsModifier(keyId) {
  return keys.getKeyById(keyId)?.isModifier === true;
}
function recoveryMessage(count) {
  const noun = count === 1 ? "key" : "keys";
  return `Recovered from an unclean shutdown, released ${String(count)} ${noun}.`;
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function defaultBootTimeMs() {
  return Date.now() - node_os.uptime() * 1e3;
}
const ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const PERMISSION_POLL_MS$1 = 1e3;
function createMemoryPromptState(initial = false) {
  let used = initial;
  return {
    wasUsed: () => used,
    markUsed: () => {
      used = true;
    }
  };
}
function createPermissions(deps) {
  const needsPermission = deps.platform === "darwin";
  const promptState = deps.promptState ?? createMemoryPromptState();
  const intervalMs = deps.intervalMs ?? PERMISSION_POLL_MS$1;
  const scheduler = deps.scheduler ?? {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle2) => globalThis.clearInterval(handle2)
  };
  const listeners = /* @__PURE__ */ new Set();
  let handle = null;
  let granted = !needsPermission;
  function read(prompt) {
    if (!needsPermission) return true;
    try {
      return deps.isTrusted(prompt) === true;
    } catch {
      return false;
    }
  }
  function snapshot() {
    return {
      needsPermission,
      hasPermission: granted,
      promptWasAlreadyUsed: needsPermission ? promptState.wasUsed() : false,
      settingsUrl: ACCESSIBILITY_SETTINGS_URL
    };
  }
  function emit() {
    const status = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(status);
      } catch {
      }
    }
  }
  function apply(next) {
    const changed = next !== granted;
    granted = next;
    if (changed) emit();
    return snapshot();
  }
  granted = read(false);
  return {
    status: snapshot,
    check() {
      return apply(read(false));
    },
    async request() {
      if (!needsPermission) return snapshot();
      if (read(false)) return apply(true);
      if (promptState.wasUsed()) {
        return apply(false);
      }
      promptState.markUsed();
      return apply(read(true));
    },
    start() {
      if (handle !== null || !needsPermission) return;
      handle = scheduler.setInterval(() => {
        apply(read(false));
      }, intervalMs);
    },
    stop() {
      if (handle !== null) scheduler.clearInterval(handle);
      handle = null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
class DirectReleaseError extends Error {
  /** Ups that were posted before, between and after the failures. */
  releasedCount;
  /** The ids whose up the OS refused. */
  failedIds;
  constructor(releasedCount, failedIds) {
    super(
      `released ${releasedCount} input${releasedCount === 1 ? "" : "s"}, but ${failedIds.length} could not be released: ${failedIds.join(", ")}`
    );
    this.name = "DirectReleaseError";
    this.releasedCount = releasedCount;
    this.failedIds = failedIds;
  }
}
function releaseInputDirectly(options) {
  const { native, keyIds, buttonIds, onError } = options;
  if (native === null) {
    throw new Error("the native input layer is not bound, so nothing can be released");
  }
  let released = 0;
  const failedIds = [];
  const attempt = (id, post) => {
    try {
      post();
      released += 1;
    } catch (error) {
      failedIds.push(id);
      onError?.(`could not release "${id}" directly`, error);
    }
  };
  for (const buttonId of buttonIds) {
    const button = keys.getMouseButtonById(buttonId);
    if (button === void 0) {
      onError?.(`ignoring an unknown mouse button id "${buttonId}"`, new Error("no such button"));
      continue;
    }
    attempt(buttonId, () => {
      native.mouseUp(button);
    });
  }
  for (const keyId of keyIds) {
    const key = keys.getKeyById(keyId);
    if (key === void 0) {
      onError?.(`ignoring an unknown key id "${keyId}"`, new Error("no such key"));
      continue;
    }
    attempt(keyId, () => {
      native.keyUp(key);
    });
  }
  if (failedIds.length > 0) throw new DirectReleaseError(released, failedIds);
  return released;
}
const FORBIDDEN_KEY_TOKENS = /* @__PURE__ */ new Set([
  "mediaplaypause",
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
  "volumeup",
  "volumedown",
  "volumemute"
]);
const MODIFIER_TOKENS = /* @__PURE__ */ new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta"
]);
function validatePanicHotkey(accelerator) {
  const tokens = accelerator.split("+").map((token) => token.trim()).filter((token) => token.length > 0);
  if (tokens.length === 0) return { kind: "empty" };
  const forbidden = tokens.find((token) => FORBIDDEN_KEY_TOKENS.has(token.toLowerCase()));
  if (forbidden !== void 0) return { kind: "forbidden-key", token: forbidden };
  const modifiers = tokens.filter((token) => MODIFIER_TOKENS.has(token.toLowerCase()));
  const keys2 = tokens.filter((token) => !MODIFIER_TOKENS.has(token.toLowerCase()));
  if (modifiers.length === 0) return { kind: "no-modifier" };
  if (keys2.length === 0) return { kind: "no-key" };
  if (keys2.length > 1) return { kind: "multiple-keys", tokens: keys2 };
  return null;
}
function describePanicHotkeyProblem(problem, accelerator) {
  switch (problem.kind) {
    case "empty":
      return "No panic hotkey is set. Pick one in Settings, then press Start again.";
    case "forbidden-key":
      return `The panic hotkey cannot use ${problem.token}. Media and volume keys are owned by the system and need a permission you can revoke, which is exactly what the panic hotkey has to survive. Pick a different combination in Settings.`;
    case "no-modifier":
      return `The panic hotkey ${accelerator} has no modifier, so it would fire during normal typing. Add Ctrl, Alt, Shift or Command in Settings.`;
    case "no-key":
      return `The panic hotkey ${accelerator} is modifiers only. Add a letter or number in Settings.`;
    case "multiple-keys":
      return `The panic hotkey ${accelerator} names more than one key (${problem.tokens.join(", ")}). Use one key plus modifiers.`;
  }
}
class PanicHotkey {
  #globalShortcut;
  #registered = null;
  constructor(options = {}) {
    this.#globalShortcut = options.globalShortcut ?? null;
  }
  /** The currently registered accelerator, or null. */
  get accelerator() {
    return this.#registered;
  }
  get isRegistered() {
    return this.#registered !== null;
  }
  /**
   * Take the accelerator. Any failure here must block Start: the caller gets a
   * message that names the combination so the user knows what to change.
   */
  register(accelerator, onPanic) {
    const trimmed = accelerator.trim();
    if (this.#registered === trimmed && trimmed.length > 0) {
      return { ok: true, accelerator: trimmed };
    }
    this.unregister();
    const problem = validatePanicHotkey(trimmed);
    if (problem !== null) {
      return {
        ok: false,
        reason: "invalid",
        problem,
        message: describePanicHotkeyProblem(problem, trimmed)
      };
    }
    let shortcuts;
    try {
      shortcuts = this.#shortcuts();
    } catch (error) {
      return {
        ok: false,
        reason: "threw",
        error,
        message: "KeyPress Ultimate could not reach the system shortcut service, so it cannot register a panic hotkey. Restart the app and try again."
      };
    }
    let accepted;
    try {
      accepted = shortcuts.register(trimmed, onPanic);
    } catch (error) {
      return {
        ok: false,
        reason: "threw",
        error,
        message: `The panic hotkey ${trimmed} is not a valid shortcut. Pick a different combination in Settings, then press Start again.`
      };
    }
    if (!accepted || !shortcuts.isRegistered(trimmed)) {
      try {
        shortcuts.unregister(trimmed);
      } catch {
      }
      return { ok: false, reason: "taken", message: takenMessage(trimmed) };
    }
    this.#registered = trimmed;
    return { ok: true, accelerator: trimmed };
  }
  /** Idempotent. Safe to call when nothing is registered. */
  unregister() {
    const current2 = this.#registered;
    this.#registered = null;
    if (current2 === null) return;
    try {
      this.#shortcuts().unregister(current2);
    } catch {
    }
  }
  #shortcuts() {
    this.#globalShortcut ??= loadElectronGlobalShortcut();
    return this.#globalShortcut;
  }
}
function takenMessage(accelerator) {
  return `The panic hotkey ${accelerator} is already taken by another app, so KeyPress Ultimate cannot register it. Without a working panic hotkey the session will not start. Pick a different combination in Settings, then press Start again.`;
}
function currentPlatform$1() {
  return process.platform === "win32" ? "win32" : "darwin";
}
function panicHotkeyTriggerKeyIds(accelerator) {
  const ids = [];
  for (const raw of accelerator.split("+")) {
    const token = raw.trim().toLowerCase();
    if (token.length === 0) continue;
    if (MODIFIER_TOKENS.has(token)) continue;
    const candidate = `key-${token}`;
    if (keys.getKeyById(candidate) !== void 0 && !ids.includes(candidate)) ids.push(candidate);
  }
  return ids;
}
function panicHotkeyConflicts(accelerator, selectedKeyIds) {
  const triggerIds = new Set(panicHotkeyTriggerKeyIds(accelerator));
  return selectedKeyIds.filter((id) => triggerIds.has(id));
}
function describePanicHotkeyConflict(accelerator, conflicts, platform = currentPlatform$1()) {
  const names = conflicts.map((id) => {
    const key = keys.getKeyById(id);
    return key === void 0 ? id : keys.platformLabel(key, platform);
  });
  const listed = names.length === 0 ? "a key you picked" : names.join(" and ");
  const combination = formatAcceleratorForPlatform(accelerator, platform);
  const deselect = names.length > 1 ? "those keys" : listed;
  return `The panic hotkey ${combination} needs ${listed}, which you also picked to hold. Deselect ${deselect} on the keyboard, then press Start again.`;
}
function formatAcceleratorForPlatform(accelerator, platform) {
  const mac = platform === "darwin";
  return accelerator.split("+").map((raw) => {
    const token = raw.trim();
    switch (token.toLowerCase()) {
      case "commandorcontrol":
      case "cmdorctrl":
        return mac ? "Command" : "Ctrl";
      case "command":
      case "cmd":
        return "Command";
      case "control":
      case "ctrl":
        return mac ? "Control" : "Ctrl";
      case "alt":
      case "option":
        return mac ? "Option" : "Alt";
      case "shift":
        return "Shift";
      default:
        return token;
    }
  }).filter((token) => token.length > 0).join("+");
}
function loadElectronGlobalShortcut() {
  const req = globalThis.require;
  if (typeof req !== "function") {
    throw new Error(
      "PanicHotkey needs an injected globalShortcut outside the Electron main process"
    );
  }
  const electron2 = req("electron");
  const shortcuts = electron2.globalShortcut;
  if (shortcuts === void 0) {
    throw new Error("electron.globalShortcut is unavailable");
  }
  return shortcuts;
}
const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    clearInterval(handle);
  }
};
const DEFAULT_RELEASE_GRACE_MS = 250;
const DEFAULT_FOCUS_RELEASE_GRACE_MS = 500;
const PERMISSION_POLL_MS = 1e3;
const MIN_SESSION_MS = 1e4;
const MAX_TIMER_MS = 2147483647;
const POWER_EVENTS = [
  { event: "suspend", reason: "power-suspend" },
  { event: "lock-screen", reason: "screen-locked" },
  // macOS and Linux only. Registering it on Windows is harmless.
  { event: "shutdown", reason: "app-quit" },
  // macOS fast user switching. Another user's session is about to take the
  // keyboard, which is the same hazard as a lock.
  { event: "user-did-resign-active", reason: "screen-locked" }
];
const SIGNAL_EVENTS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SOFT_RELEASE_REASONS = /* @__PURE__ */ new Set([
  "focus-lost",
  "target-quit"
]);
class SessionController {
  #options;
  #clock;
  #panic;
  #powerMonitor;
  #timers = /* @__PURE__ */ new Map();
  #stateListeners = /* @__PURE__ */ new Set();
  #releaseListeners = /* @__PURE__ */ new Set();
  #powerBindings = [];
  #processBindings = [];
  #settings;
  #phase = "idle";
  #startedAt = null;
  #firingKeyIds = [];
  #firingButtonIds = [];
  #focusedApp = null;
  #onTarget = false;
  #message = null;
  #lastEmittedSignature = "";
  #config = null;
  #injector = null;
  #armed = false;
  #pending = null;
  /** Last non-empty firing set, so a release event can say what was released. */
  #lastHeld = { keyIds: [], buttonIds: [] };
  /** A soft release waiting on the injector to confirm it let go. */
  #pendingSoftReason = null;
  #lastPongAt = 0;
  #pingCounter = 0;
  #powerSaveBlockerId = null;
  #processTarget = null;
  #disposed = false;
  constructor(options) {
    this.#options = options;
    this.#settings = options.settings;
    this.#clock = options.clock ?? systemClock;
    this.#panic = new PanicHotkey(
      options.globalShortcut === void 0 ? {} : { globalShortcut: options.globalShortcut }
    );
    this.#powerMonitor = options.powerMonitor ?? null;
    this.#bindPowerMonitor();
  }
  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------
  getState() {
    return {
      phase: this.#phase,
      startedAt: this.#startedAt,
      firingKeyIds: [...this.#firingKeyIds],
      firingButtonIds: [...this.#firingButtonIds],
      focusedApp: this.#focusedApp,
      onTarget: this.#onTarget,
      message: this.#message
    };
  }
  onState(listener) {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }
  onRelease(listener) {
    this.#releaseListeners.add(listener);
    return () => this.#releaseListeners.delete(listener);
  }
  get isArmed() {
    return this.#armed;
  }
  setSettings(settings) {
    const previous = this.#settings;
    this.#settings = settings;
    if (!this.#armed || this.#injector === null) return;
    this.#post({ t: "settings", settings });
    if (settings.maxSessionMinutes !== previous.maxSessionMinutes) {
      this.#startMaxSessionTimer();
    }
  }
  // -------------------------------------------------------------------------
  // Arm
  // -------------------------------------------------------------------------
  arm(config) {
    if (this.#disposed) {
      return { ok: false, code: "already-armed", message: "The session controller was disposed." };
    }
    if (this.#armed) {
      return { ok: false, code: "already-armed", message: "A session is already running." };
    }
    if (config.keyIds.length === 0 && config.buttonIds.length === 0) {
      return this.#refuse(
        "nothing-selected",
        "Pick at least one key or mouse button before starting.",
        "idle"
      );
    }
    if (config.targets.length === 0) {
      return this.#refuse(
        "no-targets",
        "Pick at least one target app. KeyPress Ultimate only holds keys while a target is frontmost.",
        "idle"
      );
    }
    const permissions = this.#options.permissions;
    if (permissions !== void 0 && !permissions.hasPermission()) {
      return this.#refuse(
        "permission-required",
        "KeyPress Ultimate needs Accessibility permission to send key presses. Grant it in System Settings, then press Start again.",
        "blocked"
      );
    }
    const accelerator = this.#settings.panicHotkey;
    const conflicts = panicHotkeyConflicts(accelerator, config.keyIds);
    if (conflicts.length > 0) {
      return this.#refuse(
        "panic-hotkey-conflict",
        describePanicHotkeyConflict(accelerator, conflicts),
        "idle"
      );
    }
    const registration = this.#panic.register(accelerator, () => {
      this.#release("panic-hotkey");
    });
    if (!registration.ok) {
      return this.#refuse("panic-hotkey-unavailable", registration.message, "idle");
    }
    const startedAt = this.#clock.now();
    this.#options.journal?.write({
      pid: this.#processPid(),
      injectorPid: null,
      startedAt,
      keyIds: [...config.keyIds],
      buttonIds: [...config.buttonIds]
    });
    let injector;
    try {
      injector = this.#fork();
    } catch (error) {
      this.#options.onError?.("failed to fork the injector", error);
      this.#panic.unregister();
      this.#options.journal?.clear();
      return this.#refuse(
        "fork-failed",
        "KeyPress Ultimate could not start its input process. Restart the app and try again.",
        "error"
      );
    }
    this.#injector = injector;
    this.#config = config;
    this.#armed = true;
    this.#pending = null;
    this.#pendingSoftReason = null;
    this.#lastHeld = { keyIds: [], buttonIds: [] };
    this.#startedAt = startedAt;
    this.#lastPongAt = startedAt;
    this.#pingCounter = 0;
    injector.onMessage((message) => {
      this.#handleInjectorMessage(message);
    });
    injector.onExit((code) => {
      this.#handleInjectorExit(code);
    });
    this.#startPowerSaveBlocker();
    this.#post({ t: "settings", settings: this.#settings });
    this.#post({ t: "arm", config });
    this.#startHeartbeat();
    this.#startPermissionPoll();
    this.#startMaxSessionTimer();
    this.#phase = "armed-waiting";
    this.#onTarget = false;
    this.#firingKeyIds = [];
    this.#firingButtonIds = [];
    this.#message = this.#waitingMessage(config);
    this.#emitState();
    return { ok: true };
  }
  // -------------------------------------------------------------------------
  // Failsafe fan-in. Every entry point below ends in `#release`.
  // -------------------------------------------------------------------------
  /** Stop pressed, and the generic entry point for anything else. */
  disarm(reason) {
    this.#release(reason);
  }
  /** The target application exited. Stays armed: it may come back. */
  handleTargetQuit() {
    this.#release("target-quit");
  }
  /** `app.on('before-quit')` / `will-quit`. */
  handleAppQuit() {
    this.#release("app-quit", { sync: true });
  }
  /** `app.on('window-all-closed')`. */
  handleWindowClosed() {
    this.#release("window-closed", { sync: true });
  }
  /** Same path the panic hotkey takes, for a UI panic button. */
  panic() {
    this.#release("panic-hotkey");
  }
  /**
   * Signals and uncaught exceptions. Returns a detach function.
   *
   * The handlers run synchronously, because `process.on('exit')` gives no
   * chance to await anything, and they never rethrow: deciding what to do after
   * an uncaught exception belongs to the app entry point, not here.
   */
  attachProcessFailsafes() {
    const target = this.#options.processTarget ?? defaultProcessTarget();
    this.#processTarget = target;
    const bind = (event, listener) => {
      target.on(event, listener);
      this.#processBindings.push({ event, listener });
    };
    bind("uncaughtException", (...args) => {
      this.#options.onError?.("uncaught exception in the main process", args[0]);
      this.#release("uncaught-exception", { sync: true, terminalPhase: "error" });
    });
    bind("unhandledRejection", (...args) => {
      this.#options.onError?.("unhandled rejection in the main process", args[0]);
      this.#release("uncaught-exception", { sync: true, terminalPhase: "error" });
    });
    for (const signal of SIGNAL_EVENTS) {
      bind(signal, () => {
        this.#release("signal", { sync: true });
      });
    }
    bind("exit", () => {
      this.#release("app-quit", { sync: true });
    });
    return () => {
      for (const binding of this.#processBindings) {
        target.removeListener(binding.event, binding.listener);
      }
      this.#processBindings.length = 0;
    };
  }
  dispose() {
    if (this.#disposed) return;
    this.#release("app-quit", { sync: true });
    this.#unbindPowerMonitor();
    const target = this.#processTarget;
    if (target !== null) {
      for (const binding of this.#processBindings) {
        target.removeListener(binding.event, binding.listener);
      }
    }
    this.#processBindings.length = 0;
    this.#stateListeners.clear();
    this.#releaseListeners.clear();
    this.#disposed = true;
  }
  // -------------------------------------------------------------------------
  // The one release path
  // -------------------------------------------------------------------------
  /**
   * Idempotent. Re-entrant. Safe from a signal handler. Safe when nothing is
   * armed. There is no other way to end a session.
   */
  #release(reason, options = {}) {
    if (!this.#armed) return;
    if (SOFT_RELEASE_REASONS.has(reason) && options.hard !== true) {
      this.#softRelease(reason);
      return;
    }
    this.#armed = false;
    const held = this.#currentlyHeld();
    const holdingNow = held.keyIds.length > 0 || held.buttonIds.length > 0;
    const keyIds = holdingNow ? held.keyIds : [...this.#lastHeld.keyIds];
    const buttonIds = holdingNow ? held.buttonIds : [...this.#lastHeld.buttonIds];
    const terminalPhase = options.terminalPhase ?? terminalPhaseFor(reason);
    const message = options.message ?? this.#releaseMessage(reason);
    this.#clearTimer("heartbeat");
    this.#clearTimer("permission-poll");
    this.#clearTimer("max-session");
    this.#clearTimer("soft-release-watchdog");
    this.#pendingSoftReason = null;
    this.#panic.unregister();
    this.#pending = { reason, terminalPhase, message, keyIds, buttonIds };
    this.#post({ t: "disarm", reason });
    if (this.#pending === null) return;
    if (options.sync === true) {
      this.#finishTeardown(false, { keepInjectorAlive: true });
      return;
    }
    this.#setTimeout(
      "release-grace",
      this.#options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS,
      () => {
        this.#finishTeardown(false);
      }
    );
  }
  /**
   * Focus loss and target quit. The injector releases on its own tick, so this
   * verifies rather than commands, and escalates to a hard stop if the keys are
   * still down after the grace window.
   */
  #softRelease(reason) {
    const held = this.#currentlyHeld();
    const alreadyClear = held.keyIds.length === 0 && held.buttonIds.length === 0;
    this.#phase = "armed-waiting";
    this.#message = this.#waitingMessage(this.#config);
    if (alreadyClear) {
      this.#clearTimer("soft-release-watchdog");
      this.#pendingSoftReason = null;
      this.#emitState();
      this.#emitRelease({
        reason,
        at: this.#clock.now(),
        keyIds: [...this.#lastHeld.keyIds],
        buttonIds: [...this.#lastHeld.buttonIds],
        confirmed: true,
        hardStop: false
      });
      return;
    }
    this.#pendingSoftReason = reason;
    this.#emitState();
    this.#setTimeout(
      "soft-release-watchdog",
      this.#options.focusReleaseGraceMs ?? DEFAULT_FOCUS_RELEASE_GRACE_MS,
      () => {
        const still = this.#currentlyHeld();
        if (still.keyIds.length === 0 && still.buttonIds.length === 0) return;
        this.#release(reason, {
          hard: true,
          terminalPhase: "error",
          message: "The input process did not release the keys when focus moved away, so the session was stopped."
        });
      }
    );
  }
  #finishTeardown(confirmed, options = {}) {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#clearTimer("release-grace");
    let released = confirmed;
    if (!released) {
      const fallback = this.#options.releaseFallback;
      if (fallback !== void 0 && fallback !== null) {
        const safety = this.#unconfirmedReleaseSet(pending);
        try {
          fallback(safety.keyIds, safety.buttonIds);
          released = true;
        } catch (error) {
          this.#options.onError?.("main-side release fallback failed", error);
        }
      }
    }
    const injector = this.#injector;
    this.#injector = null;
    if (injector !== null && options.keepInjectorAlive !== true) {
      try {
        injector.kill();
      } catch (error) {
        this.#options.onError?.("failed to kill the injector", error);
      }
    }
    this.#stopPowerSaveBlocker();
    if (released) {
      this.#options.journal?.clear();
    }
    this.#phase = pending.terminalPhase;
    this.#startedAt = null;
    this.#firingKeyIds = [];
    this.#firingButtonIds = [];
    this.#onTarget = false;
    this.#focusedApp = null;
    this.#config = null;
    this.#message = released ? pending.message : appendUnconfirmedWarning(pending.message ?? unconfirmedFallbackMessage());
    this.#emitState();
    this.#emitRelease({
      reason: pending.reason,
      at: this.#clock.now(),
      keyIds: pending.keyIds,
      buttonIds: pending.buttonIds,
      confirmed: released,
      hardStop: true
    });
    this.#lastHeld = { keyIds: [], buttonIds: [] };
  }
  /**
   * What to hand the main-side fallback when nothing confirmed the ups: the set
   * main believes was held, plus everything the session was configured to hold.
   */
  #unconfirmedReleaseSet(pending) {
    const config = this.#config;
    return {
      keyIds: union(pending.keyIds, config?.keyIds ?? []),
      buttonIds: union(pending.buttonIds, config?.buttonIds ?? [])
    };
  }
  // -------------------------------------------------------------------------
  // Injector conversation
  // -------------------------------------------------------------------------
  #handleInjectorMessage(message) {
    switch (message.t) {
      case "pong":
        this.#lastPongAt = this.#clock.now();
        return;
      case "released":
        if (this.#pending !== null) this.#finishTeardown(true);
        return;
      case "error":
        this.#handleInjectorError(message.code, message.message);
        return;
      case "blocked":
        this.#handleElevatedTarget(message);
        return;
      case "state":
        this.#handleInjectorState(message);
        return;
    }
  }
  #handleInjectorState(message) {
    if (!this.#armed && this.#pending === null) return;
    const wasOnTarget = this.#onTarget;
    this.#firingKeyIds = [...message.firingKeyIds];
    this.#firingButtonIds = [...message.firingButtonIds];
    this.#onTarget = message.onTarget;
    this.#focusedApp = this.#options.resolveApp?.(message.focusedPid) ?? null;
    if (this.#firingKeyIds.length > 0 || this.#firingButtonIds.length > 0) {
      this.#lastHeld = {
        keyIds: [...this.#firingKeyIds],
        buttonIds: [...this.#firingButtonIds]
      };
    }
    if (this.#pending !== null) {
      if (this.#firingKeyIds.length === 0 && this.#firingButtonIds.length === 0) {
        this.#finishTeardown(true);
      }
      return;
    }
    const firing = this.#firingKeyIds.length > 0 || this.#firingButtonIds.length > 0;
    if (this.#pendingSoftReason !== null) {
      if (!firing) {
        this.#softRelease(this.#pendingSoftReason);
        return;
      }
      if (message.onTarget) {
        this.#pendingSoftReason = null;
        this.#clearTimer("soft-release-watchdog");
      } else {
        this.#emitState();
        return;
      }
    }
    if (wasOnTarget && !message.onTarget) {
      this.#release("focus-lost");
      return;
    }
    this.#phase = firing ? "firing" : "armed-waiting";
    if (!firing) this.#message = this.#waitingMessage(this.#config);
    else this.#message = null;
    this.#emitState();
  }
  /**
   * The target is running elevated and Windows will not let our input reach it.
   * Nothing the app can do at runtime fixes that, so the session ends in
   * `blocked` carrying a message that names the app, exactly like a missing
   * Accessibility permission on macOS.
   */
  #handleElevatedTarget(message) {
    this.#release("injector-error", {
      terminalPhase: "blocked",
      message: elevatedTargetMessage(message.appName, message.message)
    });
  }
  #handleInjectorError(code, detail) {
    const blocked = code === "injection-blocked" || code === "permission-denied";
    this.#release("injector-error", {
      terminalPhase: blocked ? "blocked" : "error",
      message: injectorErrorMessage(code, detail)
    });
  }
  #handleInjectorExit(code) {
    if (this.#pending !== null) {
      this.#finishTeardown(false);
      return;
    }
    if (!this.#armed) return;
    this.#injector = null;
    this.#release("injector-error", {
      sync: true,
      terminalPhase: "error",
      message: `The input process stopped unexpectedly (exit code ${String(code ?? "unknown")}). Everything it was holding was released.`
    });
  }
  #post(message) {
    const injector = this.#injector;
    if (injector === null) return;
    try {
      injector.postMessage(message);
    } catch (error) {
      if (message.t !== "disarm") {
        this.#options.onError?.(`failed to post ${message.t} to the injector`, error);
      }
    }
  }
  #fork() {
    const mainPid = this.#processPid();
    const injected = this.#options.forkInjector;
    if (injected !== void 0) {
      return injected({ modulePath: this.#options.injectorPath ?? "", mainPid });
    }
    return defaultForkInjector({
      modulePath: this.#options.injectorPath ?? defaultInjectorPath(),
      mainPid
    });
  }
  // -------------------------------------------------------------------------
  // Watchdogs
  // -------------------------------------------------------------------------
  #startHeartbeat() {
    this.#setInterval("heartbeat", keys.HEARTBEAT_INTERVAL_MS, () => {
      const now = this.#clock.now();
      if (now - this.#lastPongAt > keys.HEARTBEAT_TIMEOUT_MS) {
        this.#release("heartbeat-timeout");
        return;
      }
      this.#pingCounter += 1;
      this.#post({ t: "ping", n: this.#pingCounter });
    });
  }
  #startPermissionPoll() {
    const permissions = this.#options.permissions;
    if (permissions === void 0) return;
    this.#setInterval("permission-poll", PERMISSION_POLL_MS, () => {
      let granted;
      try {
        granted = permissions.hasPermission();
      } catch (error) {
        this.#options.onError?.("permission probe threw", error);
        return;
      }
      if (!granted) this.#release("permission-revoked");
    });
  }
  /**
   * Schedules the cap against the session's own start, so it can be restarted
   * mid-session after a settings change and still mean "N minutes of holding",
   * not "N more minutes". Safe to call repeatedly: it replaces the timer.
   */
  #startMaxSessionTimer() {
    this.#clearTimer("max-session");
    const minutes = this.#settings.maxSessionMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const total = Math.min(MAX_TIMER_MS, Math.max(MIN_SESSION_MS, minutes * 6e4));
    const now = this.#clock.now();
    const elapsed = this.#startedAt === null ? 0 : Math.max(0, now - this.#startedAt);
    this.#setTimeout("max-session", Math.max(0, total - elapsed), () => {
      this.#release("max-session-time");
    });
  }
  #startPowerSaveBlocker() {
    const blocker = this.#options.powerSaveBlocker;
    if (blocker === void 0 || blocker === null) return;
    try {
      this.#powerSaveBlockerId = blocker.start("prevent-app-suspension");
    } catch (error) {
      this.#options.onError?.("failed to start the power save blocker", error);
      this.#powerSaveBlockerId = null;
    }
  }
  #stopPowerSaveBlocker() {
    const blocker = this.#options.powerSaveBlocker;
    const id = this.#powerSaveBlockerId;
    this.#powerSaveBlockerId = null;
    if (blocker === void 0 || blocker === null || id === null) return;
    try {
      blocker.stop(id);
    } catch (error) {
      this.#options.onError?.("failed to stop the power save blocker", error);
    }
  }
  #bindPowerMonitor() {
    const monitor = this.#powerMonitor;
    if (monitor === null) return;
    for (const { event, reason } of POWER_EVENTS) {
      const listener = () => {
        this.#release(reason, { sync: true });
      };
      try {
        monitor.on(event, listener);
        this.#powerBindings.push({ event, listener });
      } catch (error) {
        this.#options.onError?.(`could not subscribe to powerMonitor ${event}`, error);
      }
    }
  }
  #unbindPowerMonitor() {
    const monitor = this.#powerMonitor;
    if (monitor === null) return;
    for (const binding of this.#powerBindings) {
      try {
        monitor.removeListener(binding.event, binding.listener);
      } catch {
      }
    }
    this.#powerBindings.length = 0;
  }
  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------
  #currentlyHeld() {
    if (this.#firingKeyIds.length > 0 || this.#firingButtonIds.length > 0) {
      return { keyIds: [...this.#firingKeyIds], buttonIds: [...this.#firingButtonIds] };
    }
    return { keyIds: [], buttonIds: [] };
  }
  #refuse(code, message, phase) {
    this.#phase = phase;
    this.#startedAt = null;
    this.#firingKeyIds = [];
    this.#firingButtonIds = [];
    this.#onTarget = false;
    this.#message = message;
    this.#emitState();
    return { ok: false, code, message };
  }
  #waitingMessage(config) {
    const identity = config?.targets[0];
    const name = identity === void 0 ? null : this.#options.resolveTargetName?.(identity) ?? null;
    return name === null ? "Armed, waiting for the target app." : `Armed, waiting for ${name}.`;
  }
  #releaseMessage(reason) {
    switch (reason) {
      case "user-stop":
      case "app-quit":
      case "window-closed":
      case "signal":
        return null;
      case "uncaught-exception":
        return "KeyPress Ultimate hit an internal error, so everything was released.";
      case "power-suspend":
        return "The computer went to sleep, so everything was released.";
      case "screen-locked":
        return "The screen locked, so everything was released.";
      case "permission-revoked":
        return "Accessibility permission was turned off, so everything was released. Grant it again in System Settings, then press Start.";
      case "heartbeat-timeout":
        return "The input process stopped responding, so everything was released.";
      case "panic-hotkey":
        return `Panic hotkey ${this.#settings.panicHotkey} pressed. Everything was released.`;
      case "max-session-time":
        return `The ${String(this.#settings.maxSessionMinutes)} minute session limit was reached, so everything was released.`;
      case "focus-lost":
      case "target-quit":
      case "injector-error":
        return null;
    }
  }
  #processPid() {
    return this.#options.processTarget?.pid ?? process.pid;
  }
  #emitState() {
    const state = this.getState();
    const signature = JSON.stringify(state);
    if (signature === this.#lastEmittedSignature) return;
    this.#lastEmittedSignature = signature;
    for (const listener of this.#stateListeners) {
      try {
        listener(state);
      } catch (error) {
        this.#options.onError?.("a session state listener threw", error);
      }
    }
  }
  #emitRelease(event) {
    for (const listener of this.#releaseListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#options.onError?.("a release listener threw", error);
      }
    }
  }
  #setTimeout(name, ms, fn) {
    this.#clearTimer(name);
    this.#timers.set(name, { handle: this.#clock.setTimeout(fn, ms), kind: "timeout" });
  }
  #setInterval(name, ms, fn) {
    this.#clearTimer(name);
    this.#timers.set(name, { handle: this.#clock.setInterval(fn, ms), kind: "interval" });
  }
  #clearTimer(name) {
    const timer = this.#timers.get(name);
    if (timer === void 0) return;
    this.#timers.delete(name);
    if (timer.kind === "timeout") this.#clock.clearTimeout(timer.handle);
    else this.#clock.clearInterval(timer.handle);
  }
}
function terminalPhaseFor(reason) {
  switch (reason) {
    case "permission-revoked":
      return "blocked";
    case "uncaught-exception":
    case "heartbeat-timeout":
    case "injector-error":
      return "error";
    default:
      return "idle";
  }
}
function injectorErrorMessage(code, detail) {
  switch (code) {
    case "injection-blocked":
      return "Windows is blocking input into this app because it is running as administrator. Restart KeyPress Ultimate as administrator, then press Start again.";
    case "permission-denied":
      return "KeyPress Ultimate lost Accessibility permission, so everything was released. Grant it again in System Settings, then press Start.";
    case "struct-layout-mismatch":
      return "KeyPress Ultimate refused to send input because the system input structures are not the layout it expects. This build cannot run safely on this machine.";
    case "ffi-init-failed":
      return "KeyPress Ultimate could not load its native input layer, so no keys were pressed.";
    case "unsupported-platform":
      return "KeyPress Ultimate does not support sending input on this platform.";
    case "unknown":
      return detail.length > 0 ? detail : "The input process reported an error, so everything was released.";
  }
}
function elevatedTargetMessage(appName, detail) {
  const name = typeof appName === "string" ? appName.trim() : "";
  if (name.length > 0) {
    return `Windows is blocking input into ${name} because it is running as administrator. Restart KeyPress Ultimate as administrator, then press Start again.`;
  }
  const fallback = typeof detail === "string" ? detail.trim() : "";
  if (fallback.length > 0) return fallback;
  return "Windows is blocking input into the target app because it is running as administrator. Restart KeyPress Ultimate as administrator, then press Start again.";
}
function union(a, b) {
  const out = [...a];
  for (const id of b) if (!out.includes(id)) out.push(id);
  return out;
}
function appendUnconfirmedWarning(message) {
  return `${message} Some keys may still be held. They will be released the next time KeyPress Ultimate starts, or when you tap them.`;
}
function unconfirmedFallbackMessage() {
  return "The session was stopped.";
}
function requireElectron() {
  const req = globalThis.require;
  if (typeof req !== "function") {
    throw new Error("SessionController needs injected dependencies outside the Electron main process");
  }
  return req("electron");
}
function moduleDirname() {
  return typeof __dirname === "string" ? __dirname : void 0;
}
function defaultInjectorPath(dir = moduleDirname()) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("cannot resolve the injector path outside the packaged main process");
  }
  return nodePath.join(dir, "injector.js");
}
const defaultForkInjector = (options) => {
  const electron2 = requireElectron();
  const utilityProcess = electron2["utilityProcess"];
  const child = utilityProcess.fork(options.modulePath, [`--main-pid=${String(options.mainPid)}`], {
    serviceName: "keypress-injector",
    stdio: "inherit"
  });
  return {
    get pid() {
      return child.pid ?? null;
    },
    postMessage: (message) => {
      child.postMessage(message);
    },
    onMessage: (listener) => {
      child.on("message", (message) => {
        listener(message);
      });
    },
    onExit: (listener) => {
      child.on("exit", (code) => {
        listener(code);
      });
    },
    kill: () => {
      child.kill();
    }
  };
};
function defaultProcessTarget() {
  return {
    pid: process.pid,
    on: (event, listener) => {
      process.on(event, listener);
    },
    removeListener: (event, listener) => {
      process.removeListener(event, listener);
    }
  };
}
const SETTINGS_SCHEMA_VERSION = 1;
const PRESETS_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const SETTINGS_FILE = "settings.json";
const PRESETS_FILE = "presets.json";
const STATE_FILE = "state.json";
const DEFAULT_SETTINGS = {
  theme: "system",
  panicHotkey: "CommandOrControl+Alt+Shift+K",
  maxSessionMinutes: 30,
  autoCheckUpdates: true,
  windowsUseVirtualKeys: false
};
const SESSION_MINUTES_BOUNDS = { min: 0, max: 24 * 60 };
const REPEAT_INITIAL_BOUNDS = { min: 1, max: 1e4, fallback: 400 };
const REPEAT_INTERVAL_BOUNDS = { min: 1, max: 1e3, fallback: 33 };
const TAP_INTERVAL_BOUNDS = { min: 10, max: 1e3, fallback: 100 };
const defaultFs$1 = {
  mkdirSync: (path) => {
    nodeFsModule__namespace.mkdirSync(path, { recursive: true });
  },
  readFileSync: (path) => nodeFsModule__namespace.readFileSync(path, "utf8"),
  openSync: (path, flags) => nodeFsModule__namespace.openSync(path, flags),
  writeSync: (fd, data) => {
    nodeFsModule__namespace.writeSync(fd, data);
  },
  fsyncSync: (fd) => {
    nodeFsModule__namespace.fsyncSync(fd);
  },
  closeSync: (fd) => {
    nodeFsModule__namespace.closeSync(fd);
  },
  renameSync: (from, to) => {
    nodeFsModule__namespace.renameSync(from, to);
  },
  unlinkSync: (path) => {
    nodeFsModule__namespace.unlinkSync(path);
  }
};
const THEMES$1 = ["system", "dark", "light"];
const MODES$1 = ["hold", "hold-repeat", "tap"];
function isRecord$1(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const id = nonEmptyString(item);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}
function clampInt(value, bounds) {
  if (typeof value !== "number" || !Number.isFinite(value)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}
function sanitizeMaxSessionMinutes(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_SETTINGS.maxSessionMinutes;
  }
  return Math.min(SESSION_MINUTES_BOUNDS.max, Math.max(SESSION_MINUTES_BOUNDS.min, Math.floor(value)));
}
function sanitizeSettings(raw) {
  if (!isRecord$1(raw)) return { ...DEFAULT_SETTINGS };
  const theme = raw["theme"];
  const panicHotkey = nonEmptyString(raw["panicHotkey"]);
  const maxSessionMinutes = raw["maxSessionMinutes"];
  const autoCheckUpdates = raw["autoCheckUpdates"];
  const windowsUseVirtualKeys = raw["windowsUseVirtualKeys"];
  return {
    theme: THEMES$1.includes(theme) ? theme : DEFAULT_SETTINGS.theme,
    panicHotkey: panicHotkey ?? DEFAULT_SETTINGS.panicHotkey,
    maxSessionMinutes: sanitizeMaxSessionMinutes(maxSessionMinutes),
    autoCheckUpdates: typeof autoCheckUpdates === "boolean" ? autoCheckUpdates : DEFAULT_SETTINGS.autoCheckUpdates,
    windowsUseVirtualKeys: typeof windowsUseVirtualKeys === "boolean" ? windowsUseVirtualKeys : DEFAULT_SETTINGS.windowsUseVirtualKeys
  };
}
function sanitizeConfig(raw) {
  if (!isRecord$1(raw)) return null;
  const mode = raw["mode"];
  if (!MODES$1.includes(mode)) return null;
  return {
    keyIds: stringList(raw["keyIds"]),
    buttonIds: stringList(raw["buttonIds"]),
    targets: stringList(raw["targets"]),
    mode,
    repeatInitialMs: clampInt(raw["repeatInitialMs"], REPEAT_INITIAL_BOUNDS),
    repeatIntervalMs: clampInt(raw["repeatIntervalMs"], REPEAT_INTERVAL_BOUNDS),
    tapIntervalMs: clampInt(raw["tapIntervalMs"], TAP_INTERVAL_BOUNDS)
  };
}
function sanitizePreset(raw, now) {
  if (!isRecord$1(raw)) return null;
  const id = nonEmptyString(raw["id"]);
  const name = nonEmptyString(raw["name"]);
  if (id === null || name === null) return null;
  const config = sanitizeConfig(raw["config"]);
  if (config === null) return null;
  const updatedAt = raw["updatedAt"];
  return {
    id,
    name,
    config,
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : now
  };
}
function sanitizePresets(raw, now) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    const preset = sanitizePreset(item, now);
    if (preset === null || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
  }
  return out;
}
function createStore(deps) {
  const fs = deps.fs ?? defaultFs$1;
  const now = deps.now ?? (() => Date.now());
  const paths = {
    settings: nodePath.join(deps.userDataDir, SETTINGS_FILE),
    presets: nodePath.join(deps.userDataDir, PRESETS_FILE),
    state: nodePath.join(deps.userDataDir, STATE_FILE)
  };
  function writeAtomic(path, payload) {
    const text = JSON.stringify(payload, null, 2);
    const tmp = `${path}.${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`;
    fs.mkdirSync(deps.userDataDir);
    let fd = null;
    try {
      fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
        }
      }
    }
    try {
      fs.renameSync(tmp, path);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
      throw error;
    }
  }
  function readEnvelope(path, currentVersion, migrate) {
    let text;
    try {
      text = fs.readFileSync(path);
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord$1(parsed)) return null;
    const version = parsed["schemaVersion"];
    if (typeof version !== "number" || !Number.isFinite(version)) return null;
    const data = parsed["data"];
    if (version === currentVersion) return data;
    if (migrate === void 0) return null;
    try {
      return migrate(data, version);
    } catch {
      return null;
    }
  }
  function loadPresets() {
    return sanitizePresets(
      readEnvelope(paths.presets, PRESETS_SCHEMA_VERSION, deps.migratePresets),
      now()
    );
  }
  function savePresets(presets) {
    const clean = sanitizePresets(presets, now());
    writeAtomic(paths.presets, { schemaVersion: PRESETS_SCHEMA_VERSION, data: clean });
    return clean;
  }
  let promptUsed = null;
  function readPromptUsed() {
    if (promptUsed !== null) return promptUsed;
    const data = readEnvelope(paths.state, STATE_SCHEMA_VERSION);
    promptUsed = isRecord$1(data) && data["accessibilityPromptUsed"] === true;
    return promptUsed;
  }
  return {
    paths,
    loadSettings() {
      return sanitizeSettings(
        readEnvelope(paths.settings, SETTINGS_SCHEMA_VERSION, deps.migrateSettings)
      );
    },
    saveSettings(settings) {
      const clean = sanitizeSettings(settings);
      writeAtomic(paths.settings, { schemaVersion: SETTINGS_SCHEMA_VERSION, data: clean });
      return clean;
    },
    loadPresets,
    savePresets,
    upsertPreset(preset) {
      const clean = sanitizePreset(preset, now());
      if (clean === null) return loadPresets();
      const next = loadPresets().filter((p) => p.id !== clean.id);
      next.push(clean);
      return savePresets(next);
    },
    deletePreset(id) {
      const next = loadPresets().filter((p) => p.id !== id);
      return savePresets(next);
    },
    promptState: {
      wasUsed: readPromptUsed,
      markUsed() {
        if (readPromptUsed()) return;
        promptUsed = true;
        writeAtomic(paths.state, {
          schemaVersion: STATE_SCHEMA_VERSION,
          data: { accessibilityPromptUsed: true }
        });
      }
    }
  };
}
function parse(input) {
  const trimmed = input.trim();
  const withoutPrefix = /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  const withoutBuild = withoutPrefix.split("+", 1)[0] ?? "";
  const dashAt = withoutBuild.indexOf("-");
  const corePart = dashAt === -1 ? withoutBuild : withoutBuild.slice(0, dashAt);
  const prePart = dashAt === -1 ? "" : withoutBuild.slice(dashAt + 1);
  const release = corePart.split(".").map((piece) => {
    const n = Number.parseInt(piece, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return {
    release,
    prerelease: prePart.length > 0 ? prePart.split(".") : []
  };
}
function cmpNumber(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === void 0) return -1;
    if (bi === void 0) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const c = cmpNumber(Number.parseInt(ai, 10), Number.parseInt(bi, 10));
      if (c !== 0) return c;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < len; i++) {
    const c = cmpNumber(pa.release[i] ?? 0, pb.release[i] ?? 0);
    if (c !== 0) return c;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
function isNewer(candidate, current2) {
  return compare(candidate, current2) === 1;
}
const GITHUB_OWNER = "kidflash2jahaan";
const GITHUB_REPO = "keypress-ultimate";
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const CHECKSUMS_ASSET_NAME = "SHA256SUMS.txt";
const USER_RECHECK_COOLDOWN_MS = 6e4;
const PROGRESS_THROTTLE_MS = 100;
const QUIT_GRACE_MS = 300;
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `KeyPressUltimate (+https://github.com/${GITHUB_OWNER}/${GITHUB_REPO})`
};
function pathFor(platform) {
  return platform === "win32" ? nodePath__namespace.win32 : nodePath__namespace.posix;
}
function macAppBundlePath(execPath) {
  return nodePath__namespace.posix.resolve(execPath, "..", "..", "..");
}
function versionFromTag(tag) {
  const trimmed = tag.trim();
  const withoutPrefix = /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  const ok = /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(withoutPrefix);
  return ok ? withoutPrefix : null;
}
function platformLabel(platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return platform;
}
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}
function asString(value) {
  return typeof value === "string" ? value : null;
}
function parseAsset(value) {
  const record = asRecord(value);
  if (!record) return null;
  const name = asString(record.name);
  const url = asString(record.browser_download_url);
  if (name === null || url === null) return null;
  const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
  return { name, size, browser_download_url: url, digest: asString(record.digest) };
}
function parseRelease(rawJson) {
  const record = asRecord(JSON.parse(rawJson));
  if (!record) return null;
  const tagName = asString(record.tag_name);
  if (tagName === null) return null;
  const assets = Array.isArray(record.assets) ? record.assets.map(parseAsset).filter((asset) => asset !== null) : [];
  return {
    tagName,
    name: asString(record.name) ?? tagName,
    body: asString(record.body) ?? "",
    htmlUrl: asString(record.html_url) ?? RELEASES_PAGE_URL,
    assets
  };
}
function selectReleaseAsset(assets, selector) {
  const { version } = selector;
  const candidates = [];
  if (selector.platform === "darwin") {
    if (selector.arch === "arm64" || selector.arch === "x64") {
      candidates.push(`KeyPress-Ultimate-${version}-${selector.arch}-mac.zip`);
    }
    candidates.push(`KeyPress-Ultimate-${version}-universal-mac.zip`);
  } else if (selector.platform === "win32") {
    candidates.push(
      selector.portable ? `KeyPress-Ultimate-${version}-x64-portable.exe` : `KeyPress-Ultimate-Setup-${version}-x64.exe`
    );
  } else {
    return null;
  }
  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase();
    const found = assets.find((asset) => asset.name.toLowerCase() === wanted);
    if (found) return found;
  }
  return null;
}
function buildMacSwapScript() {
  return `#!/bin/sh
# KeyPress Ultimate in-place update.
# Args: <pid> <staged.app> <target.app> <workdir>
PID="$1"; STAGED="$2"; TARGET="$3"; WORK="$4"
BACKUP="$TARGET.kpu-old"
LOG="$WORK/swap.log"
exec >>"$LOG" 2>&1
echo "--- $(date) waiting for pid $PID to exit ---"
i=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 0.2
  i=$((i+1))
  if [ "$i" -gt 150 ]; then
    echo "timed out waiting for the app to quit; leaving the install untouched"
    exit 1
  fi
done
sleep 0.3
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  echo "could not move the running bundle aside; nothing was changed"
  exit 1
fi
if /usr/bin/ditto "$STAGED" "$TARGET"; then
  /usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  rm -rf "$BACKUP"
  echo "swap ok"
else
  echo "ditto failed; rolling back"
  rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET"
fi
/usr/bin/open -n "$TARGET"
rm -rf "$WORK/extracted"
`;
}
async function* streamOf(body) {
  if (body === null || body === void 0) return;
  const iterable = body;
  if (typeof iterable[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield chunk;
    return;
  }
  const streamed = body;
  const reader = streamed.getReader?.();
  if (!reader) return;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
const defaultFetch = async (url, init) => {
  const globalFetch = globalThis.fetch;
  if (!globalFetch) throw new Error("No fetch implementation is available.");
  const response = await globalFetch(url, {
    headers: init?.headers,
    redirect: init?.redirect ?? "follow"
  });
  const body = response.body;
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: () => response.text(),
    body: body === null || body === void 0 ? null : { [Symbol.asyncIterator]: () => streamOf(body) }
  };
};
const defaultFs = {
  async mkdir(dir) {
    await fsp__namespace.mkdir(dir, { recursive: true });
  },
  async rm(target) {
    await fsp__namespace.rm(target, { recursive: true, force: true });
  },
  async writeFile(file, contents, mode) {
    await fsp__namespace.writeFile(file, contents, mode === void 0 ? void 0 : { mode });
  },
  async readdir(dir) {
    return fsp__namespace.readdir(dir);
  },
  async open(file) {
    const handle = await fsp__namespace.open(file, "w");
    return {
      async write(chunk) {
        await handle.write(chunk);
      },
      async close() {
        await handle.close();
      }
    };
  },
  canWrite(target) {
    try {
      nodeFsModule.accessSync(target, nodeFsModule.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
};
const defaultSpawn = (cmd, args, opts) => {
  const child = node_child_process.spawn(cmd, args, {
    detached: opts?.detached ?? false,
    stdio: "ignore",
    windowsHide: opts?.windowsHide ?? true
  });
  return {
    unref() {
      child.unref();
    },
    onExit(callback) {
      let done = false;
      const once = (code) => {
        if (done) return;
        done = true;
        callback(code);
      };
      child.once("error", () => once(null));
      child.once("close", (code) => once(code));
    }
  };
};
function looksPackaged(execPath, platform) {
  const base = pathFor(platform).basename(execPath).toLowerCase();
  return base !== "electron" && base !== "electron.exe";
}
function createUpdater(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const execPath = overrides.execPath ?? process.execPath;
  const deps = {
    platform,
    arch: overrides.arch ?? process.arch,
    currentVersion: overrides.currentVersion ?? "0.0.0",
    isPackaged: overrides.isPackaged ?? looksPackaged(execPath, platform),
    execPath,
    env: overrides.env ?? process.env,
    pid: overrides.pid ?? process.pid,
    tempDir: overrides.tempDir ?? node_os.tmpdir(),
    now: overrides.now ?? Date.now,
    delay: overrides.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    quit: overrides.quit ?? (() => {
    }),
    log: overrides.log ?? (() => {
    }),
    fetch: overrides.fetch ?? defaultFetch,
    fs: overrides.fs ?? defaultFs,
    spawn: overrides.spawn ?? defaultSpawn
  };
  const paths = pathFor(deps.platform);
  let attempted = false;
  let cached = null;
  let lastAttemptAt = 0;
  function isPortableWindows() {
    if (deps.platform !== "win32") return false;
    const marker = deps.env.PORTABLE_EXECUTABLE_FILE;
    return typeof marker === "string" && marker.length > 0;
  }
  function stagingDir() {
    return paths.join(deps.tempDir, `keypress-ultimate-update-${deps.pid}`);
  }
  async function resolveSha256(asset, assets) {
    const digest = asset.digest;
    if (typeof digest === "string" && digest.toLowerCase().startsWith("sha256:")) {
      return digest.slice("sha256:".length).trim().toLowerCase();
    }
    const sums = assets.find((candidate) => candidate.name === CHECKSUMS_ASSET_NAME);
    if (!sums) return null;
    try {
      const response = await deps.fetch(sums.browser_download_url, {
        headers: { "User-Agent": GITHUB_API_HEADERS["User-Agent"] ?? "KeyPressUltimate" },
        redirect: "follow"
      });
      if (!response.ok) return null;
      const text = await response.text();
      const wanted = asset.name.toLowerCase();
      for (const line of text.split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
        if (!match) continue;
        const hex = match[1];
        const named = match[2];
        if (hex === void 0 || named === void 0) continue;
        if (nodePath__namespace.posix.basename(named.trim()).toLowerCase() === wanted) return hex.toLowerCase();
      }
      return null;
    } catch (error) {
      deps.log("Could not read the published checksums.", error);
      return null;
    }
  }
  async function fetchLatest() {
    const response = await deps.fetch(LATEST_RELEASE_API_URL, { headers: GITHUB_API_HEADERS });
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `GitHub's release API is rate limited right now (HTTP ${response.status}). Unauthenticated checks share a budget of 60 an hour per network, so a school or office connection can use them up. Try again later, or open the Releases page.`
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status} for the latest release.`);
    }
    const release = parseRelease(await response.text());
    if (!release) throw new Error("GitHub returned a release in an unexpected shape.");
    const version = versionFromTag(release.tagName);
    if (version === null) {
      deps.log(`Ignoring release tag "${release.tagName}": not a version number.`);
      return null;
    }
    if (!isNewer(version, deps.currentVersion)) return null;
    const asset = selectReleaseAsset(release.assets, {
      platform: deps.platform,
      arch: deps.arch,
      version,
      portable: isPortableWindows()
    });
    if (!asset) {
      throw new Error(
        `Release ${version} has no download for ${platformLabel(String(deps.platform))} (${deps.arch}).`
      );
    }
    const sha256 = await resolveSha256(asset, release.assets);
    return {
      version,
      notes: release.body,
      url: release.htmlUrl,
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      sha256,
      sizeBytes: asset.size
    };
  }
  async function check(opts = {}) {
    const userInitiated = opts.userInitiated === true;
    if (!userInitiated) {
      if (!deps.isPackaged) return null;
      if (attempted) return cached;
    } else if (attempted && deps.now() - lastAttemptAt < USER_RECHECK_COOLDOWN_MS) {
      return cached;
    }
    attempted = true;
    lastAttemptAt = deps.now();
    try {
      cached = await fetchLatest();
      return cached;
    } catch (error) {
      cached = null;
      deps.log("Update check failed.", error);
      if (userInitiated) throw error;
      return null;
    }
  }
  function canSelfUpdate() {
    if (!deps.isPackaged) {
      return {
        ok: false,
        reason: "This is a development build, so it does not update itself."
      };
    }
    if (deps.platform === "win32") {
      if (isPortableWindows()) {
        return {
          ok: false,
          reason: "This is the portable build, which has no installer to update. Download the new portable .exe and replace this one."
        };
      }
      return { ok: true };
    }
    if (deps.platform !== "darwin") {
      return {
        ok: false,
        reason: `Automatic updates are not available on ${platformLabel(String(deps.platform))}.`
      };
    }
    const bundle = macAppBundlePath(deps.execPath);
    if (bundle.includes("/AppTranslocation/")) {
      return {
        ok: false,
        reason: "KeyPress Ultimate is running from a temporary read-only location. Move it to your Applications folder, reopen it, then update."
      };
    }
    if (!bundle.endsWith(".app")) {
      return {
        ok: false,
        reason: `KeyPress Ultimate is not running from an app bundle (${bundle}), so it cannot replace itself.`
      };
    }
    const parent = nodePath__namespace.posix.dirname(bundle);
    if (!deps.fs.canWrite(parent)) {
      return {
        ok: false,
        reason: `No write permission for ${parent}. Ask an administrator to update KeyPress Ultimate, or download the new version manually.`
      };
    }
    if (!deps.fs.canWrite(bundle)) {
      return {
        ok: false,
        reason: `No write permission for ${bundle}. Ask an administrator to update KeyPress Ultimate, or download the new version manually.`
      };
    }
    return { ok: true };
  }
  async function download(info, onProgress) {
    if (!info.sha256) {
      throw new Error(
        `No SHA-256 was published for ${info.assetName}, so it cannot be verified. Download it from the Releases page instead.`
      );
    }
    const dir = stagingDir();
    const dest = paths.join(dir, info.assetName);
    await deps.fs.rm(dir);
    await deps.fs.mkdir(dir);
    const response = await deps.fetch(info.assetUrl, {
      headers: { "User-Agent": GITHUB_API_HEADERS["User-Agent"] ?? "KeyPressUltimate" },
      redirect: "follow"
    });
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} for ${info.assetName}.`);
    }
    if (!response.body) {
      throw new Error(`Download failed: ${info.assetName} arrived with no body.`);
    }
    const declared = Number(response.headers.get("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : info.sizeBytes;
    const hash = node_crypto.createHash("sha256");
    const sink = await deps.fs.open(dest);
    let bytesDone = 0;
    let lastEmit = Number.NEGATIVE_INFINITY;
    function reportStreaming() {
      const done = total > 0 ? Math.min(bytesDone, Math.max(total - 1, 0)) : bytesDone;
      onProgress({
        bytesDone: done,
        bytesTotal: total,
        percent: total > 0 ? Math.min(99, Math.floor(done / total * 100)) : 0
      });
    }
    try {
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          bytesDone += chunk.length;
          await sink.write(chunk);
          const now = deps.now();
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now;
            reportStreaming();
          }
        }
      } finally {
        await sink.close();
      }
    } catch (error) {
      await deps.fs.rm(dir);
      throw error;
    }
    const actual = hash.digest("hex");
    if (actual !== info.sha256.toLowerCase()) {
      await deps.fs.rm(dir);
      throw new Error(
        `Checksum mismatch for ${info.assetName}. GitHub published ${info.sha256.toLowerCase()} but the download hashed to ${actual}. The file was deleted and nothing was installed.`
      );
    }
    onProgress({ bytesDone, bytesTotal: Math.max(total, bytesDone), percent: 100 });
    return dest;
  }
  function run(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = deps.spawn(cmd, args, { stdio: "ignore" });
      child.onExit((code) => {
        if (code === 0) resolve();
        else reject(new Error(`${nodePath__namespace.posix.basename(cmd)} exited with ${String(code)}.`));
      });
    });
  }
  async function handOffAndQuit(cmd, args) {
    const child = deps.spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    await deps.delay(QUIT_GRACE_MS);
    deps.quit();
  }
  async function installWindows(installerPath) {
    await handOffAndQuit(installerPath, ["/S", "--force-run"]);
  }
  async function installMac(zipPath) {
    const target = macAppBundlePath(deps.execPath);
    const work = nodePath__namespace.posix.dirname(zipPath);
    const extracted = nodePath__namespace.posix.join(work, "extracted");
    await deps.fs.mkdir(extracted);
    await run("/usr/bin/ditto", ["-x", "-k", zipPath, extracted]);
    const entries = await deps.fs.readdir(extracted);
    const appName = entries.find((entry) => entry.toLowerCase().endsWith(".app"));
    if (appName === void 0) {
      throw new Error("The update archive did not contain a .app bundle.");
    }
    const staged = nodePath__namespace.posix.join(extracted, appName);
    try {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
    } catch (error) {
      throw new Error("codesign rejected the downloaded bundle, so it was not installed.", {
        cause: error
      });
    }
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => {
    });
    const script = nodePath__namespace.posix.join(work, "swap.sh");
    await deps.fs.writeFile(script, buildMacSwapScript(), 493);
    await handOffAndQuit("/bin/sh", [script, String(deps.pid), staged, target, work]);
  }
  async function install(info, downloadedPath) {
    const capability = canSelfUpdate();
    if (!capability.ok) {
      throw new Error(capability.reason ?? "KeyPress Ultimate cannot update itself here.");
    }
    if (deps.platform === "win32") {
      await installWindows(downloadedPath);
      return;
    }
    if (deps.platform === "darwin") {
      await installMac(downloadedPath);
      return;
    }
    throw new Error(`Automatic updates are not available on ${platformLabel(String(deps.platform))}.`);
  }
  return { check, download, install, canSelfUpdate };
}
const INTERVAL_MS = { min: 10, max: 1e3 };
const REPEAT_INITIAL_MS = { min: 10, max: 1e4 };
const MAX_SESSION_MINUTES = { min: 0, max: 24 * 60 };
const LIMITS = {
  /** 114 keys exist; the cap is a guard, not a policy. */
  keys: 128,
  buttons: 16,
  targets: 32,
  /** A Windows identity is a full exe path. */
  identityChars: 512,
  presetIdChars: 128,
  presetNameChars: 120
};
const DEFAULTS = {
  repeatInitialMs: 400,
  repeatIntervalMs: 33,
  tapIntervalMs: 100
};
const MODES = /* @__PURE__ */ new Set(["hold", "hold-repeat", "tap"]);
const THEMES = /* @__PURE__ */ new Set(["system", "dark", "light"]);
const DISARM_REASONS = /* @__PURE__ */ new Set([
  "user-stop",
  "focus-lost",
  "target-quit",
  "app-quit",
  "window-closed",
  "uncaught-exception",
  "signal",
  "power-suspend",
  "screen-locked",
  "permission-revoked",
  "heartbeat-timeout",
  "panic-hotkey",
  "max-session-time",
  "injector-error"
]);
const RENDERER_DISARM_REASONS = /* @__PURE__ */ new Set(["user-stop"]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
function isSafeText(value, maxChars) {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && !CONTROL_CHARS.test(value);
}
function clampMs(value, bounds, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}
function uniqueSafeStrings(value, maxChars, maxCount) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= maxCount) break;
    if (!isSafeText(item, maxChars)) continue;
    const trimmed = item.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}
const MALFORMED = "KeyPress Ultimate could not read that request. Reopen the window and try again.";
function parseSessionConfig(raw) {
  if (!isRecord(raw)) return { ok: false, message: MALFORMED };
  const mode = raw["mode"];
  if (typeof mode !== "string" || !MODES.has(mode)) {
    return { ok: false, message: MALFORMED };
  }
  const keyIds = uniqueSafeStrings(raw["keyIds"], LIMITS.identityChars, LIMITS.keys).filter(
    (id) => keys.getKeyById(id) !== void 0
  );
  const buttonIds = uniqueSafeStrings(raw["buttonIds"], LIMITS.identityChars, LIMITS.buttons).filter(
    (id) => keys.getMouseButtonById(id) !== void 0
  );
  const targets = uniqueSafeStrings(raw["targets"], LIMITS.identityChars, LIMITS.targets);
  if (keyIds.length === 0 && buttonIds.length === 0) {
    return {
      ok: false,
      message: "Pick at least one key or mouse button before starting."
    };
  }
  if (targets.length === 0) {
    return {
      ok: false,
      message: "Pick at least one target app. KeyPress Ultimate only holds keys while a target is frontmost."
    };
  }
  return {
    ok: true,
    value: {
      keyIds,
      buttonIds,
      targets,
      mode,
      repeatInitialMs: clampMs(
        raw["repeatInitialMs"],
        REPEAT_INITIAL_MS,
        DEFAULTS.repeatInitialMs
      ),
      repeatIntervalMs: clampMs(raw["repeatIntervalMs"], INTERVAL_MS, DEFAULTS.repeatIntervalMs),
      tapIntervalMs: clampMs(raw["tapIntervalMs"], INTERVAL_MS, DEFAULTS.tapIntervalMs)
    }
  };
}
function parseDisarmReason(raw) {
  if (typeof raw === "string" && DISARM_REASONS.has(raw) && RENDERER_DISARM_REASONS.has(raw)) {
    return raw;
  }
  return "user-stop";
}
function parsePresetId(raw) {
  if (!isSafeText(raw, LIMITS.presetIdChars)) return null;
  const id = raw.trim();
  if (id === "" || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  return id;
}
function parsePreset(raw, now) {
  if (!isRecord(raw)) return { ok: false, message: MALFORMED };
  const id = parsePresetId(raw["id"]);
  if (id === null) return { ok: false, message: MALFORMED };
  const nameRaw = raw["name"];
  if (!isSafeText(nameRaw, LIMITS.presetNameChars)) {
    return { ok: false, message: "A preset needs a name of 120 characters or fewer." };
  }
  const name = nameRaw.trim();
  if (name === "") {
    return { ok: false, message: "A preset needs a name. Type one, then save." };
  }
  const configRaw = raw["config"];
  if (!isRecord(configRaw)) return { ok: false, message: MALFORMED };
  const mode = configRaw["mode"];
  if (typeof mode !== "string" || !MODES.has(mode)) return { ok: false, message: MALFORMED };
  const config = {
    keyIds: uniqueSafeStrings(configRaw["keyIds"], LIMITS.identityChars, LIMITS.keys).filter(
      (keyId) => keys.getKeyById(keyId) !== void 0
    ),
    buttonIds: uniqueSafeStrings(
      configRaw["buttonIds"],
      LIMITS.identityChars,
      LIMITS.buttons
    ).filter((buttonId) => keys.getMouseButtonById(buttonId) !== void 0),
    targets: uniqueSafeStrings(configRaw["targets"], LIMITS.identityChars, LIMITS.targets),
    mode,
    repeatInitialMs: clampMs(
      configRaw["repeatInitialMs"],
      REPEAT_INITIAL_MS,
      DEFAULTS.repeatInitialMs
    ),
    repeatIntervalMs: clampMs(
      configRaw["repeatIntervalMs"],
      INTERVAL_MS,
      DEFAULTS.repeatIntervalMs
    ),
    tapIntervalMs: clampMs(configRaw["tapIntervalMs"], INTERVAL_MS, DEFAULTS.tapIntervalMs)
  };
  const updatedAt = raw["updatedAt"];
  return {
    ok: true,
    value: {
      id,
      name,
      config,
      updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0 ? Math.floor(updatedAt) : now
    }
  };
}
function parseSettingsPatch(raw) {
  if (!isRecord(raw)) return { ok: false, message: MALFORMED };
  const patch = {};
  if ("theme" in raw) {
    const theme = raw["theme"];
    if (typeof theme !== "string" || !THEMES.has(theme)) return { ok: false, message: MALFORMED };
    patch.theme = theme;
  }
  if ("panicHotkey" in raw) {
    const hotkey = raw["panicHotkey"];
    if (!isSafeText(hotkey, 64)) return { ok: false, message: MALFORMED };
    patch.panicHotkey = hotkey.trim();
  }
  if ("maxSessionMinutes" in raw) {
    const minutes = raw["maxSessionMinutes"];
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
      return { ok: false, message: MALFORMED };
    }
    patch.maxSessionMinutes = Math.min(
      MAX_SESSION_MINUTES.max,
      Math.max(MAX_SESSION_MINUTES.min, Math.floor(minutes))
    );
  }
  if ("autoCheckUpdates" in raw) {
    const value = raw["autoCheckUpdates"];
    if (typeof value !== "boolean") return { ok: false, message: MALFORMED };
    patch.autoCheckUpdates = value;
  }
  if ("windowsUseVirtualKeys" in raw) {
    const value = raw["windowsUseVirtualKeys"];
    if (typeof value !== "boolean") return { ok: false, message: MALFORMED };
    patch.windowsUseVirtualKeys = value;
  }
  return { ok: true, value: patch };
}
const UNTRUSTED_SENDER = "KeyPress Ultimate ignored a message from an unexpected sender.";
function registerIpcHandlers(deps) {
  const now = deps.now ?? (() => Date.now());
  const onError = deps.onError ?? (() => void 0);
  const registered = [];
  function handle(channel, run) {
    if (!keys.ALL_IPC_CHANNELS.includes(channel)) {
      throw new Error(`refusing to register an IPC handler for the unknown channel "${channel}"`);
    }
    if (registered.includes(channel)) {
      throw new Error(`an IPC handler for "${channel}" is already registered`);
    }
    registered.push(channel);
    deps.ipcMain.handle(channel, async (event, ...args) => {
      if (deps.isTrustedSender !== void 0 && !deps.isTrustedSender(event)) {
        throw new Error(UNTRUSTED_SENDER);
      }
      return run(args);
    });
  }
  async function safely(label, run, fallback) {
    try {
      return await run();
    } catch (error) {
      onError(label, error);
      return fallback;
    }
  }
  async function surfacing(label, run) {
    try {
      return await run();
    } catch (error) {
      onError(label, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  handle(keys.IPC_INVOKE.systemInfo, async () => deps.systemInfo());
  handle(keys.IPC_INVOKE.appsList, async () => safely("apps:list", () => deps.apps.list(), []));
  handle(
    keys.IPC_INVOKE.appsRefresh,
    async () => safely("apps:refresh", () => deps.apps.refresh(), [])
  );
  handle(keys.IPC_INVOKE.sessionArm, async (args) => {
    const parsed = parseSessionConfig(args[0]);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    return safely("session:arm", () => deps.session.arm(parsed.value), {
      ok: false,
      message: "KeyPress Ultimate could not start the session. Restart the app and try again."
    });
  });
  handle(keys.IPC_INVOKE.sessionDisarm, async (args) => {
    const reason = parseDisarmReason(args[0]);
    await safely("session:disarm", () => deps.session.disarm(reason), void 0);
    return void 0;
  });
  handle(keys.IPC_INVOKE.sessionGetState, async () => deps.session.getState());
  handle(keys.IPC_INVOKE.permissionsGet, async () => deps.permissions.get());
  handle(keys.IPC_INVOKE.permissionsOpenSettings, async () => {
    await safely(
      "permissions:open-settings",
      () => deps.permissions.openSettings(),
      void 0
    );
    return void 0;
  });
  handle(keys.IPC_INVOKE.presetsList, async () => safely("presets:list", () => deps.presets.list(), []));
  handle(keys.IPC_INVOKE.presetsSave, async (args) => {
    const parsed = parsePreset(args[0], now());
    if (!parsed.ok) {
      onError("presets:save", new Error(parsed.message));
      return safely("presets:list", () => deps.presets.list(), []);
    }
    return safely("presets:save", () => deps.presets.save(parsed.value), []);
  });
  handle(keys.IPC_INVOKE.presetsDelete, async (args) => {
    const id = parsePresetId(args[0]);
    if (id === null) return safely("presets:list", () => deps.presets.list(), []);
    return safely("presets:delete", () => deps.presets.remove(id), []);
  });
  handle(keys.IPC_INVOKE.settingsGet, async () => deps.settings.get());
  handle(keys.IPC_INVOKE.settingsSet, async (args) => {
    const parsed = parseSettingsPatch(args[0]);
    const current2 = deps.settings.get();
    if (!parsed.ok) {
      onError("settings:set", new Error(parsed.message));
      return current2;
    }
    return safely("settings:set", () => deps.settings.set(parsed.value), current2);
  });
  handle(keys.IPC_INVOKE.updatesCheck, async () => surfacing("updates:check", () => deps.updates.check()));
  handle(keys.IPC_INVOKE.updatesDownload, async () => {
    await surfacing("updates:download", () => deps.updates.download());
    return void 0;
  });
  handle(keys.IPC_INVOKE.updatesInstall, async () => {
    await surfacing("updates:install", () => deps.updates.install());
    return void 0;
  });
  handle(keys.IPC_INVOKE.updatesOpenReleasesPage, async () => {
    await safely("updates:open-releases-page", () => deps.updates.openReleasesPage(), void 0);
    return void 0;
  });
  handle(keys.IPC_INVOKE.windowMinimize, async () => {
    await safely("window:minimize", () => deps.window.minimize(), void 0);
    return void 0;
  });
  handle(keys.IPC_INVOKE.windowClose, async () => {
    await safely("window:close", () => deps.window.close(), void 0);
    return void 0;
  });
  return () => {
    for (const channel of registered) {
      try {
        deps.ipcMain.removeHandler(channel);
      } catch (error) {
        onError(`failed to remove the handler for ${channel}`, error);
      }
    }
    registered.length = 0;
  };
}
const WINDOW_DEFAULT_SIZE = { width: 1180, height: 820 };
const WINDOW_MIN_SIZE = { width: 1100, height: 760 };
const WINDOW_BACKGROUND_DARK = "#0b0b0d";
const WINDOW_BACKGROUND_LIGHT = "#f4f4f2";
const WINDOW_BACKGROUND = WINDOW_BACKGROUND_DARK;
function backgroundFor(dark) {
  return dark ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT;
}
let current = null;
function getMainWindow() {
  if (current === null || current.isDestroyed()) return null;
  return current;
}
function focusMainWindow() {
  const window = getMainWindow();
  if (window === null) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return true;
}
function createMainWindow(options = {}) {
  const platform = options.platform ?? process.platform;
  const onError = options.onError ?? (() => void 0);
  const isMac = platform === "darwin";
  const constructorOptions = {
    width: WINDOW_DEFAULT_SIZE.width,
    height: WINDOW_DEFAULT_SIZE.height,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    title: "KeyPress Ultimate",
    // macOS keeps its traffic lights in the inset the renderer's title bar
    // reserves. Windows draws its own controls, so it gets no frame at all.
    ...isMac ? { titleBarStyle: "hiddenInset" } : { frame: false },
    webPreferences: {
      preload: options.preloadPath ?? nodePath.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // koffi lives in main and the injector, never in the renderer. The
      // preload still needs Node to reach contextBridge.
      sandbox: false,
      webviewTag: false,
      spellcheck: false
    }
  };
  const window = new electron.BrowserWindow(constructorOptions);
  current = window;
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (current === window) current = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void electron.shell.openExternal(url).catch(() => void 0);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const target = options.rendererUrl;
    const allowed = target !== void 0 && target !== "" && url.startsWith(target);
    if (!allowed) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  const devServerUrl = options.rendererUrl;
  const load = devServerUrl !== void 0 && devServerUrl !== "" ? window.loadURL(devServerUrl) : window.loadFile(options.rendererFile ?? nodePath.join(__dirname, "../renderer/index.html"));
  load.catch((error) => {
    onError("failed to load the renderer", error);
  });
  return window;
}
function isExternalHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
const APP_ID = "com.keypressultimate.app";
const EVENT_CHANNELS = {
  sessionState: keys.IPC_EVENT.sessionState,
  appsChanged: keys.IPC_EVENT.appsChanged,
  permissionsChanged: keys.IPC_EVENT.permissionsChanged,
  updateAvailable: keys.IPC_EVENT.updateAvailable,
  updateProgress: keys.IPC_EVENT.updateProgress,
  recoveryNotice: keys.IPC_EVENT.recoveryNotice
};
const QUIT_RELEASE_TIMEOUT_MS = 2e3;
function log(message, error) {
  if (error === void 0) console.error(`[keypress] ${message}`);
  else console.error(`[keypress] ${message}`, error);
}
function currentPlatform() {
  return process.platform === "darwin" ? "darwin" : "win32";
}
if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    focusMainWindow();
  });
  if (process.platform === "win32") electron.app.setAppUserModelId(APP_ID);
  void bootstrap();
}
async function bootstrap() {
  try {
    await electron.app.whenReady();
  } catch (error) {
    log("the app never became ready", error);
    electron.app.quit();
    return;
  }
  const store = createStore({ userDataDir: electron.app.getPath("userData") });
  let settings = store.loadSettings();
  applyTheme(settings.theme);
  electron.nativeTheme.on("updated", () => {
    getMainWindow()?.setBackgroundColor(backgroundFor(electron.nativeTheme.shouldUseDarkColors));
  });
  let native = null;
  try {
    const bound = await index.createNativeInput();
    await bound.init();
    native = bound;
  } catch (error) {
    log("could not bind the native input layer", error);
  }
  const nativeInput = native;
  function releaseDirectly(keyIds, buttonIds) {
    return releaseInputDirectly({ native: nativeInput, keyIds, buttonIds, onError: log });
  }
  const registry = createAppRegistry({
    native: {
      listApplications: () => nativeInput === null ? [] : nativeInput.listApplications()
    },
    selfIdentity: currentPlatform() === "darwin" ? APP_ID : electron.app.getPath("exe"),
    selfPids: [process.pid]
  });
  const icons = createIconCache({
    // Electron insists on a size; the cache treats it as optional. 'normal' is
    // 32px on macOS, which is the cap `getFileIcon` honours anyway.
    getFileIcon: (path, options) => electron.app.getFileIcon(path, { size: options?.size ?? "normal" })
  });
  const focus = createFocusWatcher({
    native: {
      getFrontmostPid: () => nativeInput === null ? null : nativeInput.getFrontmostPid()
    },
    registry,
    // The registry excludes us so we can never be targeted; the focus readout
    // still needs to name us, or the strip says "Unknown" about this very app.
    selfApp: {
      // Same identity rule the registry uses, so "is this us?" answers
      // identically on both sides.
      identity: currentPlatform() === "darwin" ? APP_ID : electron.app.getPath("exe"),
      name: electron.app.getName(),
      pid: process.pid,
      path: electron.app.getPath("exe")
    },
    selfPids: [process.pid]
  });
  let focusedApp = null;
  async function listApps() {
    return icons.decorate(registry.list());
  }
  async function refreshApps() {
    const apps = await icons.decorate(registry.refresh());
    emit("appsChanged", apps);
    return apps;
  }
  const permissions = createPermissions({
    platform: process.platform,
    isTrusted: (prompt) => {
      const prefs = electron.systemPreferences;
      if (typeof prefs.isTrustedAccessibilityClient !== "function") return true;
      return prefs.isTrustedAccessibilityClient(prompt);
    },
    // Persisted, because macOS shows its Accessibility prompt once per app
    // identity and the UI has to stop offering a button that does nothing.
    promptState: store.promptState
  });
  function permissionView() {
    const status = permissions.status();
    return {
      needsPermission: status.needsPermission,
      hasPermission: status.hasPermission,
      promptWasAlreadyUsed: status.promptWasAlreadyUsed
    };
  }
  permissions.onChange(() => {
    emit("permissionsChanged", permissionView());
  });
  permissions.check();
  permissions.start();
  const journal = new HoldJournal({
    directory: electron.app.getPath("userData"),
    onError: (stage, error) => {
      log(`journal ${stage} failed`, error);
    }
  });
  const recovery = recoverStaleJournal({
    journal,
    replay: (plan) => releaseDirectly(plan.keyIds, plan.buttonIds),
    onError: (error) => {
      log("could not replay the crash journal", error);
    }
  });
  if (recovery.message !== null) log(recovery.message);
  const powerMonitorAdapter = {
    on: (event, listener) => {
      electron.powerMonitor.on(event, listener);
    },
    removeListener: (event, listener) => {
      electron.powerMonitor.removeListener(event, listener);
    }
  };
  const controller = new SessionController({
    settings,
    journal,
    globalShortcut: electron.globalShortcut,
    powerMonitor: powerMonitorAdapter,
    powerSaveBlocker: electron.powerSaveBlocker,
    permissions: { hasPermission: () => permissions.status().hasPermission },
    resolveApp: (pid) => pid === null ? null : registry.findByPid(pid),
    resolveTargetName: (identity) => registry.findByIdentity(identity)?.name ?? null,
    releaseFallback: nativeInput === null ? null : releaseDirectly,
    onError: (message, error) => {
      log(message, error);
    }
  });
  const detachFailsafes = controller.attachProcessFailsafes();
  function withFocus(state) {
    return state.focusedApp === null ? { ...state, focusedApp } : state;
  }
  controller.onState((state) => {
    emit("sessionState", withFocus(state));
  });
  focus.onChange((next, pid) => {
    focusedApp = next;
    if (next === null && pid !== null && pid !== process.pid) {
      registry.invalidate();
      void refreshApps().catch((error) => {
        log("could not refresh the app list", error);
      });
    }
    if (!controller.isArmed) emit("sessionState", withFocus(controller.getState()));
  });
  focus.start();
  const updater = createUpdater({
    currentVersion: electron.app.getVersion(),
    isPackaged: electron.app.isPackaged,
    tempDir: electron.app.getPath("temp"),
    // The swap runs in a detached process that waits for this one to exit, so
    // the quit is part of the install rather than something the user does
    // afterwards. It goes through `app.quit()`, which means it goes through
    // `before-quit`, which means the keys are released on the way out.
    quit: () => {
      electron.app.quit();
    },
    log: (message, detail) => {
      log(`updater: ${message}`, detail);
    }
  });
  let latestUpdate = null;
  let downloadedPath = null;
  function reportProgress(progress) {
    const total = progress.bytesTotal > 0 ? progress.bytesTotal : 0;
    const done = Math.max(0, Math.min(progress.bytesDone, total === 0 ? progress.bytesDone : total));
    const raw = total > 0 ? done / total : progress.percent > 1 ? progress.percent / 100 : progress.percent;
    const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    emit("updateProgress", { receivedBytes: done, totalBytes: total, fraction });
  }
  async function checkForUpdates(userInitiated) {
    const info = await updater.check({ userInitiated });
    if (info === null || latestUpdate === null || info.version !== latestUpdate.version) {
      downloadedPath = null;
    }
    latestUpdate = info;
    emit("updateAvailable", info);
    return info;
  }
  async function downloadUpdate() {
    const info = latestUpdate ?? await checkForUpdates(true);
    if (info === null) return;
    const capability = updater.canSelfUpdate();
    if (!capability.ok) {
      log(`self-update is unavailable: ${capability.reason ?? "unknown reason"}`);
      await openReleasesPage();
      return;
    }
    downloadedPath = await updater.download(info, reportProgress);
  }
  async function installUpdate() {
    const info = latestUpdate;
    if (info === null) return;
    if (downloadedPath === null) {
      await downloadUpdate();
      if (downloadedPath === null) return;
    }
    await updater.install(info, downloadedPath);
  }
  async function openReleasesPage() {
    await electron.shell.openExternal(RELEASES_PAGE_URL);
  }
  function emit(name, payload) {
    const window = getMainWindow();
    if (window === null) return;
    const contents = window.webContents;
    if (contents.isDestroyed()) return;
    contents.send(EVENT_CHANNELS[name], payload);
  }
  const systemInfo = () => ({
    platform: currentPlatform(),
    appVersion: electron.app.getVersion(),
    isPackaged: electron.app.isPackaged
  });
  const removeIpcHandlers = registerIpcHandlers({
    ipcMain: electron.ipcMain,
    systemInfo,
    apps: {
      list: listApps,
      refresh: refreshApps
    },
    session: {
      // The controller's refusal carries a machine-readable code the renderer
      // has no use for, so only the sentence crosses the boundary.
      arm: (config) => {
        const result = controller.arm(config);
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      },
      disarm: (reason) => {
        controller.disarm(reason);
      },
      getState: () => withFocus(controller.getState())
    },
    permissions: {
      get: permissionView,
      openSettings: async () => {
        await permissions.request();
        await electron.shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
        emit("permissionsChanged", permissionView());
      }
    },
    presets: {
      list: () => store.loadPresets(),
      save: (preset) => store.upsertPreset(preset),
      remove: (id) => store.deletePreset(id)
    },
    settings: {
      get: () => settings,
      set: (patch) => {
        const next = store.saveSettings({ ...settings, ...patch });
        settings = next;
        applyTheme(next.theme);
        controller.setSettings(next);
        return next;
      }
    },
    updates: {
      check: () => checkForUpdates(true),
      download: downloadUpdate,
      install: installUpdate,
      openReleasesPage
    },
    window: {
      minimize: () => {
        getMainWindow()?.minimize();
      },
      close: () => {
        getMainWindow()?.close();
      }
    },
    // Only the window we made is allowed to talk to us. A message from any
    // other webContents is refused before its payload is even parsed.
    isTrustedSender: (event) => {
      const window = getMainWindow();
      return window !== null && event.sender === window.webContents;
    },
    onError: (message, error) => {
      log(message, error);
    }
  });
  function openWindow() {
    const window = createMainWindow({
      rendererUrl: process.env["ELECTRON_RENDERER_URL"],
      platform: process.platform,
      onError: (message, error) => {
        log(message, error);
      }
    });
    window.setBackgroundColor(backgroundFor(electron.nativeTheme.shouldUseDarkColors));
    window.webContents.on("did-finish-load", () => {
      if (recovery.releasedCount > 0) {
        emit("recoveryNotice", { count: recovery.releasedCount });
      } else if (recovery.outcome === "replay-failed" && recovery.message !== null) {
        void electron.dialog.showMessageBox(window, {
          type: "warning",
          title: "Some keys may still be held",
          message: "Some keys may still be held",
          detail: recovery.message,
          buttons: ["OK"],
          noLink: true
        }).catch((error) => {
          log("could not show the failed-recovery notice", error);
        });
      }
      emit("permissionsChanged", permissionView());
      emit("sessionState", withFocus(controller.getState()));
      void listApps().then((apps) => {
        emit("appsChanged", apps);
      }).catch((error) => {
        log("could not send the app list", error);
      });
      if (settings.autoCheckUpdates) {
        void checkForUpdates(false).catch((error) => {
          log("the startup update check failed", error);
        });
      }
    });
  }
  let quitting = false;
  openWindow();
  function disarmAndWait(reason) {
    if (!controller.isArmed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = controller.onRelease((event) => {
        if (event.hardStop) finish();
      });
      const timer = setTimeout(finish, QUIT_RELEASE_TIMEOUT_MS);
      controller.disarm(reason);
    });
  }
  async function shutdown() {
    try {
      await disarmAndWait("app-quit");
    } catch (error) {
      log("the shutdown release failed", error);
    }
    try {
      controller.dispose();
      detachFailsafes();
      focus.stop();
      permissions.stop();
      removeIpcHandlers();
      electron.globalShortcut.unregisterAll();
      nativeInput?.dispose();
    } catch (error) {
      log("shutdown cleanup failed", error);
    }
  }
  electron.app.on("window-all-closed", () => {
    electron.app.quit();
  });
  electron.app.on("activate", () => {
    if (quitting) return;
    if (electron.BrowserWindow.getAllWindows().length === 0) openWindow();
  });
  electron.app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => {
      electron.app.quit();
    });
  });
}
function applyTheme(theme) {
  electron.nativeTheme.themeSource = theme;
  getMainWindow()?.setBackgroundColor(backgroundFor(electron.nativeTheme.shouldUseDarkColors));
}
