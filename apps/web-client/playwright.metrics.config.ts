import { defineConfig } from '@playwright/test';

// UI and transport regression checks with a loopback mock API; no database or models.
export default defineConfig({
	testDir: './tests/request-body',
	testMatch: ['run-metrics.spec.ts', 'transport.spec.ts'],
	workers: 1,
	use: { baseURL: 'http://127.0.0.1:3102' },
	webServer: {
		command: 'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3102',
		url: 'http://127.0.0.1:3102/auth/signin',
		reuseExistingServer: false,
		env: {
			SERVER_API_URL: 'http://127.0.0.1:3103',
			APP_ORIGIN: 'http://127.0.0.1:3102',
			AUTH_PROXY_SECRET: 'metrics-browser-test-fixture',
		},
		gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
	},
});
