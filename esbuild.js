const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Baked in at build time, not read at runtime — so a real release install can't be pointed at a
// non-production TraceRoost Pro environment just by setting TRACEROOST_ORG_ENV/_URL in the
// shell or a .env file. See src/cloud/org/config.ts's resolveOrgEnvironment().
const releaseDefine = { 'process.env.TRACEROOST_RELEASE_BUILD': production ? '"1"' : '""' };

function copySqlWasm() {
  const sqlJsDir = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
  const distDir  = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.copyFileSync(path.join(sqlJsDir, 'sql-wasm.wasm'), path.join(distDir, 'sql-wasm.wasm'));
  fs.copyFileSync(path.join(sqlJsDir, 'sql-wasm.js'),   path.join(distDir, 'sql-wasm.js'));
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'sql.js'],
		define: releaseDefine,
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});

	const mediaCtx = await esbuild.context({
		entryPoints: ['media/src/dashboard.tsx'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'media/dashboard.js',
		jsx: 'automatic',
		jsxImportSource: 'preact',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	const sidebarCtx = await esbuild.context({
		entryPoints: ['media/src/sidebarWebview.ts'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'media/sidebar.js',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	const standaloneCtx = await esbuild.context({
		entryPoints: ['standalone/server.ts'],
		bundle: true,
		format: 'cjs',
		minify: false,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'standalone/server.js',
		define: releaseDefine,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	const cliCtx = await esbuild.context({
		entryPoints: ['standalone/cli.ts'],
		bundle: true,
		format: 'cjs',
		minify: false,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'standalone/cli.js',
		define: releaseDefine,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	copySqlWasm();

	if (watch) {
		await ctx.watch();
		await mediaCtx.watch();
		await sidebarCtx.watch();
		await standaloneCtx.watch();
		await cliCtx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		await mediaCtx.rebuild();
		await mediaCtx.dispose();
		await sidebarCtx.rebuild();
		await sidebarCtx.dispose();
		await standaloneCtx.rebuild();
		await standaloneCtx.dispose();
		await cliCtx.rebuild();
		await cliCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
