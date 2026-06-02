import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-hosted Inter font (replaces Google Fonts <link> in index.html).
// Each weight is a separate CSS file; Vite bundles them into the output.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

import './index.css'
import App from './App.tsx'
import { AuthProvider } from './contexts/AuthContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
