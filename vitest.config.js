import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        // Unit/integration tests live under src/. e2e/ is Playwright's turf.
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
});
