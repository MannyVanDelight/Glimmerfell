// Finishes on materials that already carry baked light. The lightmap holds light only, so a new
// surface (colour, relief, gloss) keeps the shadows and bounce of the bake.
//
// A finish is a PBR texture set baked from the Sanctus materials (basecolor sRGB, OpenGL normal,
// ORM: G roughness, B metal), a legacy colour texture, or a plain colour. Every non-original
// finish fills the same four slots (map, normalMap, roughnessMap, metalnessMap) on the same UV
// channel, using 1x1 neutral textures where a finish has nothing to say, so a swap only changes
// uniforms and never recompiles a shader.
//
// Texture sets load on demand (only finishes in use, plus the one under the pointer), are resized
// on decode to `maxSize` (1024 px by default; flat sets 64 px) and cached by URL. The GPU shares
// one upload per image between all surfaces that use it (repeat/rotation are uniforms).

import * as THREE from 'three';
import type { Finish, PbrSet } from './types';
import { categoryOf, isSheer } from './catalogue';

type Std = THREE.MeshStandardMaterial;
type Phys = THREE.MeshPhysicalMaterial;

interface Original {
    color: THREE.Color; map: THREE.Texture | null; roughness: number; metalness: number;
    roughnessMap: THREE.Texture | null; metalnessMap: THREE.Texture | null; normalMap: THREE.Texture | null;
    normalScale: THREE.Vector2;
    emissive: THREE.Color; lightMapIntensity: number; envScale: number | undefined;
    alphaMap: THREE.Texture | null; opacity: number; depthWrite: boolean;
    specularIntensity: number; sheen: number; sheenColor: THREE.Color; sheenRoughness: number;
}

/**
 * How a finish answers light, by kind of material. Cloth must read as matte: little specular, a soft
 * sheen at grazing angles (lit by the baked light), and only a trace of the room reflections, so a
 * blind in front of a bright window does not mirror it. `spec` / `sheen` need a physical material
 * (the viewer gives one to cloth parts); `env` scales the probe reflections on any material.
 */
interface Response { spec: number; sheen: number; sheenRoughness: number; env: number; rough?: number }
export const RESPONSES: Record<string, Response> = {
    cloth:   { spec: 0.3,  sheen: 0.7,  sheenRoughness: 0.8, env: 0.2, rough: 1.3 },
    sheer:   { spec: 0.25, sheen: 0.5,  sheenRoughness: 0.8, env: 0.12, rough: 1.3 },
    leather: { spec: 0.75, sheen: 0.12, sheenRoughness: 0.6, env: 0.6 },
    soft:    { spec: 0.5,  sheen: 0.35, sheenRoughness: 0.8, env: 0.35 },
    hard:    { spec: 1,    sheen: 0,    sheenRoughness: 0.8, env: 1 },
};

export function responseOf(f: Finish): string {
    if (isSheer(f, sets)) return 'sheer';
    const c = categoryOf(f, sets);
    if (c === 'fabric') return /leather/.test(f.pbr ?? '') ? 'leather' : 'cloth';
    if (c === 'plastic' && /foam|rubber/.test(f.pbr ?? '')) return 'soft';
    return 'hard';
}

/** Blender material name without the exporter's prefixes ("GF_", "GFX_GF_"), lower case. */
export const matKey = (name: string) => name.replace(/^(?:GFX_)?(?:GF_)?/, '').trim().toLowerCase();

/** Texture sets whose ORM blue channel is a real metal mask (all others: manifest `metallic` scalar). */
const PBR_METAL_MASK = new Set(['gold_marble_04']);

/** UV channel written by boxProject (glTF never uses TEXCOORD_3 here; lightmaps use 1, some models 2). */
export const BOX_CHANNEL = 3;

const originals = new WeakMap<Std, Original>();
const sets = new Map<string, PbrSet>();
let pbrRoot = 'textures/pbr/';
let anisotropy = 4;
let maxSize = 1024;
let onTextureLoaded: () => void = () => {};
let sheerGlow = 0.4;

/** Download / memory counters for the report and the console (configurator.stats()). */
export const textureStats = { images: 0, bytes: 0, gpuBytes: 0, textures: 0 };

export async function initFinishes(o: { maxAnisotropy: number; maxSize?: number; manifest?: string; onLoaded?: () => void; sheerGlow?: number }) {
    anisotropy = Math.min(8, o.maxAnisotropy);
    if (o.sheerGlow !== undefined) sheerGlow = o.sheerGlow;
    if (o.maxSize) maxSize = o.maxSize;
    if (o.onLoaded) onTextureLoaded = o.onLoaded;
    const url = o.manifest ?? 'textures/pbr/manifest.json';
    pbrRoot = url.slice(0, url.lastIndexOf('/') + 1);
    try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(String(res.status));
        for (const s of (await res.json()) as PbrSet[]) sets.set(s.id, s);
    } catch (err) { console.warn('[finishes] no PBR manifest at', url, err); }
}

export function pbrSet(id: string | undefined) { return id ? sets.get(id) : undefined; }
/** Every set of the manifest (read once at start). */
export function manifestSets() { return sets; }

/** Swatch image of a finish for the UI (explicit swatch > PBR swatch.webp > legacy map > colour). */
export function swatchOf(f: Finish): string | undefined {
    if (f.swatch) return f.swatch;
    if (f.pbr && sets.has(f.pbr)) return pbrRoot + f.pbr + '/swatch.webp';
    return undefined;
}

// ------------------------------------------------------------------ images
interface Img { image: ImageBitmap | HTMLImageElement; flipped: boolean; w: number; h: number }
const images = new Map<string, Img>();
const pending = new Map<string, Promise<Img | null>>();

function sizeFor(set: PbrSet | undefined, kind: 'basecolor' | 'normal' | 'orm'): number {
    if (!set) return 0;
    if (set.flat) return 64;
    const s = Math.min(set.size || 1024, maxSize);
    return kind === 'orm' ? Math.max(256, s / 2) : s;     // gloss varies slowly; half size is plenty
}

/** Decodes (and resizes, when `size` > 0) an image off the main thread. Falls back to <img>. */
function loadImage(url: string, size: number): Promise<Img | null> {
    const key = url + '@' + size;
    if (images.has(key)) return Promise.resolve(images.get(key)!);
    let p = pending.get(key);
    if (p) return p;
    p = (async () => {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${url}: ${res.status}`);
            const blob = await res.blob();
            textureStats.bytes += blob.size; textureStats.images++;
            let img: Img;
            try {
                const opts: ImageBitmapOptions = { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
                if (size) Object.assign(opts, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
                const bmp = await createImageBitmap(blob, opts);
                img = { image: bmp, flipped: true, w: bmp.width, h: bmp.height };
            } catch {
                const el = new Image();
                el.src = URL.createObjectURL(blob);
                await el.decode();
                img = { image: el, flipped: false, w: el.naturalWidth, h: el.naturalHeight };
            }
            textureStats.gpuBytes += img.w * img.h * 4 * 1.33;
            images.set(key, img);
            return img;
        } catch (err) {
            console.warn('[finishes] could not load', url, err);
            return null;
        } finally { pending.delete(key); }
    })();
    pending.set(key, p);
    return p;
}

interface TexReq { url: string; size: number; srgb: boolean }

function requests(f: Finish): TexReq[] {
    if (f.original) return [];
    if (f.pbr) {
        const s = sets.get(f.pbr);
        if (!s) return [];
        const b = pbrRoot + f.pbr + '/';
        const out = [
            { url: b + 'basecolor.webp', size: sizeFor(s, 'basecolor'), srgb: true },
            { url: b + 'normal.webp', size: sizeFor(s, 'normal'), srgb: false },
            { url: b + 'orm.webp', size: sizeFor(s, 'orm'), srgb: false },
        ];
        // sheer sets: alpha (linear, white = opaque thread), own or borrowed from another set
        if (s.alpha || s.alphaFrom) out.push({ url: pbrRoot + (s.alphaFrom ?? s.id) + '/alpha.webp', size: sizeFor(s, 'basecolor'), srgb: false });
        return out;
    }
    if (f.map) return [{ url: f.map, size: 0, srgb: true }];
    return [];
}

/** Resolves when every texture of the finish is decoded (failed images count as done). */
export async function ensureFinish(f: Finish): Promise<void> {
    await Promise.all(requests(f).map((r) => loadImage(r.url, r.size)));
}

/** Starts loading a finish in the background (pointer over a swatch). */
export function prefetchFinish(f: Finish) { void ensureFinish(f); }

// ------------------------------------------------------------------ textures
const sources = new Map<string, THREE.Source>();
const textures = new Map<string, THREE.Texture>();

function texture(r: TexReq, repeat: number, rotation: number, channel: number, stretch = 1): THREE.Texture | null {
    const img = images.get(r.url + '@' + r.size);
    if (!img) return null;
    const key = `${r.url}@${r.size}|${repeat.toFixed(5)}|${rotation.toFixed(4)}|${channel}|${stretch}`;
    let t = textures.get(key);
    if (t) return t;
    t = new THREE.Texture();
    const sk = r.url + '@' + r.size;
    let src = sources.get(sk);
    if (!src) { src = new THREE.Source(img.image); sources.set(sk, src); }
    t.source = src;
    t.flipY = !img.flipped;
    t.colorSpace = r.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    t.repeat.set(repeat / stretch, repeat);      // stretch runs along the texture's u (wood grain direction)
    t.rotation = rotation;
    t.channel = channel;
    t.needsUpdate = true;
    textures.set(key, t);
    textureStats.textures++;
    return t;
}

const neutrals = new Map<string, THREE.DataTexture>();
/** 1x1 stand-ins: white colour / ORM (roughness = metal = 1, scaled by the material values), flat normal. */
function neutral(kind: 'white' | 'normal', channel: number): THREE.DataTexture {
    const key = kind + channel;
    let t = neutrals.get(key);
    if (!t) {
        const px = kind === 'normal' ? [128, 128, 255, 255] : [255, 255, 255, 255];
        t = new THREE.DataTexture(new Uint8Array(px), 1, 1);
        t.channel = channel;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.needsUpdate = true;
        neutrals.set(key, t);
    }
    return t;
}

/**
 * Stand-in alpha for sheer finishes whose set is not baked yet: a fine plain weave (threads ~85 %
 * opaque, gaps ~25 %), 2 cm per repeat, mip-mapped so it reads as an even voile from a distance.
 */
let weaveBase: THREE.DataTexture | null = null;
const weaves = new Map<string, THREE.Texture>();
const WEAVE_TILE = 0.02;
/** Average cover a sheer should have on screen (the stand-in weave has about this). */
const SHEER_COVER = 0.45;
function weave(repeat: number, rotation: number, channel: number): THREE.Texture {
    if (!weaveBase) {
        const n = 32, px = new Uint8Array(n * n * 4);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const warp = Math.pow(Math.sin(((x + 0.5) / n) * Math.PI * 4), 2);    // 4 threads each way
            const weft = Math.pow(Math.sin(((y + 0.5) / n) * Math.PI * 4), 2);
            const a = 1 - (1 - 0.8 * warp) * (1 - 0.8 * weft);
            const v = Math.round(255 * (0.22 + 0.68 * a));
            px.set([v, v, v, 255], (y * n + x) * 4);
        }
        weaveBase = new THREE.DataTexture(px, n, n);
        weaveBase.wrapS = weaveBase.wrapT = THREE.RepeatWrapping;
        weaveBase.magFilter = THREE.LinearFilter;
        weaveBase.minFilter = THREE.LinearMipmapLinearFilter;
        weaveBase.generateMipmaps = true;
        weaveBase.needsUpdate = true;
    }
    const key = `${repeat.toFixed(4)}|${rotation.toFixed(4)}|${channel}`;
    let t = weaves.get(key);
    if (!t) {
        t = weaveBase.clone();
        t.repeat.set(repeat, repeat); t.rotation = rotation; t.channel = channel;
        t.anisotropy = anisotropy;
        t.needsUpdate = true;
        weaves.set(key, t);
    }
    return t;
}

/** Scales the probe reflections of one material (the probe system reads userData.gfEnvScale). */
function setEnvScale(mat: Std, scale: number | undefined) {
    const prev = mat.userData.gfEnvScale ?? 1, next = scale ?? 1;
    if (prev === next) return;
    if (scale === undefined) delete mat.userData.gfEnvScale; else mat.userData.gfEnvScale = scale;
    mat.envMapIntensity = (mat.envMapIntensity / prev) * next;
}

const signature = (m: Std) => [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.alphaMap].map((t) => (t ? t.channel : '-')).join();

/**
 * Applies a finish. `channel` is the UV set the textures use (BOX_CHANNEL for box-projected parts),
 * `mpu` the metres covered by one unit of that UV set (1 for box UVs, measured for model UVs).
 * Textures must be loaded (ensureFinish); a missing image falls back to the neutral texture.
 */
export function applyFinish(mat: Std, finish: Finish, channel = 0, mpu = 1, rotOffset = 0) {
    if (!mat.isMeshStandardMaterial) return;
    let o = originals.get(mat);
    if (!o) {
        const p = mat as Phys;
        o = { color: mat.color.clone(), map: mat.map, roughness: mat.roughness, metalness: mat.metalness,
            roughnessMap: mat.roughnessMap, metalnessMap: mat.metalnessMap, normalMap: mat.normalMap,
            normalScale: mat.normalScale.clone(),
            emissive: mat.emissive.clone(), lightMapIntensity: mat.lightMapIntensity, envScale: mat.userData.gfEnvScale,
            alphaMap: mat.alphaMap, opacity: mat.opacity, depthWrite: mat.depthWrite,
            specularIntensity: p.specularIntensity ?? 1, sheen: p.sheen ?? 0,
            sheenColor: p.sheenColor ? p.sheenColor.clone() : new THREE.Color(0), sheenRoughness: p.sheenRoughness ?? 1 };
        originals.set(mat, o);
    }
    const before = signature(mat);
    if (finish.original) {
        mat.color.copy(o.color); mat.map = o.map; mat.roughness = o.roughness; mat.metalness = o.metalness;
        mat.roughnessMap = o.roughnessMap; mat.metalnessMap = o.metalnessMap; mat.normalMap = o.normalMap;
        mat.normalScale.copy(o.normalScale);
        mat.emissive.copy(o.emissive); mat.lightMapIntensity = o.lightMapIntensity;
        mat.alphaMap = o.alphaMap; mat.opacity = o.opacity; mat.depthWrite = o.depthWrite;
        setEnvScale(mat, o.envScale);
        const p = mat as Phys;
        if (p.isMeshPhysicalMaterial) {
            p.specularIntensity = o.specularIntensity; p.sheen = o.sheen; p.sheenColor.copy(o.sheenColor); p.sheenRoughness = o.sheenRoughness;
        }
    } else {
        const white = neutral('white', channel), flat = neutral('normal', channel);
        const set = finish.pbr ? sets.get(finish.pbr) : undefined;
        const tile = finish.tile ?? set?.tile ?? 1;
        const repeat = mpu / tile;
        const rot = THREE.MathUtils.degToRad((finish.rotation ?? 0) + rotOffset);
        const ns = finish.normalScale ?? 1;
        mat.normalScale.set(ns, ns);
        const reqs = requests(finish);
        const resp = RESPONSES[responseOf(finish)];
        let alpha: THREE.Texture | null = null;
        if (set && reqs.length >= 3) {
            const [rb, rn, ro, ra] = reqs.map((r) => texture(r, repeat, rot, channel, finish.stretch ?? 1));
            alpha = ra ?? null;
            mat.map = rb ?? white;
            mat.normalMap = rn ?? flat;
            // lossy WebP leaks a little into ORM.B on non-metals: metal comes from the manifest scalar, except
            // for sets whose metal mask really varies (PBR_METAL_MASK); the slot stays filled so swaps don't recompile
            const mask = !!ro && PBR_METAL_MASK.has(set.id);
            mat.metalnessMap = mask ? ro : white;
            mat.color.set(finish.tint ?? '#ffffff').multiplyScalar(finish.gain ?? 1);
            if (finish.color && rb) {
                // recolour: scale the set so its average becomes `color` (per channel, linear).
                // A set too dark for that (8-bit banding, noise) keeps only its relief and gloss.
                const want = new THREE.Color(finish.color), avg = new THREE.Color(set.color);
                const k = [want.r / Math.max(1e-4, avg.r), want.g / Math.max(1e-4, avg.g), want.b / Math.max(1e-4, avg.b)];
                if (Math.max(...k) > 10) { mat.map = white; mat.color.copy(want); }
                else mat.color.setRGB(k[0], k[1], k[2]);
                mat.color.multiplyScalar(finish.gain ?? 1);
            }
            if (!rb) mat.color.set(finish.color ?? set.color);
            if (finish.roughness !== undefined || !ro) {
                mat.roughnessMap = white; mat.roughness = finish.roughness ?? Math.min(1, set.roughness * (resp.rough ?? 1));
            } else {
                mat.roughnessMap = ro; mat.roughness = finish.roughnessScale ?? resp.rough ?? 1;
            }
            mat.metalness = mask ? finish.metalness ?? 1 : finish.metalness ?? set.metallic;
        } else {
            const legacy = finish.map ? texture(reqs[0], repeat, rot, channel) : null;
            mat.map = legacy ?? white;
            mat.color.set(legacy ? finish.tint ?? '#ffffff' : finish.color ?? '#ffffff');
            if (finish.gain) mat.color.multiplyScalar(finish.gain);
            // a recolour of a model keeps its own weave / grain relief when it sits on the same UVs
            mat.normalMap = !legacy && o.normalMap && o.normalMap.channel === channel ? o.normalMap : flat;
            if (mat.normalMap === o.normalMap) mat.normalScale.copy(o.normalScale);
            mat.roughnessMap = white; mat.metalnessMap = white;
            mat.roughness = finish.roughness ?? (o.roughnessMap ? 0.6 : o.roughness);
            mat.metalness = finish.metalness ?? 0;
        }
        // material response by kind (cloth, leather ...), see RESPONSES
        setEnvScale(mat, resp.env === 1 ? o.envScale : resp.env);
        const p = mat as Phys;
        if (p.isMeshPhysicalMaterial) {
            p.specularIntensity = resp.spec;
            // sheen stays on for cloth materials (one shader for every swap); "no sheen" is a black sheen colour
            p.sheen = 1;
            const base = new THREE.Color(finish.color ?? set?.color ?? '#808080');
            if (finish.tint) base.multiply(new THREE.Color(finish.tint));
            p.sheenColor.copy(base).multiplyScalar(resp.sheen);
            p.sheenRoughness = resp.sheenRoughness;
        }
        // sheer: see-through by alpha, a little light from the window side, never darker than the bake
        if (mat.userData.cfgSheer) {
            const sheer = isSheer(finish, sets);
            mat.alphaMap = sheer ? alpha ?? weave(mpu / WEAVE_TILE, rot, channel) : neutral('white', channel);
            // an open net (manifest `opacity` = average alpha, e.g. 0.25) reads too faint as a curtain: lift the
            // threads' cover towards SHEER_COVER (alpha above 1 clamps on the 8-bit canvas; probes skip sheers)
            const cover = set?.opacity;
            mat.opacity = !sheer ? 1 : finish.opacity ?? (cover ? THREE.MathUtils.clamp(SHEER_COVER / cover, 1, 2) : 1);
            mat.depthWrite = !sheer;
            // folds seen edge-on read denser (manifest alphaGrazing), see sheerGrazing()
            const g = (mat.userData.gfGrazing as THREE.Vector3 | undefined)?.isVector3 ? mat.userData.gfGrazing as THREE.Vector3 : undefined;
            const ag = sheer ? set?.alphaGrazing ?? (set?.alphaFrom ? sets.get(set.alphaFrom)?.alphaGrazing : undefined) : undefined;
            if (g) { if (ag) g.set(ag[0], ag[1], 1); else g.set(0, 1, 0); }
            if (sheer) mat.emissive.copy(new THREE.Color(finish.color ?? set?.color ?? '#ffffff')).multiplyScalar(sheerGlow);
            else mat.emissive.copy(o.emissive);
            mat.lightMapIntensity = o.lightMapIntensity * (sheer ? 1.15 : 1);
        }
    }
    if (before !== signature(mat)) mat.needsUpdate = true;   // only a change in which maps / channels exist needs a new shader
    onTextureLoaded();
}

/**
 * Sheer materials: alpha = mix(alphaMap, 1, smoothstep(g0, g1, 1 - |n·v|)), so a net seen edge-on (folds,
 * the curtain's sides) closes up like real voile. Uniform in userData.gfGrazing = (g0, g1, on); one shader for every swap.
 */
const grazed = new WeakSet<Std>();
export function sheerGrazing(mat: Std) {
    if (grazed.has(mat)) return;          // (a clone carries a JSON copy of userData, not the patch: patch it again)
    grazed.add(mat);
    const u = { value: new THREE.Vector3(0, 1, 0) };
    mat.userData.gfGrazing = u.value;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
        prev?.call(mat, shader, renderer);
        shader.uniforms.gfGrazing = u;
        shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'uniform vec3 gfGrazing;\nvoid main() {')
            .replace('#include <alphamap_fragment>', `#ifdef USE_ALPHAMAP
    float gfA = texture2D( alphaMap, vAlphaMapUv ).g;
    float gfEdge = 1.0 - abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
    diffuseColor.a *= mix( gfA, 1.0, gfGrazing.z * smoothstep( gfGrazing.x, gfGrazing.y, gfEdge ) );
#endif`);
    };
    const prevKey = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => prevKey() + '-gfgrazing';
    mat.needsUpdate = true;
}

// ------------------------------------------------------------------ UVs
/**
 * Writes metre-scale UVs projected along each face's main axis into BOX_CHANNEL (the model's own
 * UV0 stays, so "original" finishes and embedded maps keep working). Faces are projected per
 * vertex normal, so UVs are continuous across a flat face and three.js derives a consistent
 * tangent frame for normal maps from them.
 */
export function boxProject(mesh: THREE.Mesh): number {
    const g = mesh.geometry;
    if (g.userData.cfgBox) return BOX_CHANNEL;
    mesh.updateWorldMatrix(true, false);
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
    const uv = new Float32Array(pos.count * 2);
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (nor) n.fromBufferAttribute(nor, i).applyMatrix3(nm); else n.set(0, 1, 0);
        const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
        // u runs along the surface's horizontal direction, v upwards (or along z on floors)
        if (ay >= ax && ay >= az) { uv[i * 2] = p.x; uv[i * 2 + 1] = -p.z; }
        else if (ax >= az) { uv[i * 2] = n.x > 0 ? -p.z : p.z; uv[i * 2 + 1] = p.y; }
        else { uv[i * 2] = n.z > 0 ? p.x : -p.x; uv[i * 2 + 1] = p.y; }
    }
    g.setAttribute('uv' + BOX_CHANNEL, new THREE.BufferAttribute(uv, 2));
    // tangents (if any) belong to UV0; without them three.js derives the frame from the UVs in use
    if (g.getAttribute('tangent')) g.deleteAttribute('tangent');
    g.userData.cfgBox = true;
    return BOX_CHANNEL;
}

const densities = new WeakMap<THREE.Mesh, number>();
/**
 * Metres covered by one UV0 unit on this mesh (sqrt of world area / UV area). 0 when the mesh has
 * no usable UVs. Lets a texture set tile at its real size on a model's own UV layout.
 */
export function uvDensity(mesh: THREE.Mesh): number {
    if (densities.has(mesh)) return densities.get(mesh)!;
    const g = mesh.geometry, pos = g.getAttribute('position') as THREE.BufferAttribute, uv = g.getAttribute('uv') as THREE.BufferAttribute;
    let d = 0;
    if (pos && uv) {
        mesh.updateWorldMatrix(true, false);
        const idx = g.index, n = idx ? idx.count : pos.count;
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2();
        let wa = 0, ta = 0;
        const step = Math.max(3, Math.floor(n / 3 / 4000) * 3);         // sample up to ~4000 triangles
        for (let i = 0; i + 2 < n; i += step) {
            const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
            a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
            b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
            c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
            ua.fromBufferAttribute(uv, i0); ub.fromBufferAttribute(uv, i1); uc.fromBufferAttribute(uv, i2);
            const w = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
            const t = Math.abs((ub.x - ua.x) * (uc.y - ua.y) - (uc.x - ua.x) * (ub.y - ua.y)) / 2;
            if (!isFinite(t) || !isFinite(w)) continue;
            wa += w; ta += t;
        }
        d = ta > 1e-9 && wa > 1e-9 ? Math.sqrt(wa / ta) : 0;
    }
    densities.set(mesh, d);
    return d;
}
