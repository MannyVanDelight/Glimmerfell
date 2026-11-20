// gf_lighting.js — applies Glimmerfell Bake output to a loaded glTF scene (three.js r160+)
//
//   import { loadGfManifest, applyGfLighting, installGfColour } from './gf_lighting.js';
//   const gf = await loadGfManifest('./models/gf_lightmaps.json');
//   await installGfColour(renderer, gf);    // Blender colour management (before loading models)
//   applyGfLighting(gltf.scene, gf);
//
// Meshes carry their mode in glTF extras (mesh.userData):
//   gf_light = "lightmap" -> lightMap from lightmap_<group>.png on UV channel gf_lightmap_uv
//   gf_light = "vertex"   -> light stored in the COLOR_0 attribute (renamed to gfLight here)
// Material textures (colour/roughness/normal) stay tiled on UV0 and are never baked.

import * as THREE from 'three';

// The manifest is read at once; each group's lightmap is fetched when a model that uses it
// arrives (ensureGfGroups), so the shell can show before the furniture pages have downloaded.
//   light = image.rgb x multiplier.r x intensity   (two 8-bit PNGs per group since Glimmerfell Bake 0.10;
//   older exports have the image only)
export async function loadGfManifest(url) {
    const manifest = await (await fetch(url)).json();
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    return { manifest, maps: {}, mult: {}, base, pending: {} };
}

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

export function ensureGfGroups(gf, root) {
    const groups = new Set();
    root.traverse((o) => { if (o.userData && o.userData.gf_group && o.userData.gf_light === 'lightmap') groups.add(o.userData.gf_group); });
    const loader = new THREE.TextureLoader();
    const jobs = [];
    for (const group of groups) {
        const g = (gf.manifest.groups || {})[group];
        if (!g || !g.image) continue;
        if (!gf.pending[group]) {
            gf.pending[group] = (async () => {
                const [tex, m] = await Promise.all([loader.loadAsync(gf.base + g.image),
                    g.multiplier ? loader.loadAsync(gf.base + g.multiplier) : null]);
                tex.flipY = false;                        // glTF UV convention
                tex.colorSpace = THREE.SRGBColorSpace;    // PNG is sRGB-encoded; the GPU decodes to linear
                tex.channel = 1;                          // overwritten per mesh below
                gf.maps[group] = tex;
                if (m) { m.flipY = false; m.colorSpace = THREE.NoColorSpace; m.channel = 1; gf.mult[group] = m; }
            })();
        }
        jobs.push(gf.pending[group]);
    }
    return Promise.all(jobs);
}

// ---------------------------------------------------------------------------
// Specular-only lights from the Blender scene (manifest.lights, written by Export).
// Materials handled by applyGfLighting ignore their diffuse part, so these lights add
// highlights on glossy floors, lacquer and metal without lighting anything twice.
//   const lights = addGfLights(scene, gf);      // returns the three.js lights
// Blender power (W) -> three.js intensity: point/spot P/(4π) cd, area P/π (as a 90° spot),
// sun = strength. No shadows: a lamp in the next room can put a highlight through a wall.
export function addGfLights(scene, { manifest }, scale = 1) {
    const out = [];
    for (const l of manifest.lights || []) {
        const col = new THREE.Color().fromArray(l.color);
        const pos = new THREE.Vector3().fromArray(l.position), dir = new THREE.Vector3().fromArray(l.direction);
        let light;
        if (l.type === 'SUN') {
            light = new THREE.DirectionalLight(col, l.power);
            light.position.copy(dir).multiplyScalar(-100); light.target.position.set(0, 0, 0);
        } else if (l.type === 'SPOT' || l.type === 'AREA') {
            const area = l.type === 'AREA';
            light = new THREE.SpotLight(col, area ? l.power / Math.PI : l.power / (4 * Math.PI), 0,
                area ? Math.PI / 2 : l.spot_size / 2, area ? 1 : l.spot_blend, 2);
            light.position.copy(pos); light.target.position.copy(pos).add(dir);
        } else {
            light = new THREE.PointLight(col, l.power / (4 * Math.PI), 0, 2);
            light.position.copy(pos);
        }
        light.name = 'gf_' + l.name;
        light.userData.gfBase = light.intensity;
        light.intensity *= scale;
        scene.add(light);
        if (light.target) scene.add(light.target);
        out.push(light);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Blender colour management on the web. Export writes gf_colour_lut.png: a grid of
// scene-linear colours run through the scene's own display / view transform / look /
// exposure / gamma / curves. Applying it per pixel reproduces Blender's look exactly
// (AgX, Filmic, looks, curves), which three.js's built-in tone mappers can't.
//   await installGfColour(renderer, gf);   // once, after loadGfManifest, before loading models
// Older exports without a LUT fall back to installBlenderCurve (Standard + curve).
// renderer.toneMappingExposure still works on top (1 = as in Blender).
export async function installGfColour(renderer, gf) {
    const c = gf.manifest.colour;
    if (!c || !c.lut) { installBlenderCurve(renderer); return null; }
    const n = c.lut_size, blob = await (await fetch(gf.base + c.lut)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
    const src = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const data = new Uint8Array(n * n * n * 4);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
        const s = (((n - 1 - g) * n * n) + b * n + r) * 4;      // PNG rows are top-down; Blender wrote g=0 at the bottom
        const d = ((b * n + g) * n + r) * 4;
        data[d] = src[s]; data[d + 1] = src[s + 1]; data[d + 2] = src[s + 2]; data[d + 3] = 255;
    }
    const lut = new THREE.Data3DTexture(data, n, n, n);
    lut.format = THREE.RGBAFormat; lut.type = THREE.UnsignedByteType;
    lut.minFilter = lut.magFilter = THREE.LinearFilter;
    lut.wrapS = lut.wrapT = lut.wrapR = THREE.ClampToEdgeWrapping;
    lut.unpackAlignment = 1; lut.needsUpdate = true;
    // every built-in material gets the uniform (uniforms are cloned from ShaderLib at compile)
    for (const s of Object.values(THREE.ShaderLib)) if (s.uniforms) s.uniforms.gfColourLut = { value: lut };
    const den = Math.log2(1 + c.lut_k * c.lut_max);
    THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
        /vec3 CustomToneMapping\( vec3 color \) \{[^}]*\}/,
        `uniform highp sampler3D gfColourLut;
vec3 gfToLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) ); }
vec3 CustomToneMapping( vec3 color ) {
    color = max( color * toneMappingExposure, 0.0 );
    vec3 t = clamp( log2( 1.0 + ${c.lut_k.toFixed(4)} * color ) / ${den.toFixed(6)}, 0.0, 1.0 );
    vec3 s = texture( gfColourLut, t * ${((n - 1) / n).toFixed(6)} + ${(0.5 / n).toFixed(6)} ).rgb;   // display-encoded, as Blender shows it
    return gfToLinear( s );                                                       // three.js re-encodes to sRGB on output
}`);
    renderer.toneMapping = THREE.CustomToneMapping;
    return c;
}

// Chain onBeforeCompile so this coexists with other shader patches (e.g. reflection probes)
function chainCompile(material, fn, key) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => { if (prev) prev(shader, renderer); fn(shader); };
    const prevKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => prevKey() + key;
}

// glTF extras sit on the node; multi-material meshes load as a Group of primitives
function gfData(o) {
    for (; o; o = o.parent) if (o.userData && o.userData.gf_light) return o.userData;
    return null;
}

// Patched copy of three's lightmap chunk:
//  - multiplier texture (see loadGfManifest)
//  - reflections fade where the baked light is dark: a surface in a dark corner, behind furniture or
//    against a wall no longer mirrors a bright window it can't see (lightmap-based specular occlusion)
//  - the same factor dims real-time lamp highlights (directSpecular) in shadowed places
// Tuning is shared by all materials: gfSpecOcc.ref (fraction of the atlas median where reflections
// are full), gfSpecOcc.floor (reflection level kept in the darkest corners).
export const gfSpecOcc = { ref: { value: 0.6 }, floor: { value: 0.0 } };
const LIGHTMAP_CHUNK = THREE.ShaderChunk.lights_fragment_maps
    .replace('lightMapTexel.rgb * lightMapIntensity', 'lightMapTexel.rgb * texture2D( gfLmM, vLightMapUv ).r * lightMapIntensity') + `
#if defined( USE_LIGHTMAP ) && defined( RE_IndirectDiffuse )
    float gfOcc = mix( gfOccFloor, 1.0, smoothstep( 0.0, gfSpecRef * gfOccRef, dot( lightMapIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ) );
    reflectedLight.directSpecular *= gfOcc;
    #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
        radiance *= gfOcc;
        #ifdef USE_CLEARCOAT
            clearcoatRadiance *= gfOcc;
        #endif
    #endif
#endif
`;

export function applyGfLighting(root, { manifest, maps, mult = {} }) {
    const cloned = new Map();
    let applied = 0;
    root.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const u = gfData(mesh);
        if (!u) return;
        applied++;
        // manifest wins over glTF extras, so a re-bake doesn't need a re-export
        const gi = u.gf_light === 'vertex' ? manifest.vertex?.[u.gf_group]?.intensity
                                           : manifest.groups?.[u.gf_group]?.intensity;
        const intensity = (gi ?? u.gf_intensity ?? 1) * Math.PI;   // Cycles irradiance -> three.js Lambert
        const convert = (m) => {
            const key = m.uuid + u.gf_light + (u.gf_lightmap_uv ?? '');
            if (cloned.has(key)) return cloned.get(key);
            const mat = m.clone();
            mat.aoMap = null;                       // baked light already holds the occlusion
            if (u.gf_light === 'lightmap') {
                const tex = maps[u.gf_group];
                if (tex) {
                    const t = tex.channel === u.gf_lightmap_uv ? tex : tex.clone();
                    t.channel = u.gf_lightmap_uv;
                    mat.lightMap = t;
                    mat.lightMapIntensity = intensity;
                    let m = mult[u.gf_group] || WHITE;
                    if (m !== WHITE && m.channel !== u.gf_lightmap_uv) { m = m.clone(); m.channel = u.gf_lightmap_uv; }
                    // full reflections from about 60 % (gfSpecOcc.ref) of the typical (median) brightness of this atlas upwards
                    const med = manifest.groups?.[u.gf_group]?.median;
                    const ref = (med ? med : (gi ?? 1) * 0.033) * Math.PI;
                    chainCompile(mat, (shader) => {
                        shader.uniforms.gfLmM = { value: m };
                        shader.uniforms.gfSpecRef = { value: ref };
                        shader.uniforms.gfOccRef = gfSpecOcc.ref;
                        shader.uniforms.gfOccFloor = gfSpecOcc.floor;
                        shader.fragmentShader = 'uniform sampler2D gfLmM;\nuniform float gfSpecRef;\nuniform float gfOccRef;\nuniform float gfOccFloor;\n' +
                            shader.fragmentShader.replace('#include <lights_fragment_maps>', LIGHTMAP_CHUNK);
                    }, '-gfrgbm');
                }
            } else if (u.gf_light === 'vertex') {
                mat.vertexColors = false;           // light, not albedo
                chainCompile(mat, (shader) => {
                    shader.uniforms.gfIntensity = { value: intensity };
                    shader.vertexShader = 'attribute vec3 gfLight;\nvarying vec3 vGfLight;\n' +
                        shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvGfLight = gfLight;');
                    shader.fragmentShader = 'uniform float gfIntensity;\nvarying vec3 vGfLight;\n' +
                        shader.fragmentShader.replace('#include <lights_fragment_maps>',
                            '#include <lights_fragment_maps>\n#if defined( RE_IndirectDiffuse )\nirradiance += vGfLight * gfIntensity;\n#endif');
                }, '-gfvertex');
            }
            // diffuse light is baked: real-time lights (addGfLights) may only add highlights
            chainCompile(mat, (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>',
                    '#include <lights_fragment_end>\nreflectedLight.directDiffuse = vec3( 0.0 );');
            }, '-gfspeconly');
            cloned.set(key, mat);
            return mat;
        };
        if (u.gf_light === 'vertex') {
            const g = mesh.geometry;
            const c = g.getAttribute('color');
            if (c && !g.getAttribute('gfLight')) {
                g.setAttribute('gfLight', c);
                g.deleteAttribute('color');
            }
        }
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    });
    return applied;
}

// ---------------------------------------------------------------------------
// Match Blender's colour management: view transform "Standard" + an RGB curve.
// Pass the curve points from Render Properties > Color Management > Curves
// (combined C curve). Default = the Creek Apartment curve (0.4438 -> 0.635).
//   installBlenderCurve(renderer);            // call once, before the first render
//   renderer.toneMappingExposure = 1.0;       // = Blender exposure 0 (2^exposure)
export function installBlenderCurve(renderer, points = [[0, 0], [0.4438, 0.635], [1, 1]]) {
    const n = 33;
    const lut = monotoneLUT(points, n);
    THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
        /vec3 CustomToneMapping\( vec3 color \) \{[^}]*\}/,
        `const float GF_LUT[${n}] = float[](${lut.map((v) => v.toFixed(5)).join(',')});
float gfCurve( float x ) {
    float f = clamp( x, 0.0, 1.0 ) * ${n - 1}.0;
    int i = int( floor( f ) );
    int j = min( i + 1, ${n - 1} );
    return mix( GF_LUT[ i ], GF_LUT[ j ], f - float( i ) );
}
vec3 gfToSRGB( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) ); }
vec3 gfToLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) ); }
vec3 CustomToneMapping( vec3 color ) {
    color *= toneMappingExposure;
    vec3 s = gfToSRGB( clamp( color, 0.0, 1.0 ) );                  // display space, like Blender
    s = vec3( gfCurve( s.r ), gfCurve( s.g ), gfCurve( s.b ) );
    return gfToLinear( s );                                         // three.js re-encodes to sRGB on output
}`);
    renderer.toneMapping = THREE.CustomToneMapping;
}

// Monotone cubic (Fritsch-Carlson) through the curve points, sampled to n steps
function monotoneLUT(p, n) {
    const k = p.length, d = [], m = [];
    for (let i = 0; i < k - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
    m[0] = d[0]; m[k - 1] = d[k - 2];
    for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < k - 1; i++) {
        if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
        const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
        if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    const out = [];
    for (let s = 0; s < n; s++) {
        const x = s / (n - 1);
        let i = 0; while (i < k - 2 && x > p[i + 1][0]) i++;
        const h = p[i + 1][0] - p[i][0], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
        out.push((2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] +
                 (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]);
    }
    return out;
}
