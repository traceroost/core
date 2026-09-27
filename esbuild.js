const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// ── Edition ──────────────────────────────────────────────────────────────────
// `--edition=full` (the default — dev, tests and CI's main job all build this) bundles TraceRoost
// Pro's org linking and uploading (src/cloud/**, media/src/cloud/**, standalone/cloud/**).
// `--edition=core` builds without any of it: the three seams below resolve to inert stubs, and
// the build fails outright if any module under a cloud/ directory would still be bundled.
// `TRACEROOST_EDITION=core` in the environment works too (the flag wins), so `npm publish`'s
// prepublish build can be pointed at an edition. See runbooks/RELEASING.md → "Editions".
const editionArg = process.argv.find(a => a.startsWith('--edition'));
const edition = editionArg
	? (editionArg.includes('=') ? editionArg.split('=')[1] : process.argv[process.argv.indexOf(editionArg) + 1])
	: (process.env.TRACEROOST_EDITION || 'full');
if (edition !== 'full' && edition !== 'core') {
	console.error(`esbuild.js: unknown edition "${edition}" — expected full or core`);
	process.exit(1);
}
const core = edition === 'core';

// Baked in at build time, not read at runtime — so a real release install can't be pointed at a
// non-production TraceRoost Pro environment just by setting TRACEROOST_ORG_ENV/_URL in the
// shell or a .env file. See src/cloud/org/config.ts's resolveOrgEnvironment().
// TRACEROOST_EDITION is baked in the same way: `process.env.TRACEROOST_EDITION !== 'core'` checks
// in the sources fold to a constant, so the core bundles drop the Pro-only branches entirely.
const releaseDefine = {
	'process.env.TRACEROOST_RELEASE_BUILD': production ? '"1"' : '""',
	'process.env.TRACEROOST_EDITION': JSON.stringify(edition),
};
// The webview bundle has no `process` at all — define the edition there too (both editions).
const mediaDefine = { 'process.env.TRACEROOST_EDITION': JSON.stringify(edition) };

// Each seam's full implementation → its core stub. Every import of a key resolves to its value
// in a core build; nothing else changes. Keep in step with src/cloudBridge.ts,
// media/src/orgPanel.ts and standalone/cliCloud.ts.
const CORE_SWAPS = {
	'src/cloud/bridge': 'src/cloudBridge.core.ts',
	'media/src/cloud/panels/OrgPanel': 'media/src/orgPanel.core.tsx',
	'standalone/cloud/cliBridge': 'standalone/cliCloud.core.ts',
};
const CLOUD_DIRS = ['src/cloud', 'media/src/cloud', 'standalone/cloud'].map(d => path.join(__dirname, d) + path.sep);

/**
 * Core edition only: swaps each seam for its stub, then refuses to load anything under a cloud/
 * directory — so a new direct import of cloud code from a local module fails the core build
 * instead of silently shipping it. scripts/check-edition.mjs re-checks the output afterwards.
 * @type {import('esbuild').Plugin}
 */
const coreEditionPlugin = {
	name: 'traceroost-core-edition',
	setup(build) {
		const swaps = new Map(Object.entries(CORE_SWAPS).map(([from, to]) => [path.join(__dirname, from), path.join(__dirname, to)]));
		build.onResolve({ filter: /^\.\.?\// }, args => {
			const target = path.resolve(args.resolveDir, args.path).replace(/\.(js|ts|tsx)$/, '');
			const swap = swaps.get(target);
			return swap ? { path: swap } : undefined;
		});
		build.onLoad({ filter: /[\\/]cloud[\\/]/ }, args => {
			if (!CLOUD_DIRS.some(dir => args.path.startsWith(dir))) return undefined;
			return { errors: [{ text: `core edition must not bundle cloud code: ${path.relative(__dirname, args.path)} — route it through a seam (src/cloudBridge.ts, media/src/orgPanel.ts, standalone/cliCloud.ts)` }] };
		});
	},
};
const editionPlugins = core ? [coreEditionPlugin] : [];

// jsonc-parser's `main` is a UMD build whose internal require('./impl/...') calls esbuild can't
// follow, so the bundle would throw "Cannot find module './impl/format'" at runtime. Point the
// Node bundles at its ESM build instead (src/autoConfigNode.ts).
const nodeAlias = { 'jsonc-parser': path.join(__dirname, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js') };

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
				if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	console.log(`[esbuild] edition: ${edition}${production ? ' (production)' : ''}`);
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
		alias: nodeAlias,
		logLevel: 'silent',
		plugins: [
			...editionPlugins,
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
		define: mediaDefine,
		logLevel: 'silent',
		plugins: [...editionPlugins, esbuildProblemMatcherPlugin],
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
		define: mediaDefine,
		logLevel: 'silent',
		plugins: [...editionPlugins, esbuildProblemMatcherPlugin],
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
		// Not minified (identifiers and layout stay readable), but in the core edition syntax-level
		// dead-code elimination is on, so `if (process.env.TRACEROOST_EDITION !== 'core')` branches
		// are actually dropped rather than left behind as `if (false) { … }`.
		minifySyntax: core,
		define: releaseDefine,
		alias: nodeAlias,
		logLevel: 'silent',
		plugins: [...editionPlugins, esbuildProblemMatcherPlugin],
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
		minifySyntax: core, // see the server bundle above
		// cli.ts only reaches the server via `import('./server.js')` — left external, that's a
		// runtime require of the sibling standalone/server.js (built just above, and shipped next to
		// cli.js in the npm package), instead of a second copy of the whole server bundle inlined
		// here that every `traceroost <subcommand>` had to read and compile before doing anything.
		external: ['./server.js'],
		define: releaseDefine,
		alias: nodeAlias,
		logLevel: 'silent',
		plugins: [...editionPlugins, esbuildProblemMatcherPlugin],
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
