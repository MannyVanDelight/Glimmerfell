import { defineConfig, type Plugin } from 'vite';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Two layouts, same code:
 * - Working folder (03_web): data files in ./public, build to ./dist.
 * - Glimmerfell repository (tools/configurator/_source): the data files ARE the published folder
 *   above (`..`: config.json, assets/, textures/ …). The build writes only index.html and app/
 *   there, so a build + commit + push publishes. Jekyll (GitHub Pages) skips "_source".
 */
const IN_REPO = !existsSync(resolve(__dirname, 'public')) && existsSync(resolve(__dirname, '../config.json'));
const PUB = IN_REPO ? resolve(__dirname, '..') : resolve(__dirname, 'public');

/**
 * Development only (not in the build), used from the browser console:
 * - POST /__dev/save-thumb?name=looks/<id>.jpg with a JPEG data URL writes <data>/thumbs/<name>
 *   (configurator.makeLookThumbs()).
 * - POST /__dev/save-codes with the code file writes <data>/codes.json (configurator.saveCodeVersion()).
 */
function saveThumbs(): Plugin {
    return {
        name: 'gf-save-thumbs',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/__dev/save-thumb', (req, res) => {
                const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
                if (req.method !== 'POST' || !/^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.jpg$/i.test(name)) { res.statusCode = 400; res.end(); return; }
                let body = '';
                req.on('data', (c) => (body += c));
                req.on('end', () => {
                    const m = /^data:image\/jpeg;base64,(.+)$/.exec(body);
                    if (!m) { res.statusCode = 400; res.end(); return; }
                    const out = resolve(PUB, 'thumbs', name);
                    mkdirSync(dirname(out), { recursive: true });
                    writeFileSync(out, Buffer.from(m[1], 'base64'));
                    res.end('ok');
                });
            });
            // configurator.saveCodeVersion(): the whole codes.json (versions only ever added)
            server.middlewares.use('/__dev/save-codes', (req, res) => {
                if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
                let body = '';
                req.on('data', (c) => (body += c));
                req.on('end', () => {
                    try {
                        const file = JSON.parse(body);
                        if (!file?.versions || typeof file.versions !== 'object') throw new Error('no versions');
                        writeFileSync(resolve(PUB, 'codes.json'), JSON.stringify(file));
                        res.end('ok');
                    } catch { res.statusCode = 400; res.end(); }
                });
            });
        },
    };
}

/** In the repository the build writes into the published folder: clear the previous app/ first. */
function clearApp(): Plugin {
    return { name: 'gf-clear-app', apply: 'build', buildStart() { if (IN_REPO) rmSync(resolve(PUB, 'app'), { recursive: true, force: true }); } };
}

// Jekyll (GitHub Pages) drops files whose name starts with "_" (e.g. Rollup's "_commonjsHelpers"): never emit one
const noUnderscore = (name: string) => name.replace(/^_+/, '');

// base './' so the built folder works from any path (glimmerfell.com/tools/configurator/ or elsewhere)
export default defineConfig({
    base: './',
    publicDir: PUB,
    plugins: [saveThumbs(), clearApp()],
    server: { port: 5183, strictPort: true },
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 1200,
        assetsDir: 'app',
        outDir: IN_REPO ? PUB : 'dist',
        emptyOutDir: !IN_REPO,
        copyPublicDir: !IN_REPO,
        rollupOptions: {
            output: {
                entryFileNames: 'app/[name]-[hash].js',
                chunkFileNames: (c) => `app/${noUnderscore(c.name)}-[hash].js`,
                assetFileNames: (a) => `app/${noUnderscore((a.names?.[0] ?? a.name ?? 'asset').replace(/\.[^.]+$/, ''))}-[hash][extname]`,
            },
        },
    },
});
