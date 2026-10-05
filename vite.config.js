import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineShell } from './scripts/pwa-build.mjs';

const host = process.env.TAURI_DEV_HOST;

// https://tauri.app/start/frontend/vite/
export default defineConfig({
    plugins: [react(),offlineShell()],
    clearScreen: false,
    server: {
        host: host || false,
        port: 1420,
        strictPort: true,
        hmr: host
            ? { protocol: 'ws', host, port: 1421 }
            : undefined,
        watch: {
            // Avoid Vite watching Rust files
            ignored: ['**/src-tauri/**'],
        },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    build: {
        rollupOptions: { output: { manualChunks: {calendarParser:['ical.js']} } },
        // Tauri requires a modern target
        target:
            process.env.TAURI_ENV_PLATFORM === 'windows'
                ? 'chrome105'
                : 'safari13',
        minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
});
