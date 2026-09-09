// SCAFFOLD PLACEHOLDER. Task 9 owns the real UI. This renders the shared key
// data so the renderer pipeline is provably wired end to end.
import type { JSX } from 'react'
import { getBaseKeys } from '@shared/keys'

export function App(): JSX.Element {
  return (
    <main>
      <h1>KeyPress Ultimate</h1>
      <p>{getBaseKeys().length} keys loaded.</p>
    </main>
  )
}
