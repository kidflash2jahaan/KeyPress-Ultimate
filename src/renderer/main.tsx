// SCAFFOLD PLACEHOLDER. Task 9 owns the real entry (store wiring, mock bridge,
// theme bootstrapping).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (container === null) throw new Error('renderer: #root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
