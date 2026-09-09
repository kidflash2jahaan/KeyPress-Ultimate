export type Platform = 'darwin' | 'win32'
export type KeySection = 'function' | 'alphanum' | 'navigation' | 'numpad'

export interface KeyDef {
  id: string; label: string; subLabel?: string
  macLabel?: string; winLabel?: string
  section: KeySection; row: number
  unitWidth: number; unitHeight: number
  macKeyCode: number | null
  winVirtualKey: number | null; winScanCode: number | null; winExtended: boolean
  isModifier: boolean; holdable: boolean; extra?: boolean; notes?: string
}

export type MouseButtonId = 'left' | 'right' | 'middle' | 'back' | 'forward' | 'wheel-up' | 'wheel-down'

export interface MouseDef {
  id: MouseButtonId; label: string; description: string; holdable: boolean
  macButton: number | null; macDownType: number | null; macUpType: number | null
  winFlagDown: number | null; winFlagUp: number | null; winMouseData: number
}

/** identity is bundleId on macOS, lowercased exe path on Windows. Stable across restarts. */
export interface AppInfo {
  identity: string; name: string; pid: number
  path: string | null; iconDataUrl?: string
}

export type HoldMode = 'hold' | 'hold-repeat' | 'tap'

export interface SessionConfig {
  keyIds: string[]; buttonIds: string[]; targets: string[]
  mode: HoldMode
  repeatInitialMs: number; repeatIntervalMs: number; tapIntervalMs: number
}

export type SessionPhase = 'idle' | 'armed-waiting' | 'firing' | 'blocked' | 'error'

export interface SessionState {
  phase: SessionPhase
  startedAt: number | null
  firingKeyIds: string[]; firingButtonIds: string[]
  focusedApp: AppInfo | null
  onTarget: boolean
  message: string | null
}

export interface Preset { id: string; name: string; config: SessionConfig; updatedAt: number }

export interface Settings {
  theme: 'system' | 'dark' | 'light'
  panicHotkey: string           // Electron accelerator, default 'CommandOrControl+Alt+Shift+K'
  maxSessionMinutes: number     // 0 = unlimited, default 30
  autoCheckUpdates: boolean
  windowsUseVirtualKeys: boolean  // fallback for titles that ignore scancodes
}

export interface UpdateInfo {
  version: string; notes: string; url: string
  assetName: string; assetUrl: string; sha256: string | null; sizeBytes: number
}
