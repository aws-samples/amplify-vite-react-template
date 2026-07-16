import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // Plain glob (no path.resolve) — chokidar treats backslashes as glob
      // escapes, so a Windows-style resolved path never matches here.
      ignored: ['**/creative/**'],
    },
  },
})
