// three.js scene: renderer, baked-light loading (Glimmerfell Bake exports), sky through glazed
// windows, box-projected reflection probes, specular-only lamp highlights, camera presets with a
// constrained orbit, and the snapshot used by the PDF.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
// @ts-ignore  plain JS modules shared with the Glimmerfell tour runtime
import { loadGfManifest, ensureGfGroups, applyGfLighting, installGfColour, gfSpecOcc } from './gf/gf_lighting.js';
// @ts-ignore
import { GfProbes } from './gf/gf_probe.js';
import type { CameraPreset, Config, Look, SceneData, SceneLight } from './types';
import { Rig, makeColliders, type Collider } from './rig';
import { matKey, sheerGrazing } from './finishes';

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const DEG = Math.PI / 180;

/** Look defaults, tuned against the Cycles preview (config.json "look" overrides any of them). */
const LOOK: Required<Look> = {
    skyBackdrop: 0.92,
    skyReflection: 1,
    reflections: 1,
    probeSize: 256,
    specularOcclusion: 0.35,
    specularOcclusionFloor: 0.12,
    glassTransmission: 0.93,
    glassReflection: 0.3,
    sheerGlow: 0.4,
    maxTextureSize: 1024,
};

export interface Insets { left: number; right: number; bottom: number }

interface Flight {
    t0: number; dur: number; path: THREE.Curve<THREE.Vector3> | null; p0: THREE.Vector3; p1: THREE.Vector3;
    q0: THREE.Vector3; q1: THREE.Vector3; f0: number; f1: number; end: ReturnType<Rig['prepare']>;
}

interface Lamp { light: THREE.SpotLight | THREE.PointLight; base: number; room: number }

export class Viewer {
    renderer: THREE.WebGLRenderer;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, 1, 0.06, 80);
    rig: Rig;
    colliders: Collider[] = [];
    room: THREE.Box3;
    doorways: THREE.Box3[] = [];
    look: Required<Look>;
    /** Called after every rendered frame (camera moved, scene changed, insets moved). */
    onRender: (() => void)[] = [];
    private loader = new GLTFLoader();
    private probes: any;
    private dirty = true;
    private fly: Flight | null = null;
    private preset: CameraPreset | null = null;
    private probeTimer = 0;
    private insets: Insets = { left: 0, right: 0, bottom: 0 };
    private insetGoal: Insets = { left: 0, right: 0, bottom: 0 };
    private last = 0;
    private probed = new WeakSet<THREE.Material>();
    private colourReady: Promise<void> | null = null;
    private gfMaterials: Record<string, string> = {};
    /** HDR sky (clamped like the bake world) used for reflections; the LDR picture is the backdrop. */
    private skyHdr: THREE.Texture | null = null;
    private skyIntensity = 1;
    private skyReady: Promise<void> = Promise.resolve();
    private glass = new THREE.Group();
    private lamps: Lamp[] = [];
    private lampRoom = -1;

    constructor(private canvas: HTMLCanvasElement, private cfg: Config) {
        this.look = { ...LOOK, ...(cfg.look ?? {}) };
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.loader.setMeshoptDecoder(MeshoptDecoder);
        // placeholder until the sky picture arrives (kept below 1 so it never clips to white)
        const sky = (cfg.sky ?? [0.62, 0.74, 0.88]).map((v) => Math.min(0.95, v));
        this.scene.background = new THREE.Color().setRGB(sky[0], sky[1], sky[2], THREE.SRGBColorSpace);
        // fallback camera box until scene.json gives the room
        this.room = new THREE.Box3(new THREE.Vector3(...cfg.bounds.min), new THREE.Vector3(...cfg.bounds.max)).expandByScalar(0.15);
        this.rig = new Rig(this.camera, canvas);
        gfSpecOcc.ref.value = this.look.specularOcclusion;
        gfSpecOcc.floor.value = this.look.specularOcclusionFloor;

        const defs = (cfg.probes ?? []).map((p) => ({
            position: new THREE.Vector3(...p.position),
            box: p.box ? new THREE.Box3(new THREE.Vector3(...p.box.min), new THREE.Vector3(...p.box.max)) : null,
        }));
        if (!defs.length) defs.push({ position: new THREE.Vector3(0, 1.4, 0), box: null });
        this.probes = new GfProbes(this.renderer, this.scene, defs);
        this.probes.setIntensity(this.look.reflections);
        this.glass.name = 'cfg_glass';
        this.scene.add(this.glass);

        new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
        this.resize();
        this.renderer.setAnimationLoop((t) => this.frame(t));
    }

    /** Room box, colliders, doorways, window glass, lamps and sky from scene.json (three.js coordinates). */
    setScene(scene: SceneData) {
        if (scene.room) this.room = new THREE.Box3(new THREE.Vector3(...scene.room.min), new THREE.Vector3(...scene.room.max));
        this.colliders = makeColliders(scene.colliders);
        this.doorways = (scene.doorways ?? this.cfg.doorways ?? []).map((d) => new THREE.Box3(new THREE.Vector3(...d.min), new THREE.Vector3(...d.max)));
        this.rig.setWorld(this.colliders, this.room, this.doorways);
        this.makeGlass(scene.windows ?? []);
        if (scene.lights?.length) this.makeLamps(scene.lights);
        this.skyReady = this.loadSky(scene.sky ?? {});
    }

    // ---------------------------------------------------------------- sky
    private async loadSky(sky: NonNullable<SceneData['sky']>) {
        const rotY = sky.rotationY ?? 0;
        this.skyIntensity = (sky.intensity ?? 1) * this.look.skyReflection;
        this.scene.backgroundRotation.set(0, rotY, 0);
        this.scene.environmentRotation.set(0, rotY, 0);
        // backdrop: the file scene.json names, else the same name as .jpg / .webp (the sky task wrote sky.jpg)
        const file = sky.file ?? 'sky/sky.jpg';
        const stem = file.replace(/\.[a-z0-9]+$/i, '');
        const tries = [...new Set([file, stem + '.jpg', stem + '.webp', 'sky/sky.jpg'])];
        const tl = new THREE.TextureLoader();
        for (const url of tries) {
            try {
                const t = await tl.loadAsync(url);
                t.mapping = THREE.EquirectangularReflectionMapping;
                t.colorSpace = THREE.SRGBColorSpace;
                t.anisotropy = 4;
                this.scene.background = t;
                // sRGB backgrounds are drawn without tone mapping: the stored picture is already display-ready
                this.scene.backgroundIntensity = this.look.skyBackdrop;
                if (url !== file) console.info(`[sky] scene.json names ${file}; using ${url}`);
                break;
            } catch { /* next candidate */ }
        }
        try {
            const hdr = await new RGBELoader().setDataType(THREE.HalfFloatType).loadAsync(sky.env ?? 'sky/sky_env.hdr');
            // clamp like the bake world (min(HDRI, 12)): the sun disc would otherwise be a second sun in every reflection
            const d = hdr.image.data as unknown as Uint16Array, clampTo = 12;
            for (let i = 0; i < d.length; i++) {
                if ((i & 3) === 3) continue;
                if (THREE.DataUtils.fromHalfFloat(d[i]) > clampTo) d[i] = THREE.DataUtils.toHalfFloat(clampTo);
            }
            hdr.mapping = THREE.EquirectangularReflectionMapping;
            hdr.needsUpdate = true;
            this.skyHdr = hdr;
            const pmrem = new THREE.PMREMGenerator(this.renderer);
            // fallback environment for anything outside the probe system
            this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
            this.scene.environmentIntensity = this.skyIntensity;
            pmrem.dispose();
        } catch (err) { console.warn('[sky] no HDR environment', err); }
        this.dirty = true;
    }

    // ---------------------------------------------------------------- glass
    /**
     * Thin panes in the window openings. Diffuse black, so the pane only adds its reflection of
     * the room (from the probes); blending keeps `glassTransmission` of the sky behind it.
     */
    private makeGlass(windows: NonNullable<SceneData['windows']>) {
        this.glass.clear();
        const mat = new THREE.MeshStandardMaterial({
            name: 'cfg_window_glass', color: 0x000000, roughness: 0.03, metalness: 0,
            transparent: true, opacity: this.look.glassTransmission, depthWrite: false,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
        });
        mat.userData.gfEnvScale = this.look.glassReflection;
        for (const w of windows) {
            const box = new THREE.Box3(new THREE.Vector3(...w.min), new THREE.Vector3(...w.max));
            const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
            const n = new THREE.Vector3(...(w.normal ?? (size.x < size.z ? [1, 0, 0] : [0, 0, 1]))).normalize();
            const width = Math.abs(n.x) > Math.abs(n.z) ? size.z : size.x;
            const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, size.y), mat);
            pane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
            pane.position.copy(c);
            pane.name = 'cfg_glass_' + (w.name ?? '');
            pane.renderOrder = 2;
            this.glass.add(pane);
        }
        this.probes.register(mat);
        this.dirty = true;
    }

    // ---------------------------------------------------------------- lamp highlights
    /**
     * Specular-only lights at the bake's lamp positions (diffuse is baked; the gf shader patch drops
     * direct diffuse on baked materials). Lamps belong to the room (probe box) they hang in; only the
     * camera's room is lit, and the probe shader masks highlights to fragments in that room, so a
     * lamp never puts a highlight through a wall. The light count never changes (no recompiles).
     */
    private makeLamps(list: SceneLight[]) {
        for (const l of this.lamps) { this.scene.remove(l.light); if ((l.light as THREE.SpotLight).target) this.scene.remove((l.light as THREE.SpotLight).target); }
        this.lamps = [];
        const k = this.cfg.highlights ?? 0;
        if (k <= 0) return;
        for (const s of list) {
            const col = new THREE.Color().setRGB(...(s.color ?? [1, 0.9, 0.8]) as [number, number, number], THREE.LinearSRGBColorSpace);
            const pos = new THREE.Vector3(...s.position);
            const watts = s.watts ?? 18 * (s.intensity ?? 1);
            let light: THREE.SpotLight | THREE.PointLight, base: number;
            if ((s.type ?? 'area') === 'point') {
                base = (watts / (4 * Math.PI)) * k;
                light = new THREE.PointLight(col, base, 6, 2);
            } else {
                // a ceiling downlight: area light facing down, as a wide soft spot
                base = (watts / Math.PI) * k;
                const spot = new THREE.SpotLight(col, base, 9, 62 * DEG, 0.7, 2);
                spot.target.position.copy(pos).add(new THREE.Vector3(0, -1, 0));
                this.scene.add(spot.target);
                light = spot;
            }
            light.position.copy(pos);
            light.name = 'cfg_lamp_' + (s.name ?? this.lamps.length);
            this.scene.add(light);
            this.lamps.push({ light, base, room: this.probes.roomOf(pos) });
        }
        this.lampRoom = -1;
    }

    private updateLamps() {
        if (!this.lamps.length) return;
        const room = this.probes.roomOf(this.camera.position);
        if (room === this.lampRoom) return;
        this.lampRoom = room;
        for (const l of this.lamps) l.light.intensity = l.room === room ? l.base : 0;
        this.probes.setActiveRoom(room);
    }

    // ---------------------------------------------------------------- view
    /** Screen area covered by the interface (px). The view centre moves into what is left; the move is eased. */
    setInsets(i: Partial<Insets>, instant = false) {
        const g = { ...this.insetGoal, ...i };
        if (g.left === this.insetGoal.left && g.right === this.insetGoal.right && g.bottom === this.insetGoal.bottom && !instant) return;
        this.insetGoal = g;
        if (instant) { this.insets = { ...g }; this.applyInsets(); }
        this.dirty = true;
    }

    private stepInsets(dt: number) {
        const a = this.insets, g = this.insetGoal;
        if (a.left === g.left && a.right === g.right && a.bottom === g.bottom) return;
        const k = 1 - Math.exp(-dt * 14);
        for (const key of ['left', 'right', 'bottom'] as const) {
            a[key] += (g[key] - a[key]) * k;
            if (Math.abs(g[key] - a[key]) < 0.5) a[key] = g[key];
        }
        this.applyInsets();
    }

    private applyInsets() {
        const el = this.canvas.parentElement!, w = el.clientWidth, h = el.clientHeight;
        const { left: l, right: r, bottom: b } = this.insets;
        if (l || r || b) this.camera.setViewOffset(w, h, (r - l) / 2, b / 2, w, h); else this.camera.clearViewOffset();
        this.dirty = true;
    }

    /** True while the camera flies between presets. */
    get flying() { return !!this.fly; }
    get currentPreset() { return this.preset; }

    get maxAnisotropy() { return this.renderer.capabilities.getMaxAnisotropy(); }
    invalidate() { this.dirty = true; }

    private resize() {
        const el = this.canvas.parentElement!;
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        if (!this.fly) this.setFov(this.fovFor(this.preset ?? 50));
        this.applyInsets();
        this.dirty = true;
    }

    private setFov(f: number) {
        this.camera.fov = f;
        this.camera.updateProjectionMatrix();
    }

    /**
     * Vertical field of view for a preset at an aspect ratio. Generated cameras carry the fov a 9:16
     * screen needs (`fovPortrait`); between 16:9 and 9:16 the view widens smoothly (in tan space) so
     * wide elements stay framed on a phone. Others widen by a fixed rule below 1.3.
     */
    fovFor(p: CameraPreset | number, a = this.camera.aspect) {
        const base = typeof p === 'number' ? p : p.fov ?? 50;
        const port = typeof p === 'number' ? undefined : p.fovPortrait;
        if (port) {
            const L = 16 / 9, P = 9 / 16;
            if (a >= L) return base;
            const t = THREE.MathUtils.clamp((Math.log(L) - Math.log(a)) / (Math.log(L) - Math.log(P)), 0, 1);
            const tl = Math.tan((base * DEG) / 2), tp = Math.tan((Math.min(100, Math.max(base, port)) * DEG) / 2);
            return (2 * Math.atan(tl + (tp - tl) * t)) / DEG;
        }
        return a >= 1.3 ? base : Math.min(95, base * (1 + (1.3 - a) * 0.75));
    }

    /** A camera standing at a preset (for placing things the preset will see). */
    presetCamera(name: string): THREE.PerspectiveCamera | null {
        const p = this.cfg.cameras[name];
        if (!p) return null;
        const cam = new THREE.PerspectiveCamera(this.fovFor(p), this.camera.aspect, 0.05, 80);
        cam.position.set(...p.position);
        cam.lookAt(new THREE.Vector3(...p.target));
        cam.updateMatrixWorld();
        return cam;
    }

    private frame(now: number) {
        const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0.016);
        this.last = now;
        this.stepInsets(dt);
        if (this.fly) {
            // the frame's timestamp can be a little older than the performance.now() of goTo(): clamp, or the
            // path lookup gets a negative position and throws (which would stop the render loop)
            const f = this.fly, k = ease(THREE.MathUtils.clamp((now - f.t0) / f.dur, 0, 1) || 0);
            if (f.path) f.path.getPointAt(k, this.camera.position); else this.camera.position.lerpVectors(f.p0, f.p1, k);
            this.rig.target.lerpVectors(f.q0, f.q1, k);
            this.camera.lookAt(this.rig.target);
            this.setFov(f.f0 + (f.f1 - f.f0) * k);
            if (k >= 1) { this.fly = null; this.rig.apply(f.end); }
            this.dirty = true;
        } else if (this.rig.update(dt)) this.dirty = true;
        if (!this.dirty) return;
        this.dirty = false;
        this.updateLamps();
        this.renderer.render(this.scene, this.camera);
        for (const cb of this.onRender) cb();
    }

    /**
     * Flies to a camera preset. The orbit limits of that preset apply from the moment it lands
     * (input during the flight is ignored). `focus` names the element being inspected: its own
     * collider does not block the view of it. `zone` presets get the wider zone defaults.
     */
    goTo(name: string, { instant = false, focus = [] as string[], zone = false } = {}) {
        const p = this.cfg.cameras[name];
        if (!p) return false;
        this.preset = p;
        const end = this.rig.prepare(p, zone, focus);
        this.rig.enabled = false;
        if (instant) {
            this.fly = null;
            this.setFov(this.fovFor(p));
            this.rig.apply(end);
        } else {
            const p0 = this.camera.position.clone(), p1 = end.position.clone();
            const path = this.route(p0, p1);
            const len = path ? path.getLength() : p0.distanceTo(p1);
            this.fly = { t0: performance.now(), dur: THREE.MathUtils.clamp(600 + len * 90, 850, 1500), path, p0, p1,
                q0: this.rig.target.clone(), q1: end.target.clone(), f0: this.camera.fov, f1: this.fovFor(p), end };
        }
        this.dirty = true;
        return true;
    }

    /** When the straight line between two camera positions crosses a wall, fly through a doorway. */
    private route(a: THREE.Vector3, b: THREE.Vector3): THREE.Curve<THREE.Vector3> | null {
        if (!this.rig.blocked(a, b) || !this.doorways.length) return null;
        let best: THREE.Vector3[] | null = null, bestLen = Infinity;
        for (const d of this.doorways) {
            const c = d.getCenter(new THREE.Vector3()), s = d.getSize(new THREE.Vector3());
            const axis = s.x < s.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
            c.y = Math.min(1.5, d.max.y - 0.35);
            let w1 = c.clone().addScaledVector(axis, 0.8), w2 = c.clone().addScaledVector(axis, -0.8);
            if (w1.distanceToSquared(a) > w2.distanceToSquared(a)) [w1, w2] = [w2, w1];
            if (this.rig.blocked(a, w1) || this.rig.blocked(w2, b)) continue;
            const len = a.distanceTo(w1) + w1.distanceTo(w2) + w2.distanceTo(b);
            if (len < bestLen) { bestLen = len; best = [a.clone(), w1, w2, b.clone()]; }
        }
        return best ? new THREE.CatmullRomCurve3(best, false, 'centripetal') : null;
    }

    // ---------------------------------------------------------------- loading
    private async loadGlb(url: string) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        const buf = repairGlb(await res.arrayBuffer());
        return this.loader.parseAsync(buf, url.slice(0, url.lastIndexOf('/') + 1));
    }

    private async manifest(dir: string) {
        const gf = await loadGfManifest(dir + '/gf_lightmaps.json');
        if (!this.colourReady) {
            // Blender's colour management (AgX etc.) as a LUT; must be in place before any shader compiles
            this.colourReady = installGfColour(this.renderer, gf).then(() => {});
        }
        Object.assign(this.gfMaterials, gf.manifest.materials ?? {});
        await this.colourReady;
        return gf;
    }

    /** Loads a Glimmerfell Bake export folder: every GLB it lists, with baked light applied. */
    async loadBaked(dir: string): Promise<THREE.Group> {
        const gf = await this.manifest(dir);
        const root = new THREE.Group();
        const groups = Object.values(gf.manifest.groups || {}) as any[];
        const files = [...new Set(groups.map((g) => g.glb).filter(Boolean))] as string[];
        const parts = await Promise.all(files.map((f) => this.loadGlb(dir + '/' + f)));
        for (const gltf of parts) {
            this.makeCloth(gltf.scene);
            await ensureGfGroups(gf, gltf.scene);
            applyGfLighting(gltf.scene, gf);
            root.add(gltf.scene);
        }
        root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
                this.tagSurface(mat);
                if (mat.userData.cfgSheer) sheerGrazing(mat);     // after the lighting patch (which may clone materials)
                if (!this.probed.has(mat)) { this.probed.add(mat); this.probes.register(mat); }
            }
        });
        this.scene.add(root);
        this.dirty = true;
        return root;
    }

    /**
     * Blender material keys of cloth parts (set by the configurator from the catalogue): "cloth", or
     * "sheer" for blinds and curtains that can be blackout or see-through.
     */
    clothKeys = new Map<string, 'cloth' | 'sheer'>();

    /**
     * Cloth materials become MeshPhysicalMaterial (sheen, specular intensity) before the baked light
     * is applied, so the lightmap patch and probes attach to the final material. Sheen stays on, and
     * sheer-capable ones are always transparent with an alpha map (a 1x1 white one when blackout), so
     * a fabric swap, blackout or sheer, never needs a new shader.
     */
    private makeCloth(root: THREE.Object3D) {
        if (!this.clothKeys.size) return;
        const done = new Map<THREE.Material, THREE.Material>();
        const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        white.needsUpdate = true;
        const convert = (m: THREE.Material) => {
            const std = m as THREE.MeshStandardMaterial;
            const kind = std.isMeshStandardMaterial ? this.clothKeys.get(matKey(m.name).replace(/\.\d{3}$/, '')) : undefined;
            if (!kind) return m;
            let p = done.get(m) as THREE.MeshPhysicalMaterial | undefined;
            if (p) return p;
            if ((std as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) p = std as THREE.MeshPhysicalMaterial;
            else {
                p = new THREE.MeshPhysicalMaterial();
                THREE.MeshStandardMaterial.prototype.copy.call(p, std);
                p.defines = { STANDARD: '', PHYSICAL: '' };
            }
            p.transmission = 0; p.clearcoat = 0; p.iridescence = 0;
            p.sheen = 1; p.sheenColor.setRGB(0, 0, 0); p.sheenRoughness = 0.8;
            p.specularIntensity = 0.3;
            if (kind === 'sheer') {
                p.userData.cfgSheer = true;
                p.transparent = true;
                if (!p.alphaMap) p.alphaMap = white;
            }
            done.set(m, p);
            return p;
        };
        root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
        });
    }

    /** Loads a GLB without baked light (taps). The probes light it and give its reflections. */
    async loadPlain(url: string): Promise<THREE.Group> {
        await this.colourReady;
        const gltf = await this.loadGlb(url);
        gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
                if (!mat.isMeshStandardMaterial || this.probed.has(mat)) continue;
                this.probed.add(mat);
                this.probes.register(mat, { diffuse: true });
            }
        });
        return gltf.scene;
    }

    /**
     * Glass, mirrors, frosted glass and lamps that glTF can't describe arrive tagged by the exporter
     * (material extras gf_surface, or the manifest's material list); config "surfaces" adds more by
     * Blender name. The exporter also tags very glossy metals as "mirror": only materials named or
     * configured as mirrors become true mirrors, other metals keep their colour and finish.
     */
    private tagSurface(mat: THREE.MeshStandardMaterial) {
        if (mat.userData.cfgTagged) return;
        // Blender numbers repeated names ("mirror.001"): same surface
        const bare = (n: string) => matKey(n).replace(/\.\d{3}$/, '');
        const key = bare(mat.name);
        const byCfg = Object.entries(this.cfg.surfaces ?? {}).find(([n]) => bare(n) === key)?.[1];
        const byGf = Object.entries(this.gfMaterials).find(([n]) => matKey(n) === matKey(mat.name))?.[1];
        // "emissive:20" sets the strength (lamp faces need real brightness in the reflections);
        // "paint:#hex:roughness:metalness" gives a plain surface to a material Blender exported grey
        const [cfgKind, cfgArg, ...cfgMore] = (byCfg ?? '').split(':');
        let kind: string | undefined = cfgKind || mat.userData?.gf_surface || (byGf !== 'other' ? byGf : undefined);
        if (kind === 'mirror' && cfgKind !== 'mirror' && !/mirror/i.test(mat.name)) kind = undefined;
        if (!kind) return;
        mat.userData.cfgTagged = true;
        if (kind === 'decal') {
            // a surface laid flat on another (splashback on the wall): wins the depth test instead of z-fighting
            mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -4;
            return;
        }
        if (kind === 'paint') {
            if (cfgArg) mat.color.set(cfgArg);
            mat.roughness = cfgMore[0] ? Number(cfgMore[0]) : mat.roughness;
            mat.metalness = cfgMore[1] ? Number(cfgMore[1]) : 0;
            mat.map = mat.metalnessMap = mat.roughnessMap = null;
        } else if (kind === 'glass') {
            mat.transparent = true; mat.opacity = Math.min(mat.opacity, 0.22); mat.roughness = 0.04; mat.metalness = 0; mat.depthWrite = false;
        } else if (kind === 'frosted') {
            mat.transparent = true; mat.opacity = 0.6; mat.roughness = 0.45; mat.metalness = 0; mat.depthWrite = false;
            if (mat.color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5) mat.color.set('#e8ecea');
            const p = mat as THREE.MeshPhysicalMaterial;
            if (p.isMeshPhysicalMaterial) p.transmission = 0;
        } else if (kind === 'mirror') {
            mat.metalness = 1; mat.roughness = 0.03; mat.color.set('#ffffff');
            mat.map = mat.metalnessMap = mat.roughnessMap = mat.normalMap = null;
            mat.lightMap = null;                  // a mirror shows the room, not its own (dark) baked light
            mat.transparent = false; mat.opacity = 1;
            const p = mat as THREE.MeshPhysicalMaterial;
            if (p.isMeshPhysicalMaterial) { p.transmission = 0; p.specularIntensity = 1; p.specularColor.set('#ffffff'); p.clearcoat = 0; p.sheen = 0; }
        } else if (kind === 'emissive') {
            const c = mat.userData.gf_emission_color ?? mat.userData.gf_color;
            if (Array.isArray(c)) mat.emissive.setRGB(c[0], c[1], c[2]); else if (mat.emissive.getHex() === 0) mat.emissive.set('#fff1dc');
            mat.emissiveIntensity = cfgArg ? Number(cfgArg) : Math.min(6, mat.userData.gf_emission_strength ?? mat.userData.gf_strength ?? 4);
            mat.lightMap = null;                  // a lamp face is its own light
            mat.color.set('#000000');
        }
        mat.needsUpdate = true;
    }

    /** Re-captures the room for reflections (after a model or finish change). */
    refreshReflections(delay = 150) {
        clearTimeout(this.probeTimer);
        this.probeTimer = window.setTimeout(async () => {
            await this.skyReady;
            const t0 = performance.now();
            // three r170 loses the cube face when a transmissive material triggers its transmission pass inside a
            // CubeCamera render: the face being drawn stays black. Glassy bits are hidden from the capture instead.
            const hide: THREE.Object3D[] = [this.glass];
            // sheer fabric too: its alpha can exceed 1 (cover lift), which only clamps on the 8-bit canvas, not in the HDR cube
            this.scene.traverseVisible((o) => {
                const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | THREE.MeshPhysicalMaterial[] | undefined;
                if (m && (Array.isArray(m) ? m : [m]).some((x) => (x?.transmission ?? 0) > 0 || (x?.userData?.cfgSheer && !x.depthWrite))) hide.push(o);
            });
            this.probes.capture({
                size: this.look.probeSize, hide,
                background: this.skyHdr ?? undefined, backgroundIntensity: this.skyIntensity,
            });
            this.captureMs = performance.now() - t0;
            this.dirty = true;
        }, delay);
    }
    /** Duration of the last probe capture (ms), for the console. */
    captureMs = 0;

    /** Still image of the current view for the PDF, independent of the window size. */
    snapshot(width = 1800, height = 1100): string {
        const r = this.renderer, size = r.getSize(new THREE.Vector2()), pr = r.getPixelRatio();
        const aspect = this.camera.aspect, fov = this.camera.fov;
        r.setPixelRatio(1); r.setSize(width, height, false);
        this.camera.clearViewOffset();
        this.camera.aspect = width / height; this.setFov(this.fovFor(this.preset ?? 50));
        r.render(this.scene, this.camera);
        const url = this.canvas.toDataURL('image/jpeg', 0.9);
        r.setPixelRatio(pr); r.setSize(size.x, size.y, false);
        this.camera.aspect = aspect; this.camera.fov = fov;
        this.applyInsets();
        this.camera.updateProjectionMatrix();
        this.dirty = true;
        return url;
    }
}

/**
 * Blender's WebP export drops greyscale pictures, leaving textures that point at no image; the
 * loader then rejects the whole file. This removes such textures from the materials that use them.
 */
function repairGlb(buf: ArrayBuffer): ArrayBuffer {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return buf;
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    const bad = new Set<number>();
    (json.textures ?? []).forEach((t: any, i: number) => {
        const ext = t.extensions ?? {};
        if (t.source === undefined && !Object.values(ext).some((e: any) => e && e.source !== undefined)) bad.add(i);
    });
    if (!bad.size) return buf;
    const strip = (o: any) => {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
            const v = o[k];
            if (v && typeof v === 'object' && typeof v.index === 'number' && /Texture$/.test(k) && bad.has(v.index)) delete o[k];
            else strip(v);
        }
    };
    for (const m of json.materials ?? []) strip(m);
    for (const i of bad) json.textures[i] = { source: 0, ...(json.textures[i].sampler !== undefined ? { sampler: json.textures[i].sampler } : {}) };
    if (!(json.images ?? []).length) { delete json.textures; delete json.images; }
    let text = new TextEncoder().encode(JSON.stringify(json));
    const pad = (4 - (text.length % 4)) % 4;
    const rest = new Uint8Array(buf, 20 + jsonLen);
    const out = new Uint8Array(20 + text.length + pad + rest.length);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, out.length, true);
    odv.setUint32(12, text.length + pad, true); odv.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + text.length + pad);
    out.set(rest, 20 + text.length + pad);
    return out.buffer;
}

/** Soft contact shadow under a model that was baked without the floor knowing about it. */
export function contactShadow(object: THREE.Object3D, strength = 0.42): THREE.Mesh | null {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    // the plane reaches 0.45 m beyond the footprint on every side; the texture is drawn in the same proportions
    const pad = 0.45, w = size.x + 2 * pad, d = size.z + 2 * pad;
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d')!;
    const px = (pad / w) * 256, pz = (pad / d) * 256;
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#fff';
    // wide soft falloff (bounce light blocked by the object) + a tighter, darker core under it
    g.globalAlpha = 0.55; g.filter = `blur(${Math.max(6, Math.min(px, pz) * 0.5)}px)`;
    g.fillRect(px * 0.75, pz * 0.75, 256 - px * 1.5, 256 - pz * 1.5);
    g.globalAlpha = 0.8; g.filter = `blur(${Math.max(3, Math.min(px, pz) * 0.16)}px)`;
    g.fillRect(px * 1.05, pz * 1.05, 256 - px * 2.1, 256 - pz * 2.1);
    const tex = new THREE.CanvasTexture(cv);
    strength = Math.max(strength, 0.7);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ alphaMap: tex, color: 0x000000, transparent: true, opacity: strength, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    mesh.position.set(c.x, 0.004, c.z);
    mesh.name = 'cfg_contact_shadow';
    return mesh;
}
