// gf_probe.js — box-projected reflection probes for Glimmerfell exports (three.js r160+)
//
// The probes only add reflections; diffuse light stays the baked lightmap. Each probe captures the
// lightmapped scene itself (plus the sky through the windows) from a point inside a room, so
// floors, lacquer and metals reflect that room's real bright and dark patches.
//
//   const probes = new GfProbes(renderer, scene, [{ position, box }, { position, box }]);
//   probes.register(material);                      // every baked material (after applyGfLighting)
//   probes.register(material, { diffuse: true });   // unbaked models (taps): the probe also lights them
//   probes.capture({ size: 256, hide: [...], background: hdrSky });
//
// Up to two probes. `box` is the room a probe stands in: it bounds the box projection, and each
// fragment reflects the probe whose room it is in (soft blend across `blend` metres, e.g. in a
// doorway). The same room boxes also gate the real-time lamp highlights: `setActiveRoom(i)` keeps
// direct specular only on fragments in the camera's room, so a lamp never shines through a wall.

import * as THREE from 'three';

const PROBE_CHUNK = /* glsl */`
#ifdef USE_ENVMAP
vec3 gfBoxDir( vec3 d, vec3 c, vec3 mn, vec3 mx ) {
    vec3 sd = mix( vec3( 1.0 ), sign( d ), step( vec3( 1e-5 ), abs( d ) ) ) * max( abs( d ), vec3( 1e-5 ) );
    vec3 o = clamp( vProbeWorld, mn + 0.001, mx - 0.001 );
    vec3 hit = max( ( mx - o ) / sd, ( mn - o ) / sd );
    float t = min( min( hit.x, hit.y ), hit.z );
    return o + d * t - c;
}
vec3 gfProbeSample( vec3 dir, float roughness, bool parallax ) {
    vec3 d0 = parallax ? gfBoxDir( dir, gfP0Pos, gfP0Min, gfP0Max ) : dir;
    vec3 col = textureCubeUV( envMap, d0, roughness ).rgb;
    #if GF_PROBES > 1
        float w = gfRoomWeight( vProbeWorld, gfP1Min, gfP1Max );
        if ( w > 0.001 ) {
            vec3 d1 = parallax ? gfBoxDir( dir, gfP1Pos, gfP1Min, gfP1Max ) : dir;
            col = mix( col, textureCubeUV( gfEnv1, d1, roughness ).rgb, w );
        }
    #endif
    return col;
}
vec3 getIBLIrradiance( const in vec3 normal ) {
    #ifdef GF_DIFFUSE_ENV
        vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
        return PI * gfProbeSample( worldNormal, 1.0, false ) * envMapIntensity;
    #else
        return vec3( 0.0 );   // diffuse light comes from the lightmap
    #endif
}
vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
    vec3 reflectVec = reflect( - viewDir, normal );
    reflectVec = normalize( mix( reflectVec, normal, roughness * roughness ) );
    reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
    return gfProbeSample( reflectVec, roughness, true ) * envMapIntensity;
}
#ifdef USE_ANISOTROPY
vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
    vec3 bentNormal = cross( bitangent, viewDir );
    bentNormal = normalize( cross( bentNormal, bitangent ) );
    bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
    return getIBLRadiance( viewDir, bentNormal, roughness );
}
#endif
#endif
`;

export class GfProbes {
    constructor(renderer, scene, defs, { blend = 0.35 } = {}) {
        this.renderer = renderer; this.scene = scene;
        this.defs = defs.slice(0, 2).map((d) => ({ position: d.position.clone(), box: d.box ? d.box.clone() : null }));
        this.count = Math.max(1, this.defs.length);
        this.materials = new Map();     // material -> { diffuse }
        this.targets = [];
        this.intensity = 1;
        this.pmrem = null;
        const v3 = (x = 0) => ({ value: new THREE.Vector3(x, x, x) });
        this.uniforms = {
            gfP0Pos: v3(), gfP0Min: v3(-1e4), gfP0Max: v3(1e4),
            gfP1Pos: v3(), gfP1Min: v3(1e4), gfP1Max: v3(1e4),
            gfEnv1: { value: null },
            gfBlend: { value: blend },
            gfMaskMin: v3(-1e4), gfMaskMax: v3(1e4),
            gfLampSpec: { value: 1 },
        };
    }

    get size() { return this.targets[0] ? this.targets[0].texture : null; }
    /** PMREM texture of a probe (for materials outside the probe system, e.g. as a plain envMap). */
    texture(i = 0) { return this.targets[i] ? this.targets[i].texture : null; }

    /** Index of the room (probe box) that contains p, else the nearest probe. */
    roomOf(p) {
        let best = 0, bd = Infinity;
        this.defs.forEach((d, i) => {
            const k = d.box ? d.box.distanceToPoint(p) : d.position.distanceTo(p);
            if (k < bd) { bd = k; best = i; }
        });
        return best;
    }

    /** Lamp highlights only on fragments in this room (null: everywhere). */
    setActiveRoom(i) {
        const b = i === null || i === undefined ? null : this.defs[i]?.box;
        this.uniforms.gfMaskMin.value.copy(b ? b.min : new THREE.Vector3(-1e4, -1e4, -1e4));
        this.uniforms.gfMaskMax.value.copy(b ? b.max : new THREE.Vector3(1e4, 1e4, 1e4));
    }

    setLampSpecular(v) { this.uniforms.gfLampSpec.value = v; }

    register(material, { diffuse = false } = {}) {
        if (this.materials.has(material) || !material.isMeshStandardMaterial) return;
        this.materials.set(material, { diffuse });
        const u = this.uniforms, n = this.count, prev = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if (prev) prev(shader, renderer);
            Object.assign(shader.uniforms, u);
            shader.vertexShader = 'varying vec3 vProbeWorld;\n' + shader.vertexShader.replace('#include <worldpos_vertex>',
                '#include <worldpos_vertex>\nvProbeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
            const head = `#define GF_PROBES ${n}\n${diffuse ? '#define GF_DIFFUSE_ENV\n' : ''}varying vec3 vProbeWorld;
uniform vec3 gfP0Pos; uniform vec3 gfP0Min; uniform vec3 gfP0Max;
uniform vec3 gfP1Pos; uniform vec3 gfP1Min; uniform vec3 gfP1Max; uniform float gfBlend;
uniform vec3 gfMaskMin; uniform vec3 gfMaskMax; uniform float gfLampSpec;
#if GF_PROBES > 1
uniform sampler2D gfEnv1;
#endif
float gfRoomWeight( vec3 p, vec3 mn, vec3 mx ) {
    vec3 o = max( max( mn - p, p - mx ), 0.0 );
    return 1.0 - smoothstep( 0.0, gfBlend, length( o ) );
}
`;
            shader.fragmentShader = head + shader.fragmentShader
                .replace('#include <envmap_physical_pars_fragment>', PROBE_CHUNK)
                // real-time lamps add highlights only in the camera's room (no shadows: walls would not stop them)
                .replace('#include <lights_fragment_end>',
                    '#include <lights_fragment_end>\nreflectedLight.directSpecular *= gfLampSpec * gfRoomWeight( vProbeWorld, gfMaskMin, gfMaskMax );');
        };
        const prevKey = material.customProgramCacheKey.bind(material);
        material.customProgramCacheKey = () => prevKey() + `-gfprobes${n}${diffuse ? 'd' : ''}`;
        if (this.targets.length) this.#apply(material);
    }

    /** Parallax box when a probe has none: floor/ceiling by rays, width/length from the whole scene. */
    #roomBox(p) {
        const ray = new THREE.Raycaster(), lo = p.clone(), hi = p.clone();
        const all = new THREE.Box3().setFromObject(this.scene);
        lo.x = all.min.x; lo.z = all.min.z; hi.x = all.max.x; hi.z = all.max.z;
        for (const d of [[0, 1, 0], [0, -1, 0]]) {
            const v = new THREE.Vector3(...d);
            ray.set(p, v); ray.far = 1e4;
            const hit = ray.intersectObject(this.scene, true)[0];
            const q = hit ? hit.point : p.clone().add(v.multiplyScalar(1e3)).clamp(all.min, all.max);
            lo.min(q); hi.max(q);
        }
        return new THREE.Box3(lo, hi);
    }

    /**
     * Captures every probe. `background` replaces scene.background during the capture (the HDR sky,
     * so windows reflect at their real brightness), with `backgroundIntensity`.
     */
    capture({ size = 256, hide = [], background = undefined, backgroundIntensity = 1 } = {}) {
        const r = this.renderer, s = this.scene;
        // capture without reflections (no feedback) and without tone mapping (linear HDR)
        const mats = [...this.materials.keys()];
        for (const m of mats) m.envMap = null;
        const vis = hide.map((o) => [o, o.visible]); hide.forEach((o) => (o.visible = false));
        const old = { tone: r.toneMapping, xr: r.xr.enabled, bg: s.background, bgI: s.backgroundIntensity, env: s.environment };
        r.toneMapping = THREE.NoToneMapping; r.xr.enabled = false;
        if (background !== undefined) { s.background = background; s.backgroundIntensity = backgroundIntensity; }
        s.environment = null;
        const next = [];
        try {
            this.defs.forEach((d, i) => {
                if (!d.box) d.box = this.#roomBox(d.position);
                const cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
                const cam = new THREE.CubeCamera(0.02, 500, cubeRT);
                cam.position.copy(d.position);
                cam.update(r, s);
                // one generator per probe: reusing one for a second fromCubemap() returns an empty target (r170)
                const pmrem = new THREE.PMREMGenerator(r);
                next.push(pmrem.fromCubemap(cubeRT.texture));
                pmrem.dispose(); cubeRT.dispose();
                const k = `gfP${i}`;
                this.uniforms[k + 'Pos'].value.copy(d.position);
                this.uniforms[k + 'Min'].value.copy(d.box.min);
                this.uniforms[k + 'Max'].value.copy(d.box.max);
            });
        } finally {
            r.toneMapping = old.tone; r.xr.enabled = old.xr;
            s.background = old.bg; s.backgroundIntensity = old.bgI; s.environment = old.env;
            vis.forEach(([o, v]) => (o.visible = v));
        }
        for (const t of this.targets) t.dispose();
        this.targets = next;
        this.uniforms.gfEnv1.value = next[1] ? next[1].texture : next[0].texture;
        for (const m of mats) this.#apply(m);
    }

    setIntensity(v) {
        this.intensity = v;
        for (const m of this.materials.keys()) m.envMapIntensity = v * (m.userData.gfEnvScale ?? 1);
    }

    #apply(m) {
        m.envMap = this.targets[0].texture;
        m.envMapIntensity = this.intensity * (m.userData.gfEnvScale ?? 1);
        m.needsUpdate = true;
    }
}
