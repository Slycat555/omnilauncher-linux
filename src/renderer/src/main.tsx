import './theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
