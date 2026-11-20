// Camera rig: orbit around the preset's target (element or zone centre) with per-camera limits and
// collision against the coarse boxes in scene.json. The constraint works on the orbit radius, not
// on the position after the fact, so sliding along a wall stays smooth.
//
// Rules for one ray from the target in the camera direction, per box (grown by a margin):
//  - box does not contain the target           -> the camera stops at the grown box (max radius)
//  - box is the inspected element / contains the target in its raw form ("self")
//                                              -> no line-of-sight block, but the camera must be
//                                                 outside the grown box (min radius / skip interval)
//  - only the margin contains the target       -> if the ray goes into the raw box: blocked;
//                                                 otherwise the camera must leave the margin
// A rotation step that leaves no room for the camera (a wall right behind the target) is refused,
// so walls act as soft stops instead of pulling the camera into the subject.

import * as THREE from 'three';
import type { BoxData, CameraPreset } from './types';

const DEG = Math.PI / 180;
const MARGIN_STRUCT = 0.25;     // walls, floor, ceiling, partition
const MARGIN_OBJ = 0.2;         // furniture, kitchen run
const ROOM_MARGIN = 0.2;
const STRUCT = new Set(['wall', 'floor', 'ceiling']);

export interface Collider { raw: THREE.Box3; grown: THREE.Box3; kind: string; element?: string; name?: string; tall: boolean }

export function makeColliders(list: BoxData[] = []): Collider[] {
    return list.map((b) => {
        const raw = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
        const kind = b.kind ?? guessKind(raw);
        const m = STRUCT.has(kind) ? MARGIN_STRUCT : MARGIN_OBJ;
        return { raw, grown: raw.clone().expandByScalar(m), kind, element: b.element, name: b.name, tall: raw.max.y - raw.min.y > 2.2 };
    });
}

/** Without a kind from the exporter: thin full-height slabs are walls, flat wide ones floor/ceiling. */
function guessKind(b: THREE.Box3): string {
    const s = b.getSize(new THREE.Vector3());
    if (s.y < 0.45 && s.x > 3 && s.z > 3) return b.min.y > 1.5 ? 'ceiling' : 'floor';
    if (s.y > 2.3 && Math.min(s.x, s.z) < 0.4 && Math.max(s.x, s.z) > 1.5) return 'wall';
    return 'furniture';
}

/** Slab test. Returns [tNear, tFar] of the infinite line o + t*d, or null when it misses. */
export function rayBox(o: THREE.Vector3, d: THREE.Vector3, b: THREE.Box3): [number, number] | null {
    let t0 = -Infinity, t1 = Infinity;
    for (const a of ['x', 'y', 'z'] as const) {
        const da = d[a], oa = o[a], lo = b.min[a], hi = b.max[a];
        if (Math.abs(da) < 1e-9) { if (oa < lo || oa > hi) return null; continue; }
        let ta = (lo - oa) / da, tb = (hi - oa) / da;
        if (ta > tb) { const x = ta; ta = tb; tb = x; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return null;
    }
    return [t0, t1];
}

export interface Limits { yaw: [number, number]; phi: [number, number]; dist: [number, number] }

const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _o = new THREE.Vector3();

export class Rig {
    target = new THREE.Vector3();
    /** False while the viewer flies the camera; input is ignored then. */
    enabled = false;
    colliders: Collider[] = [];
    private room: THREE.Box3 | null = null;
    private theta = 0; private phi = Math.PI / 2; private dist = 3;
    private gTheta = 0; private gPhi = Math.PI / 2; private gDist = 3;
    private r = 3;
    private theta0 = 0; private presetDist = 3;
    private lim: Limits = { yaw: [-Math.PI, Math.PI], phi: [0.1, 1.7], dist: [1, 4] };
    private self = new Set<string>();
    private pointers = new Map<number, { x: number; y: number }>();
    private pinch = 0;
    /** True between pointer down and up (a drag is not a click). */
    dragging = false;
    onStart: () => void = () => {};

    constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
        dom.addEventListener('pointerdown', this.down);
        dom.addEventListener('pointermove', this.move);
        dom.addEventListener('pointerup', this.up);
        dom.addEventListener('pointercancel', this.up);
        dom.addEventListener('wheel', this.wheel, { passive: false });
        dom.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    /** Doorways block the orbit too, so the camera stays in the room of what it looks at. */
    setWorld(colliders: Collider[], room: THREE.Box3 | null, doorways: THREE.Box3[] = []) {
        const doors: Collider[] = doorways.map((d, i) => ({ raw: d.clone(), grown: d.clone().expandByScalar(MARGIN_STRUCT), kind: 'door', name: 'doorway-' + i, tall: true }));
        this.colliders = colliders;
        this.orbitColliders = [...colliders, ...doors];
        this.room = room ? room.clone().expandByScalar(-ROOM_MARGIN) : null;
    }
    private orbitColliders: Collider[] = [];

    // ---------------------------------------------------------------- presets
    /** Limits and orbit state of a preset; returns where the camera ends up (collision applied). */
    prepare(p: CameraPreset, zone: boolean, self: string[] = []) {
        const t = new THREE.Vector3(...p.target), off = new THREE.Vector3(...p.position).sub(t);
        const s = new THREE.Spherical().setFromVector3(off);
        const yaw = p.yaw ?? (zone ? [-110, 110] : [-100, 100]);
        const pitch = p.pitch ?? [-8, 75];
        const dist = p.dist ?? [0.45, 1.6];
        const lim: Limits = {
            yaw: [Math.min(0, yaw[0] * DEG), Math.max(0, yaw[1] * DEG)],
            phi: [Math.min(s.phi, (90 - pitch[1]) * DEG), Math.max(s.phi, (90 - pitch[0]) * DEG)],
            dist: [s.radius * dist[0], s.radius * dist[1]],
        };
        const state = { target: t, theta: s.theta, phi: s.phi, dist: s.radius, lim, self: new Set(self) };
        const prev = { self: this.self, t: this.target.clone(), lim: this.lim };
        this.self = state.self; this.target.copy(t); this.lim = lim;
        const r = this.solve(s.theta, s.phi, s.radius).r;
        this.self = prev.self; this.target.copy(prev.t); this.lim = prev.lim;
        const position = t.clone().add(off.setLength(r));
        return { ...state, r, position };
    }

    /** Takes over at the end of a flight (or instantly). */
    apply(st: ReturnType<Rig['prepare']>) {
        this.target.copy(st.target);
        this.theta = this.gTheta = this.theta0 = st.theta;
        this.phi = this.gPhi = st.phi;
        this.dist = this.gDist = this.presetDist = st.dist;
        this.r = st.r;
        this.lim = st.lim;
        this.self = st.self;
        this.place();
        this.enabled = true;
    }

    // ---------------------------------------------------------------- constraint
    private dir(theta: number, phi: number, out = _d) {
        const sp = Math.sin(phi);
        return out.set(sp * Math.sin(theta), Math.cos(phi), sp * Math.cos(theta));
    }

    /** Allowed radius along a direction from the target. */
    solve(theta: number, phi: number, want: number) {
        const d = this.dir(theta, phi), o = this.target;
        let maxR = Infinity, minR = 0;
        const skip: [number, number][] = [];
        if (this.room && this.room.containsPoint(o)) {
            const h = rayBox(o, d, this.room);
            if (h) maxR = Math.min(maxR, h[1]);
        }
        for (const c of this.orbitColliders) {
            const g = rayBox(o, d, c.grown);
            if (!g || g[1] <= 0) continue;
            const [tn, tf] = g;
            const isSelf = (c.element && this.self.has(c.element)) || c.raw.containsPoint(o);
            if (isSelf) {
                if (tn <= 0) minR = Math.max(minR, tf); else skip.push([tn, tf]);
            } else if (tn <= 0) {
                // only the margin holds the target: the camera must get out of the margin, and a ray
                // that runs into the box itself is blocked short of it (that direction is refused)
                minR = Math.max(minR, tf);
                const raw = rayBox(o, d, c.raw);
                if (raw && raw[1] > 0) maxR = Math.min(maxR, Math.max(0.05, raw[0] - 0.1));
            } else {
                maxR = Math.min(maxR, tn);
            }
        }
        let r = Math.min(Math.max(want, minR), maxR);
        for (const [tn, tf] of skip) {
            if (r > tn && r < tf) r = tf <= maxR ? tf : tn;
        }
        // a direction is usable only if the camera can stand nearly as far out as the zoom-in limit
        const need = Math.max(0.4, this.lim.dist[0] * 0.85);
        return { r: Math.max(0.05, r), valid: maxR >= Math.max(minR, need), maxR, minR };
    }

    /** Moves the goal angles, refusing steps that leave no room for the camera. */
    private steer(theta: number, phi: number) {
        const L = this.lim;
        theta = THREE.MathUtils.clamp(theta, this.theta0 + L.yaw[0], this.theta0 + L.yaw[1]);
        phi = THREE.MathUtils.clamp(phi, L.phi[0], L.phi[1]);
        const cur = this.solve(this.gTheta, this.gPhi, this.gDist).valid;
        for (const [t, p] of [[theta, phi], [theta, this.gPhi], [this.gTheta, phi]]) {
            if (!cur || this.solve(t, p, this.gDist).valid) { this.gTheta = t; this.gPhi = p; return; }
        }
    }

    private zoom(f: number) {
        const L = this.lim.dist;
        const from = f < 1 ? Math.min(this.gDist, this.r * 1.001) : this.gDist;
        this.gDist = THREE.MathUtils.clamp(from * f, L[0], L[1]);
    }

    // ---------------------------------------------------------------- per frame
    /** Returns true when the camera moved. */
    update(dt: number): boolean {
        if (!this.enabled) return false;
        const k = 1 - Math.exp(-dt * 10);
        this.theta += (this.gTheta - this.theta) * k;
        this.phi += (this.gPhi - this.phi) * k;
        this.dist += (this.gDist - this.dist) * k;
        const want = this.solve(this.theta, this.phi, this.dist).r;
        // pull in at once (never through a wall), ease back out
        if (want < this.r) this.r = want; else this.r += (want - this.r) * (1 - Math.exp(-dt * 5));
        _o.copy(this.camera.position);
        this.place();
        return _o.distanceToSquared(this.camera.position) > 1e-12;
    }

    private place() {
        _p.copy(this.dir(this.theta, this.phi)).multiplyScalar(this.r).add(this.target);
        this.camera.position.copy(_p);
        this.camera.lookAt(this.target);
    }

    /** True when a straight path between two points runs through a wall. */
    blocked(a: THREE.Vector3, b: THREE.Vector3) {
        const d = b.clone().sub(a), len = d.length();
        if (len < 1e-6) return false;
        d.divideScalar(len);
        for (const c of this.colliders) {
            if (c.kind !== 'wall' || c.raw.containsPoint(a) || c.raw.containsPoint(b)) continue;
            const h = rayBox(a, d, c.raw);
            if (h && h[1] > 0 && h[0] < len) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- input
    private down = (e: PointerEvent) => {
        if (e.button > 0 && e.pointerType === 'mouse') return;
        try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 1) { this.dragging = true; this.onStart(); }
        if (this.pointers.size === 2) this.pinch = this.spread();
    };

    private move = (e: PointerEvent) => {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (!this.enabled) return;
        if (this.pointers.size === 1) {
            const a = (2 * Math.PI / Math.max(300, this.dom.clientHeight)) * 0.5;
            this.steer(this.gTheta - dx * a, this.gPhi - dy * a);
        } else if (this.pointers.size === 2) {
            const s = this.spread();
            if (this.pinch > 0 && s > 0) this.zoom(this.pinch / s);
            this.pinch = s;
        }
    };

    private up = (e: PointerEvent) => {
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinch = 0;
        if (!this.pointers.size) this.dragging = false;
    };

    private wheel = (e: WheelEvent) => {
        e.preventDefault();
        if (!this.enabled) return;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoom(Math.exp(THREE.MathUtils.clamp(dy, -200, 200) * 0.0012));
    };

    private spread() {
        const [a, b] = [...this.pointers.values()];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    }
}

/** ?debug=colliders: collider boxes, grown margins and hotspot anchors as wireframes. */
export function debugGroup(colliders: Collider[], points: THREE.Vector3[]): THREE.Group {
    const g = new THREE.Group();
    g.name = 'cfg_debug';
    const colours: Record<string, number> = { wall: 0xff3b30, floor: 0x8e8e93, ceiling: 0x8e8e93, furniture: 0x0a84ff };
    for (const c of colliders) {
        const h = new THREE.Box3Helper(c.raw, colours[c.kind] ?? 0x34c759);
        (h.material as THREE.LineBasicMaterial).depthTest = false;
        h.renderOrder = 999;
        g.add(h);
    }
    const geo = new THREE.SphereGeometry(0.04, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, wireframe: true, depthTest: false });
    for (const p of points) { const m = new THREE.Mesh(geo, mat); m.position.copy(p); m.renderOrder = 999; g.add(m); }
    return g;
}
