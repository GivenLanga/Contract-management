import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devServerPort = Number.parseInt(process.env.VITE_DEV_SERVER_PORT || '5174', 10)

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: devServerPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
})
