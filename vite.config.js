import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built index.html works when opened via
  // file:// inside Electron, not just from a server root.
  base: './',
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
})
