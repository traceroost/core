import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Match .mocharc.cjs (used by `test:unit`) -- some tests wait on real timers past mocha's
	// 2000ms default (e.g. forward/scheduler.test.ts's drainSoon case).
	mocha: { timeout: 10000 },
});
