import * as THREE from 'three';
import type { Config, SceneData } from './types';
import { Viewer } from './viewer';
import { Configurator } from './configurator';
import { UI, ctaText } from './ui';
import { initFinishes, textureStats } from './finishes';
import { makePdf } from './pdf';
import { debugGroup } from './rig';
import { type CodeFile, decode, encode, latest, sameVersion } from './code';

/** Tell the page that embeds us (iframe) what happens, so it can react or resize. */
function emit(type: string, detail: Record<string, unknown> = {}) {
    if (window.parent !== window) window.parent.postMessage({ source: 'glimmerfell-configurator', type, ...detail }, '*');
}

async function loadScene(): Promise<SceneData> {
    try {
        const res = await fetch('./assets/scene.json', { cache: 'no-cache' });
        if (res.ok) return await res.json();
        console.warn('[scene] assets/scene.json:', res.status);
    } catch (err) { console.warn('[scene] could not read assets/scene.json', err); }
    return {};
}

/**
 * scene.json (exported from Blender) supplies cameras, anchors and colliders; config.json only adds
 * labels and orbit limits to cameras. Tap anchors in scene.json replace the ones typed in config.
 */
function merge(cfg: Config, scene: SceneData) {
    const cams = { ...(cfg.cameras ?? {}) };
    for (const [id, cam] of Object.entries(scene.cameras ?? {})) cams[id] = { ...cam, ...pickLimits(cfg.cameras?.[id]) };
    for (const [id, cam] of Object.entries(cams)) if (!cam.position || !cam.target) delete cams[id];
    cfg.cameras = cams;
    for (const slot of cfg.slots) {
        if (!slot.anchorSlot) continue;
        const host = cfg.slots.find((s) => s.id === slot.anchorSlot);
        for (const o of host?.options ?? []) {
            const pts = scene.anchors?.[host!.id]?.[o.id];
            if (Array.isArray(pts)) { if (pts.length) o.anchors = { ...(o.anchors ?? {}), [slot.anchorKey ?? slot.id]: pts }; }
            else if (pts) {
                // v3: anchors per mount ({ deck, wall, side }); deck also stands in as the plain anchor list
                o.mounts = pts;
                if (pts.deck?.length) o.anchors = { ...(o.anchors ?? {}), [slot.anchorKey ?? slot.id]: pts.deck };
            }
        }
    }
    if (scene.tapRules) cfg.tapRules = scene.tapRules;
    cfg.zones ??= [{ id: 'overview', label: 'Overview', camera: 'hero' }];
    cfg.elements ??= [];
}

function pickLimits(c?: Record<string, any>) {
    if (!c) return {};
    const out: Record<string, any> = {};
    for (const k of ['yaw', 'pitch', 'dist', 'label', 'fov']) if (c[k] !== undefined) out[k] = c[k];
    return out;
}

async function start() {
    const note = document.getElementById('poster-note')!;
    const params = new URLSearchParams(location.search);
    const [cfg, scene, codes] = await Promise.all([
        fetch('./config.json', { cache: 'no-cache' }).then((r) => r.json() as Promise<Config>),
        loadScene(),
        // index lists of every catalogue version (configuration codes); small, and only grows
        fetch('./codes.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : { versions: {} })).catch(() => ({ versions: {} })) as Promise<CodeFile>,
    ]);
    merge(cfg, scene);
    // ?code=GF1-… opens that configuration (slot values in the same address still win)
    const fromCode = params.get('code') ? decode(codes, params.get('code')!) : null;
    for (const [id, v] of Object.entries(fromCode ?? {})) if (!params.has(id)) params.set(id, v);
    document.title = cfg.title;

    const canvas = document.getElementById('view') as HTMLCanvasElement;
    const viewer = new Viewer(canvas, cfg);
    viewer.setScene(scene);
    await initFinishes({ maxAnisotropy: viewer.maxAnisotropy, maxSize: viewer.look.maxTextureSize, manifest: cfg.pbrManifest,
        sheerGlow: viewer.look.sheerGlow, onLoaded: () => viewer.invalidate() });
    const c = new Configurator(cfg, viewer);

    let ui: UI | null = null;
    const sync = () => history.replaceState(null, '', '?' + c.toQuery(ui?.currentView, ui?.element));
    c.onBusy = (b) => { document.getElementById('busy')!.hidden = !b || !ui; };
    c.onChange = (slot) => {
        ui?.refresh();
        // keep the address in step, so a reload or a copied address gives the same room
        if (ui) sync();
        emit('optionChanged', { slot, state: c.state });
    };

    const where = await c.init(params);
    ui = new UI(cfg, c, viewer, scene);
    ui.onNavigate = sync;
    // the code is worked out on demand (summary, PDF, calls to action); null if this catalogue has no saved version yet
    ui.getCode = () => encode(codes, c.values());
    ui.onCode = async (code) => {
        const v = decode(codes, code);
        if (!v) return false;
        await c.applyState(v);
        return true;
    };
    ui.start(where);
    if (params.get('code') && !fromCode) ui.toast('That code was not recognised');
    const total = () => c.summary().reduce((a, l) => a + l.price, 0);
    ui.onLook = (id) => emit('lookApplied', { look: id, state: c.state, url: c.shareUrl(ui!.currentView, ui!.element) });
    ui.onCta = (cta) => emit('cta', { id: cta.id, kind: cta.kind, state: c.state, url: c.shareUrl(ui!.currentView, ui!.element), total: total() });
    ui.onPdf = async () => {
        ui!.toast('Preparing PDF…');
        const w = 1800, h = 720;      // wide enough that the item list, total and QR fit on one A4 page
        const cta = cfg.cta?.find((x) => x.primary);
        await makePdf(cfg, c.summary(), viewer.snapshot(w, h), w / h, c.shareUrl(ui!.currentView, ui!.element),
            true, cta ? { label: cta.label, text: ctaText(cta) } : undefined, ui!.getCode());
        emit('quoteRequested', { state: c.state, url: c.shareUrl(ui!.currentView, ui!.element) });
    };

    if (params.get('debug') === 'colliders') {
        const pts: THREE.Vector3[] = [];
        for (const e of Object.values(scene.elements ?? {})) if (e.anchor) pts.push(new THREE.Vector3(...e.anchor));
        for (const cam of Object.values(cfg.cameras)) pts.push(new THREE.Vector3(...cam.target));
        viewer.scene.add(debugGroup(viewer.colliders, pts));
        viewer.invalidate();
    }

    // let the first frames render behind the poster, then fade
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('poster')!.classList.add('done')));
    emit('presetLoaded', { preset: params.get('p'), state: c.state });
    // for debugging in the console; configurator.stats() reports draw calls and texture memory
    const stats = () => {
        const info = viewer.renderer.info;
        return { calls: info.render.calls, triangles: info.render.triangles, gpuTextures: info.memory.textures,
            geometries: info.memory.geometries, programs: info.programs?.length, finishTextures: { ...textureStats },
            probeCaptureMs: Math.round(viewer.captureMs) };
    };
    (window as any).configurator = { c, viewer, ui, makePdf, cfg, scene, stats };
    // development only: configurator.makeLookThumbs() renders each look from the hero camera into public/thumbs/looks/
    if ((import.meta as any).env?.DEV) (window as any).configurator.makeLookThumbs = async (w = 480, h = 300) => {
        const before = location.search, saved: string[] = [];
        ui!.setZone('overview', true);
        for (const lk of cfg.looks ?? []) {
            await c.applyState(lk.state);
            await new Promise((r) => setTimeout(r, 2500));          // textures decode and the reflection probe refreshes
            const res = await fetch('/__dev/save-thumb?name=' + encodeURIComponent('looks/' + lk.id + '.jpg'), { method: 'POST', body: viewer.snapshot(w, h) });
            if (res.ok) saved.push(lk.id);
        }
        await c.applyState(Object.fromEntries(new URLSearchParams(before)));
        return saved;
    };
    // development only: configuration codes need a saved version of the live catalogue (public/codes.json)
    if ((import.meta as any).env?.DEV) {
        const live = c.codeVersion(), last = codes.versions[latest(codes)];
        if (!last || !sameVersion(live, last))
            console.warn('[codes] the catalogue changed since the last saved code version: run configurator.saveCodeVersion()');
        (window as any).configurator.saveCodeVersion = async () => {
            const cur = c.codeVersion(), prev = codes.versions[latest(codes)];
            if (prev && sameVersion(cur, prev)) return `unchanged (version ${latest(codes)})`;
            const next = latest(codes) + 1;
            const file: CodeFile = { versions: { ...codes.versions, [next]: cur } };
            const res = await fetch('/__dev/save-codes', { method: 'POST', body: JSON.stringify(file) });
            if (!res.ok) return 'failed: ' + res.status;
            codes.versions[next] = cur;
            return `saved version ${next}`;
        };
    }
    note.textContent = '';
}

start().catch((err) => {
    console.error(err);
    document.getElementById('poster-note')!.textContent = 'The room could not be loaded. Please reload the page.';
});
