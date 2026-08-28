import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { api } from './services/api'
import { detectAppPlatform } from './utils/platform'
import './styles.css'

document.documentElement.dataset.platform = detectAppPlatform(api.isDesktop, navigator.userAgent)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
