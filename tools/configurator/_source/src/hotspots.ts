// Tappable points on the key elements: HTML buttons projected from 3D anchors after every render.
// Hidden when behind the camera, off screen or occluded (ray against the coarse colliders, throttled),
// faded while the camera flies.

import * as THREE from 'three';
import type { Viewer } from './viewer';
import { rayBox, type Collider } from './rig';

export interface Spot {
    id: string;
    label: string;
    /** "zone" spots always show their label. */
    kind: 'zone' | 'element' | 'room';
    point: THREE.Vector3;
    /** Element ids whose colliders never hide this spot (its own boxes). */
    ignore?: string[];
    aria?: string;
    onClick: () => void;
}

interface Live { spot: Spot; btn: HTMLButtonElement; visible: boolean; occluded: boolean; x: number; y: number }

const _v = new THREE.Vector3(), _d = new THREE.Vector3();

export class Hotspots {
    private live: Live[] = [];
    private lastOcc = 0;
    private occTimer = 0;
    private shown = true;

    constructor(private layer: HTMLElement, private viewer: Viewer) {
        viewer.onRender.push(() => this.update());
    }

    set(spots: Spot[]) {
        const keep = new Map(this.live.map((l) => [l.spot.id + '|' + l.spot.kind, l]));
        const next: Live[] = [];
        for (const s of spots) {
            const key = s.id + '|' + s.kind;
            let l = keep.get(key);
            if (l) { keep.delete(key); l.spot = s; this.label(l); }
            else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'hs hidden hs-' + s.kind;
                btn.tabIndex = -1;
                btn.innerHTML = '<span class="hs-dot" aria-hidden="true"></span><span class="hs-label"></span>';
                l = { spot: s, btn, visible: false, occluded: false, x: -999, y: -999 };
                const ref = l;
                btn.addEventListener('click', (e) => { e.stopPropagation(); ref.spot.onClick(); });
                this.label(l);
                this.layer.appendChild(btn);
            }
            next.push(l);
        }
        for (const l of keep.values()) l.btn.remove();
        this.live = next;
        this.lastOcc = 0;
        this.update();
    }

    private label(l: Live) {
        l.btn.querySelector('.hs-label')!.textContent = l.spot.label;
        l.btn.setAttribute('aria-label', l.spot.aria ?? l.spot.label);
        l.btn.dataset.id = l.spot.id;
    }

    /** Hide all spots (element mode) without forgetting them. */
    show(on: boolean) {
        this.shown = on;
        this.layer.classList.toggle('off', !on);
        for (const l of this.live) l.btn.tabIndex = on && l.visible ? 0 : -1;
    }

    update() {
        const cam = this.viewer.camera;
        const w = this.layer.clientWidth, h = this.layer.clientHeight;
        this.layer.classList.toggle('flying', this.viewer.flying);
        const now = performance.now();
        const doOcc = now - this.lastOcc > 110;
        if (doOcc) this.lastOcc = now;
        else { clearTimeout(this.occTimer); this.occTimer = window.setTimeout(() => { this.lastOcc = 0; this.update(); }, 130); }
        cam.updateMatrixWorld();
        for (const l of this.live) {
            _v.copy(l.spot.point).project(cam);
            const inFront = _v.z > -1 && _v.z < 1;
            let x = (_v.x + 1) / 2 * w, y = (1 - _v.y) / 2 * h;
            let onScreen = inFront && x > 8 && x < w - 8 && y > 8 && y < h - 8;
            // an area outside the frame stays reachable: pinned to the edge it lies beyond
            const edge = !onScreen && inFront && l.spot.kind === 'zone';
            if (edge) {
                x = THREE.MathUtils.clamp(x, 26, w - 26);
                y = THREE.MathUtils.clamp(y, h * 0.2, h * 0.75);
                onScreen = true;
                l.occluded = false;
            } else if (doOcc && onScreen) l.occluded = this.occluded(l.spot);
            l.btn.classList.toggle('edge', edge);
            const vis = onScreen && !l.occluded;
            if (vis !== l.visible) {
                l.visible = vis;
                l.btn.classList.toggle('hidden', !vis);
                l.btn.tabIndex = vis && this.shown ? 0 : -1;
                l.btn.setAttribute('aria-hidden', String(!vis));
            }
            if (onScreen && (Math.abs(x - l.x) > 0.25 || Math.abs(y - l.y) > 0.25)) {
                l.x = x; l.y = y;
                l.btn.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
            }
        }
        this.declutter(w);
    }

    /** Labels sit right of the dot; one that would run into a neighbour (or the edge) flips left. */
    private declutter(w: number) {
        type R = [number, number, number, number];
        const hit = (a: R, b: R) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        const vis = this.live.filter((l) => l.visible);
        // dots are fixed; labels go right of their dot unless that runs into something
        const taken: R[] = vis.map((l) => [l.x - 12, l.y - 12, l.x + 12, l.y + 12]);
        const order = [...vis].sort((a, b) => Number(b.btn.classList.contains('edge')) - Number(a.btn.classList.contains('edge')) || a.x - b.x);
        for (const l of order) {
            const lw = (l.btn.lastElementChild as HTMLElement).offsetWidth;
            const right: R = [l.x + 14, l.y - 15, l.x + 14 + lw, l.y + 15];
            const left: R = [l.x - 14 - lw, l.y - 15, l.x - 14, l.y + 15];
            const cost = (r: R) => (r[0] > 4 && r[2] < w - 4 ? 0 : 10) + taken.filter((t) => hit(t, r)).length;
            const flip = cost(left) < cost(right);
            l.btn.classList.toggle('flip', flip);
            taken.push(flip ? left : right);
        }
    }

    private occluded(s: Spot) {
        return occluded(this.viewer.colliders, this.viewer.camera.position, s.point, s.ignore);
    }
}

/** Line of sight from `o` to `p` against the collider boxes (boxes touching `p` never hide it). */
export function occluded(colliders: Collider[], o: THREE.Vector3, p: THREE.Vector3, ignore?: string[]) {
    _d.copy(p).sub(o);
    const len = _d.length();
    if (len < 1e-6) return false;
    _d.divideScalar(len);
    for (const c of colliders) {
        if (c.element && ignore?.includes(c.element)) continue;
        if (c.raw.distanceToPoint(p) < 0.04 || c.raw.containsPoint(o)) continue;
        const hit = rayBox(o, _d, c.raw);
        if (hit && hit[1] > 0 && hit[0] < len - 0.05) return true;
    }
    return false;
}
