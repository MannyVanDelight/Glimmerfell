// Interface: zone tabs, hotspots, the left rail (current zone only), the options panel for one
// element (right-hand on desktop, bottom sheet on phones), the always-visible total and the summary.
// Everything is built from config.json (+ scene.json for anchors).

import * as THREE from 'three';
import type { Config, Cta, Element, Finish, Part, SceneData, Slot, SummaryLine, Zone } from './types';
import type { Configurator } from './configurator';
import type { Viewer } from './viewer';
import { Hotspots, occluded, type Spot } from './hotspots';
import { rayBox } from './rig';
import { pbrSet, swatchOf } from './finishes';
import { DEFAULT_LABELS as CATEGORY_LABELS } from './catalogue';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};
const $ = (id: string) => document.getElementById(id)!;
const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

export function money(v: number, currency: string) {
    return new Intl.NumberFormat('en-NZ', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
}
/** "NZD 48,300": the currency code reads clearly next to a price that is only indicative. */
export function amount(v: number, currency: string) {
    return `${currency} ${new Intl.NumberFormat('en-NZ', { maximumFractionDigits: 0 }).format(Math.round(v))}`;
}

type CtaVars = { url: string; items: string; total: string; code: string; summary: string };

/** Fills {url}, {items}, {total}, {code}, {summary} in a call-to-action text. */
function fillCta(s: string, v: CtaVars) {
    return s.replace(/\{(url|items|total|code|summary)\}/g, (_, k: keyof CtaVars) => v[k]);
}

/** The texts a call to action can carry. `summary`: code, total and link in a few lines (also what "copy" copies). */
export function ctaVars(url: string, lines: SummaryLine[], currency: string, code: string | null): CtaVars {
    const total = amount(lines.reduce((a, l) => a + l.price, 0), currency);
    // mail clients cut very long mailto links: the item list is kept short, the link is what matters
    let items = lines.map((l) => `- ${l.name}${l.finishes.length ? ', ' + l.finishes.join(', ') : ''}`).join('\n');
    if (items.length > 600) items = items.slice(0, 600).replace(/\n[^\n]*$/, '') + '\n- … (full list behind the link)';
    const summary = ['My configuration from the Glimmerfell configurator', code ? `Code: ${code}` : '', `Indicative total: ${total}`, url]
        .filter(Boolean).join('\n');
    return { url, items, total, code: code ?? '', summary };
}

/** The address a call to action opens (mailto with subject and body, or a url with the values encoded). */
export function ctaHref(cta: Cta, v: CtaVars): string {
    if (cta.kind !== 'mailto') {
        const enc = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeURIComponent(x)])) as CtaVars;
        return fillCta(cta.href ?? '', enc);
    }
    const q: string[] = [];
    if (cta.subject) q.push('subject=' + encodeURIComponent(fillCta(cta.subject, v)));
    if (cta.body) q.push('body=' + encodeURIComponent(fillCta(cta.body, v)));
    const href = cta.href ?? 'mailto:';
    return q.length ? href + (href.includes('?') ? '&' : '?') + q.join('&') : href;
}

/** What the PDF prints next to the primary call to action. */
export function ctaText(cta: Cta): string {
    if (cta.pdfText) return cta.pdfText;
    const h = cta.href ?? '';
    return h.startsWith('mailto:') ? h.slice(7).split('?')[0]
        : h.replace(/^https?:\/\//, '').replace(/[?&][a-z_]+=\{[a-z]+\}/g, '').replace(/\{[a-z]+\}/g, '').replace(/[?&]+(#|$)/, '$1').replace(/\/$/, '');
}

const narrowQ = matchMedia('(max-width: 820px)');
const isImage = (s: string) => /\.(webp|png|jpe?g|avif)(\?|$)/i.test(s) || s.startsWith('data:image');

export class UI {
    zone = 'overview';
    element: string | null = null;
    onPdf: () => void = () => {};
    /** Called when the zone or element changes (the address follows). */
    onNavigate: () => void = () => {};
    /** A look was applied (the embedding page hears about it). */
    onLook: (id: string) => void = () => {};
    /** A call to action was used. */
    onCta: (cta: Cta) => void = () => {};
    /** The configuration code of the current room (null: none yet / not representable). */
    getCode: () => string | null = () => null;
    /** Opens a typed code; resolves false when it is not recognised. */
    onCode: (code: string) => Promise<boolean> = async () => false;
    private els: Element[];
    /** Finish filter chip per "slot:part" for this visit ('all' = grouped view). */
    private chips = new Map<string, string>();
    /** Comparable state of each look, to mark the one the room matches. */
    private lookKeys = new Map<string, string>();
    private spots: Hotspots;
    private roomAnchors = new Map<string, THREE.Vector3 | null>();
    private snap: 'peek' | 'full' = 'peek';
    private shownTotal = -1;
    private totalRaf = 0;
    private lastFocus: HTMLElement | null = null;

    constructor(private cfg: Config, private c: Configurator, private viewer: Viewer, private scene: SceneData) {
        // an element is offered when at least one of its slots exists in this config
        this.els = cfg.elements
            .map((e) => ({ ...e, slots: e.slots.filter((s) => c.hasSlot(s)) }))
            .filter((e) => e.slots.length && (e.zone === 'room' || cfg.zones.some((z) => z.id === e.zone)))
            // rail and Next / Previous follow `order` where set (a buying sequence), else config order
            .map((e, i) => ({ e, k: e.order ?? 1000 + i })).sort((a, b) => a.k - b.k).map((x) => x.e);
        const covered = new Set(this.els.flatMap((e) => e.slots));
        const loose = cfg.slots.filter((s) => !covered.has(s.id)).map((s) => s.id);
        if (loose.length) console.warn('[ui] slots without an element (not reachable):', loose.join(', '));

        this.spots = new Hotspots($('hotspots'), viewer);
        this.buildZones();
        this.buildLooks();
        this.wire();
        this.updateTotal(true);
    }

    get currentView() { return this.zoneOf(this.zone).camera; }

    private zoneOf(id: string): Zone { return this.cfg.zones.find((z) => z.id === id) ?? this.cfg.zones[0]; }
    private elOf(id: string | null) { return id ? this.els.find((e) => e.id === id) : undefined; }
    private zoneEls(id: string) { return this.els.filter((e) => e.zone === id); }
    private roomEls() { return this.els.filter((e) => e.zone === 'room'); }

    // ---------------------------------------------------------------- wiring
    private wire() {
        $('btn-reset').onclick = async () => { await this.c.reset(); this.setZone('overview'); };
        $('btn-share').onclick = () => this.copyLink();
        $('btn-copy').onclick = () => this.copyLink();
        $('btn-total').onclick = () => this.toggleSummary(true);
        $('sum-close').onclick = () => this.toggleSummary(false);
        $('scrim').onclick = () => this.toggleSummary(false);
        $('btn-pdf').onclick = () => this.onPdf();
        $('panel-close').onclick = () => this.leaveElement();
        $('panel-back').onclick = () => this.leaveElement();
        $('panel-prev').onclick = () => this.step(-1);
        $('panel-next').onclick = () => this.step(1);
        addEventListener('resize', () => { this.sizeSheet(); this.fitView(); this.roomAnchors.clear(); if (!this.element) this.renderSpots(); });
        narrowQ.addEventListener('change', () => { this.renderRail(); this.sizeSheet(); this.fitView(); });
        addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!$('summary').hidden) this.toggleSummary(false);
            else if (this.element) this.leaveElement();
        });
        this.wireSheet();
    }

    // ---------------------------------------------------------------- navigation
    /** Start-up: resolves preset / ?view= / ?el= (old names too) into a zone and element. */
    start(r: { view: string | null; el: string | null; zone?: string; element?: string }) {
        let zone = r.zone, element = r.element;
        const alias = (v: string) => this.cfg.viewAliases?.[v] ?? v;
        const byElement = (v: string) => this.els.find((e) => e.id === v || e.camera === v);
        if (r.view) {
            const v = alias(r.view);
            const z = this.cfg.zones.find((z) => z.id === v || z.camera === v);
            if (z) { zone = z.id; element = undefined; }
            else { const e = byElement(v); if (e) { element = e.id; if (e.zone !== 'room') zone = e.zone; } }
        }
        if (r.el) { const e = byElement(alias(r.el)); if (e) { element = e.id; if (e.zone !== 'room') zone = e.zone; } }
        const e = this.elOf(element ?? null);
        if (e && e.zone !== 'room') zone = e.zone;
        this.setZone(zone ?? 'overview', true);
        if (e) this.enterElement(e.id, true);
    }

    setZone(id: string, instant = false) {
        const z = this.zoneOf(id);
        this.zone = z.id;
        this.element = null;
        this.viewer.goTo(z.camera, { instant, zone: true });
        this.closePanel();
        this.render();
    }

    enterElement(id: string, instant = false) {
        const e = this.elOf(id);
        if (!e) return;
        if (e.zone !== 'room') this.zone = e.zone;
        this.element = e.id;
        const zoneCam = this.zoneOf(this.zone).camera;
        const cam = e.camera && this.cfg.cameras[e.camera] ? e.camera : zoneCam;
        // room-wide elements (floor, walls) keep the visitor's current view
        if (cam !== zoneCam || this.viewer.currentPreset !== this.cfg.cameras[zoneCam])
            // an element that borrows another element's close-up (pendants -> benchtop) also borrows its
            // "self" collider, or the island would push the camera off its own preset
            this.viewer.goTo(cam, { instant, focus: this.focusOf(e.id, cam), zone: cam === zoneCam });
        this.openPanel(e);
        this.render();
    }

    /**
     * Colliders the close-up may look through: the element itself, the element whose camera it borrows,
     * and any piece of furniture its orbit centre sits against (the vanity in front of the vanity wall).
     */
    private focusOf(id: string, cam: string): string[] {
        const out = new Set([id, cam]);
        const t = this.cfg.cameras[cam]?.target;
        if (t) {
            const p = v3(t);
            for (const [eid, s] of Object.entries(this.scene.elements ?? {})) {
                if (s.bbox && new THREE.Box3(v3(s.bbox.min), v3(s.bbox.max)).expandByScalar(0.25).containsPoint(p)) out.add(eid);
            }
        }
        return [...out];
    }

    leaveElement() {
        const e = this.elOf(this.element);
        if (!e) return;
        this.element = null;
        const zoneCam = this.zoneOf(this.zone).camera;
        if (this.viewer.currentPreset !== this.cfg.cameras[zoneCam]) this.viewer.goTo(zoneCam, { zone: true });
        this.closePanel();
        this.render();
        // keep keyboard users where they were
        (document.querySelector<HTMLElement>(`#rail [data-el="${e.id}"]`) ?? document.querySelector<HTMLElement>(`#zones [aria-pressed="true"]`))?.focus({ preventScroll: true });
    }

    private render() {
        for (const b of $('zones').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.zone === this.zone));
        $('zones').querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        document.body.dataset.mode = this.element ? 'element' : this.zone === 'overview' ? 'overview' : 'zone';
        $('looks').hidden = !!this.element || this.zone !== 'overview' || !this.lookKeys.size;
        this.renderRail();
        this.renderSpots();
        this.fitView();
        this.onNavigate();
    }

    // ---------------------------------------------------------------- looks (overview)
    private buildLooks() {
        const looks = this.cfg.looks ?? [], row = $('looks-row');
        row.textContent = '';
        this.lookKeys.clear();
        for (const lk of looks) {
            this.lookKeys.set(lk.id, this.c.preview(lk.state, () => this.c.stateKey()));
            const total = this.c.preview(lk.state, () => this.total());
            const b = el('button', 'lk');
            b.dataset.look = lk.id;
            const img = el('span', 'lk-img'), i = el('img');
            i.src = lk.thumb ?? `./thumbs/looks/${lk.id}.jpg`; i.alt = ''; i.decoding = 'async';
            i.onerror = () => { i.remove(); img.classList.add('empty'); };
            img.appendChild(i);
            const txt = el('span', 'lk-txt');
            txt.append(el('span', 'lk-name', lk.label));
            if (lk.line) txt.append(el('span', 'lk-line', lk.line));
            txt.append(el('span', 'lk-price', amount(total, this.cfg.currency)));
            b.append(img, txt);
            b.setAttribute('aria-label', `${lk.label} look${lk.line ? ': ' + lk.line : ''}, ${amount(total, this.cfg.currency)}`);
            b.onclick = () => this.applyLook(lk.id);
            row.appendChild(b);
        }
        this.updateLooks();
    }

    private updateLooks() {
        const key = this.c.stateKey();
        for (const b of $('looks-row').querySelectorAll<HTMLElement>('.lk')) b.setAttribute('aria-pressed', String(this.lookKeys.get(b.dataset.look!) === key));
    }

    /** One tap, the whole room: one load, one swap. The zone stays (the overview stays on the hero). */
    async applyLook(id: string) {
        const lk = this.cfg.looks?.find((l) => l.id === id), row = $('looks-row');
        if (!lk || row.classList.contains('busy')) return;
        row.classList.add('busy');
        try { await this.c.applyState(lk.state); } finally { row.classList.remove('busy'); }
        this.onLook(lk.id);
    }

    // ---------------------------------------------------------------- zones (top bar)
    private buildZones() {
        const nav = $('zones');
        nav.textContent = '';
        for (const z of this.cfg.zones) {
            const b = el('button', '', z.label);
            b.dataset.zone = z.id;
            b.onclick = () => { if (this.zone !== z.id || this.element) this.setZone(z.id); };
            nav.appendChild(b);
        }
    }

    // ---------------------------------------------------------------- hotspots
    private renderSpots() {
        if (this.element) { this.spots.show(false); return; }
        const spots: Spot[] = [];
        if (this.zone === 'overview') {
            for (const z of this.cfg.zones) {
                if (z.id === 'overview') continue;
                const p = this.zoneAnchor(z);
                if (p) spots.push({ id: z.id, label: z.label, kind: 'zone', point: p, aria: `Go to ${z.label}`, onClick: () => this.setZone(z.id) });
            }
        } else {
            for (const e of this.zoneEls(this.zone)) {
                const p = this.anchorOf(e);
                if (p) spots.push({ id: e.id, label: e.label, kind: 'element', point: p, ignore: [e.id], aria: `Change ${e.label}`, onClick: () => this.enterElement(e.id) });
            }
        }
        for (const e of this.roomEls()) {
            const p = this.roomAnchor(e, this.zone);
            if (p) spots.push({ id: e.id, label: e.label, kind: 'room', point: p, aria: `Change ${e.label}`, onClick: () => this.enterElement(e.id) });
        }
        this.spots.set(spots);
        this.spots.show(true);
    }

    /** Hotspot point of an element: config > position of anchored models (taps) > scene.json > camera target. */
    private anchorOf(e: Element): THREE.Vector3 | null {
        if (e.anchor) return v3(e.anchor);
        const s = this.scene.elements?.[e.id];
        const pts = this.c.anchorPoints(e.slots[0]);
        if (pts.length) {
            const h = s?.bbox ? (s.bbox.max[1] - s.bbox.min[1]) * 0.7 : 0.35;
            const m = new THREE.Vector3();
            for (const p of pts) m.add(v3(p));
            return m.divideScalar(pts.length).add(new THREE.Vector3(0, h, 0));
        }
        if (s?.anchor) return v3(s.anchor);
        if (s?.bbox) return v3(s.bbox.min).add(v3(s.bbox.max)).multiplyScalar(0.5);
        const cam = e.camera ? this.cfg.cameras[e.camera] : undefined;
        return cam ? v3(cam.target) : null;
    }

    private zoneAnchor(z: Zone): THREE.Vector3 | null {
        if (z.anchor) return v3(z.anchor);
        const pts = this.zoneEls(z.id).map((e) => this.anchorOf(e)).filter(Boolean) as THREE.Vector3[];
        if (!pts.length) return this.cfg.cameras[z.camera] ? v3(this.cfg.cameras[z.camera].target) : null;
        return pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    }

    /**
     * Floor / walls are offered in every zone, so their hotspot moves to a point the zone camera sees:
     * the floor a little in front of the camera, or the first plain wall beside the view direction.
     */
    private roomAnchor(e: Element, zoneId: string): THREE.Vector3 | null {
        const key = e.id + '|' + zoneId;
        if (this.roomAnchors.has(key)) return this.roomAnchors.get(key)!;
        const found = this.findRoomAnchor(e, zoneId);
        this.roomAnchors.set(key, found);
        return found;
    }

    private findRoomAnchor(e: Element, zoneId: string): THREE.Vector3 | null {
        if (e.anchorByZone?.[zoneId]) return v3(e.anchorByZone[zoneId]);
        const fallback = this.scene.elements?.[e.id]?.anchor ? v3(this.scene.elements[e.id].anchor!) : e.anchor ? v3(e.anchor) : null;
        const zc = this.zoneOf(zoneId).camera, cam = this.cfg.cameras[zc], view = this.viewer.presetCamera(zc);
        if (!cam || !view) return fallback;
        const P = v3(cam.position);
        const cols = this.viewer.colliders, room = this.viewer.room;
        // well inside the frame (NDC), clear of the corners where the UI sits
        const framed = (p: THREE.Vector3, yMin: number, yMax: number) => {
            const n = p.clone().project(view);
            return n.z < 1 && Math.abs(n.x) < 0.62 && n.y > yMin && n.y < yMax;
        };
        const otherSurface = (p: THREE.Vector3) => Object.entries(this.scene.elements ?? {}).some(([id, s]) =>
            id !== e.id && id !== 'floor' && id !== 'walls' && s.bbox && new THREE.Box3(v3(s.bbox.min), v3(s.bbox.max)).expandByScalar(0.12).containsPoint(p));
        const bbox = this.scene.elements?.[e.id]?.bbox;
        const isFloor = e.id === 'floor' || (bbox ? bbox.max[1] - bbox.min[1] < 0.3 : false);
        const dirs: THREE.Vector3[] = [];
        for (const nx of [0, -0.3, 0.3, -0.5, 0.5]) for (const ny of isFloor ? [-0.55, -0.4, -0.7, -0.25] : [0.25, 0.1, 0.4]) {
            dirs.push(new THREE.Vector3(nx, ny, 0.5).unproject(view).sub(P).normalize());
        }
        const windows = (this.scene.windows ?? []).map((w) => new THREE.Box3(v3(w.min), v3(w.max)).expandByScalar(0.25));
        for (const d of dirs) {
            // first surface along a view ray
            let best = Infinity, kind = '';
            const ex = room.containsPoint(P) ? rayBox(P, d, room) : null;
            if (ex) { best = ex[1]; kind = d.y < 0 && P.y + d.y * ex[1] <= room.min.y + 0.01 ? 'floor' : 'wall'; }
            for (const c of cols) {
                if (c.raw.containsPoint(P)) continue;
                const h = rayBox(P, d, c.raw);
                if (h && h[0] > 0.05 && h[0] < best) { best = h[0]; kind = c.kind; }
            }
            if (best === Infinity || best < 1.0 || kind !== (isFloor ? 'floor' : 'wall')) continue;
            const p = P.clone().addScaledVector(d, best - 0.03);
            if (isFloor) p.y = Math.max(p.y, room.min.y + 0.02);
            if (windows.some((w) => w.containsPoint(p)) || otherSurface(p)) continue;
            if (!framed(p, -0.85, 0.75) || occluded(cols, P, p)) continue;
            return p;
        }

        return fallback;
    }

    // ---------------------------------------------------------------- rail
    private renderRail() {
        const rail = $('rail');
        rail.textContent = '';
        const e = this.elOf(this.element);
        rail.classList.toggle('compact', !!e);
        if (e) {
            const back = el('button', 'r-back');
            back.append(el('span', 'r-chev', '‹'), el('span', '', this.zoneOf(this.zone).label));
            back.setAttribute('aria-label', `Back to ${this.zoneOf(this.zone).label}`);
            back.onclick = () => this.leaveElement();
            const cur = el('div', 'r-current');
            cur.append(el('span', 'r-eyebrow', 'Selected'), el('span', 'r-name', e.label));
            rail.append(back, cur);
            return;
        }
        if (this.zone === 'overview') {
            rail.appendChild(el('h3', '', 'Areas'));
            for (const z of this.cfg.zones) {
                if (z.id === 'overview') continue;
                const items = this.zoneEls(z.id);
                if (!items.length) continue;
                rail.appendChild(this.railButton(z.label, items.map((i) => i.label).join(', '), () => this.setZone(z.id), { zone: z.id }));
            }
        } else {
            rail.appendChild(el('h3', '', this.zoneOf(this.zone).label));
            for (const i of this.zoneEls(this.zone)) rail.appendChild(this.railButton(i.label, this.valueText(i), () => this.enterElement(i.id), { el: i.id }));
        }
        const room = this.roomEls();
        if (room.length) {
            rail.appendChild(el('h3', '', 'Room'));
            for (const i of room) rail.appendChild(this.railButton(i.label, this.valueText(i), () => this.enterElement(i.id), { el: i.id }));
        }
    }

    private railButton(name: string, value: string, onClick: () => void, data: Record<string, string>) {
        const b = el('button');
        Object.assign(b.dataset, data);
        b.append(el('span', 's-name', name), el('span', 's-val', value));
        b.onclick = onClick;
        return b;
    }

    private slotText(slot: Slot) {
        const st = this.c.state[slot.id];
        const fin = this.c.parts(slot).filter((p) => p.finishes.length > 1).map((p) => this.c.finish(st.finishes[p.id]).label);
        const opt = slot.kind === 'model' ? this.c.option(slot) : undefined;
        return [opt?.label, ...fin].filter(Boolean).join(' · ');
    }

    private valueText(e: Element) { return e.slots.map((s) => this.slotText(this.c.slot(s))).filter(Boolean).join(' · '); }

    private elementPrice(e: Element) {
        return this.c.summary().filter((l) => e.slots.includes(l.slot)).reduce((a, l) => a + l.price, 0);
    }

    // ---------------------------------------------------------------- options panel
    private openPanel(e: Element) {
        const panel = $('panel');
        const zl = e.zone === 'room' ? this.zoneOf(this.zone).label : this.zoneOf(e.zone).label;
        $('panel-eyebrow').textContent = e.zone === 'room' ? 'Room' : zl;
        $('panel-title').textContent = e.label;
        $('panel-back').textContent = '‹ ' + zl;
        $('panel-back').setAttribute('aria-label', `Back to ${zl}`);
        const body = $('panel-body');
        body.textContent = '';
        body.scrollTop = 0;
        for (const id of e.slots) body.appendChild(this.slotSection(this.c.slot(id), e.slots.length > 1));
        this.updateFoot(e);
        this.updatePanel();
        if (!panel.classList.contains('open')) this.snap = 'peek';
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        panel.dataset.snap = this.snap;
        this.sizeSheet();
    }

    /** The elements Next / Previous walk through: the zone's, in rail order, then the room-wide ones. */
    private walk(): Element[] { return [...this.zoneEls(this.zone), ...this.roomEls()]; }

    private updateFoot(e: Element) {
        const list = this.walk(), i = list.findIndex((x) => x.id === e.id);
        const prev = i > 0 ? list[i - 1] : undefined, next = i >= 0 ? list[i + 1] : undefined;
        const p = $('panel-prev'), n = $('panel-next');
        p.hidden = !prev;
        p.textContent = '‹ Previous';
        p.setAttribute('aria-label', prev ? `Previous: ${prev.label}` : 'Previous');
        n.textContent = next ? `Next: ${next.label} ›` : 'See summary ›';
        n.setAttribute('aria-label', next ? `Next: ${next.label}` : 'See summary');
    }

    /** Next / Previous element of the walk; past the last one, the summary. Flies like a hotspot tap. */
    private step(d: 1 | -1) {
        const list = this.walk(), i = list.findIndex((x) => x.id === this.element);
        const to = list[i + d];
        if (to) this.enterElement(to.id);
        else if (d > 0) this.toggleSummary(true);
    }

    private closePanel() {
        const panel = $('panel');
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
    }

    private slotSection(slot: Slot, titled: boolean) {
        const sec = el('section', 'p-slot');
        sec.dataset.slot = slot.id;
        if (titled) sec.appendChild(el('h3', 'p-slot-title', slot.label));
        if (slot.kind === 'model' && slot.options!.length > 1) {
            const g = el('div', 'p-group');
            const head = el('div', 'p-ghead');
            head.append(el('span', 'p-label', 'Model'), el('span', 'p-cur'));
            const grid = el('div', 'cards');
            for (const o of slot.options!) {
                const b = el('button', 'card');
                b.dataset.opt = o.id;
                const img = el('span', 'c-img');
                if (o.thumb) { const i = el('img'); i.src = o.thumb; i.alt = ''; i.loading = 'lazy'; i.decoding = 'async'; img.appendChild(i); }
                else img.appendChild(el('span', o.none ? 'c-ph none' : 'c-ph', o.none ? '' : o.label.split(/\s+/).map((w) => w[0]).join('').slice(0, 2)));
                const txt = el('span', 'c-txt');
                if (o.badge) txt.append(el('span', 'badge', o.badge));
                txt.append(el('span', 'c-name', o.label), el('span', 'c-price', o.none ? 'None' : o.price ? amount(o.price, this.cfg.currency) : 'Included'));
                b.append(img, txt);
                b.dataset.aria = `${o.name}${o.price ? ', ' + amount(o.price, this.cfg.currency) : ''}${o.badge ? ', ' + o.badge : ''}`;
                b.setAttribute('aria-label', b.dataset.aria);
                b.onclick = () => this.c.setOption(slot.id, o.id);
                grid.appendChild(b);
            }
            g.append(head, grid);
            sec.appendChild(g);
        }
        const parts = el('div', 'p-parts');
        sec.appendChild(parts);
        this.fillParts(slot, parts);
        return sec;
    }

    private fillParts(slot: Slot, box: HTMLElement) {
        box.textContent = '';
        const sec = box.parentElement as HTMLElement | null;
        if (sec) sec.dataset.opt = this.c.state[slot.id].option ?? '';
        for (const part of this.c.parts(slot)) {
            if (part.finishes.length < 2) continue;
            const g = el('div', 'p-group');
            g.dataset.part = part.id;
            const head = el('div', 'p-ghead');
            head.append(el('span', 'p-label', part.label), el('span', 'p-cur'));
            g.append(head);
            const cur = this.c.state[slot.id].finishes[part.id];
            let list = part.finishes;
            // blinds and curtains: Blackout / Sheer first, then the fabrics of that kind
            const sheers = list.filter((id) => this.c.sheer(id));
            if (sheers.length && sheers.length < list.length) {
                const mode = this.c.sheer(cur) ? 'sheer' : 'blackout';
                g.dataset.mode = mode;
                list = mode === 'sheer' ? sheers : list.filter((id) => !this.c.sheer(id));
                const seg = el('div', 'seg');
                seg.setAttribute('role', 'group');
                seg.setAttribute('aria-label', 'Fabric type');
                for (const [m, label] of [['blackout', 'Blackout'], ['sheer', 'Sheer']]) {
                    const b = el('button', 'seg-b', label);
                    b.setAttribute('aria-pressed', String(m === mode));
                    b.onclick = () => {
                        if (m === mode) return;
                        // the part's default if it is of that kind, else its first curated fabric of that kind
                        const pool = part.finishes.filter((id) => this.c.sheer(id) === (m === 'sheer'));
                        const pick = part.default && pool.includes(part.default) ? part.default
                            : (part.curated ?? []).find((id) => pool.includes(id)) ?? pool[0];
                        this.c.setFinish(slot.id, part.id, pick);
                    };
                    seg.appendChild(b);
                }
                g.append(seg);
            }
            // grouped by category; long lists fold into one section per category (the current one open)
            const groups = new Map<string, string[]>();
            for (const id of list) {
                const c = this.c.category(id);
                if (!groups.has(c)) groups.set(c, []);
                groups.get(c)!.push(id);
            }
            const many = list.length > 12, titled = groups.size > 1;
            const catName = (cat: string) => this.cfg.catalogue?.categoryLabels?.[cat] ?? CATEGORY_LABELS[cat] ?? cat;
            // more than one category: filter chips (All = the grouped view); the choice is kept per part for this visit
            const chipKey = slot.id + ':' + part.id;
            let chip = this.chips.get(chipKey) ?? 'all';
            if (!groups.has(chip)) chip = 'all';
            if (titled) {
                const row = el('div', 'chips');
                row.setAttribute('role', 'group');
                row.setAttribute('aria-label', `Filter ${part.label.toLowerCase()} by material`);
                for (const [key, label] of [['all', 'All'], ...[...groups.keys()].map((c) => [c, catName(c)])]) {
                    const b = el('button', 'chip', label);
                    b.dataset.chip = key;
                    b.setAttribute('aria-pressed', String(key === chip));
                    b.onclick = () => {
                        if (key === chip) return;
                        this.chips.set(chipKey, key);
                        const body = $('panel-body'), top = body.scrollTop;
                        this.fillParts(slot, box);
                        this.updatePanel();
                        body.scrollTop = top;
                        box.querySelector<HTMLElement>(`.p-group[data-part="${part.id}"] .chip[data-chip="${key}"]`)?.focus({ preventScroll: true });
                    };
                    row.appendChild(b);
                }
                g.append(row);
            }
            for (const [cat, ids] of groups) {
                if (chip !== 'all' && cat !== chip) continue;
                const grid = el('div', ids.length > 12 || (many && chip === 'all') ? 'swatches compact' : 'swatches');
                for (const id of ids) grid.appendChild(this.swatch(slot, part, id));
                const name = catName(cat);
                if (chip !== 'all') g.append(grid);
                else if (many && titled) {
                    const d = el('details', 'sw-cat') as HTMLDetailsElement;
                    d.open = ids.includes(cur);
                    const sum = el('summary', 'sw-cat-h');
                    sum.append(el('span', '', name), el('span', 'sw-cat-n', String(ids.length)));
                    d.append(sum, grid);
                    g.append(d);
                } else {
                    if (titled) g.append(el('div', 'sw-cat-h', name));
                    g.append(grid);
                }
            }
            box.appendChild(g);
        }
        const hasModels = slot.kind === 'model' && slot.options!.length > 1;
        if (!box.childElementCount && !hasModels) box.appendChild(el('p', 'p-empty', 'No alternatives for this item yet.'));
    }

    private swatch(slot: Slot, part: Part, id: string) {
        const f = this.c.finish(id);
        const b = el('button', 'sw');
        b.dataset.fin = id;
        const img = el('span', this.c.sheer(id) ? 'sw-img sheer' : 'sw-img');
        this.paintSwatch(img, f);
        b.append(img, el('span', 'sw-name', f.label));
        if (f.price) b.append(el('span', 'sw-price', '+' + amount(f.price, this.cfg.currency)));
        if (f.badge) b.append(el('span', 'badge', f.badge));
        b.setAttribute('aria-label', (f.price ? `${f.label}, plus ${amount(f.price, this.cfg.currency)}` : f.label) + (f.badge ? `, ${f.badge}` : ''));
        b.onclick = () => this.c.setFinish(slot.id, part.id, id);
        // start the texture download on hover / touch, so the swap is instant on click
        b.onpointerenter = b.onpointerdown = b.onfocus = () => this.c.prefetch(id);
        return b;
    }

    /** Swatch: an image (`finish.swatch` path, later the PBR swatch.webp), the tiling map, or a colour. */
    private paintSwatch(node: HTMLElement, f: Finish) {
        const s = swatchOf(f);
        // the set's average colour under the image: right while it loads, or if a new set has no swatch yet
        const set = pbrSet(f.pbr);
        if (set) node.style.backgroundColor = set.color;
        // tinted / brightened PBR sets: the chip shows what the room will show
        if (f.tint && (f.pbr || f.map)) { node.style.backgroundColor = f.tint; node.style.backgroundBlendMode = 'multiply'; }
        if (f.gain && f.gain !== 1 && (f.pbr || f.map)) node.style.filter = `brightness(${f.gain})`;
        if (f.pbr && f.color) {
            // recoloured set: the colour, with the texture's relief laid over it
            node.style.backgroundColor = f.color; node.style.backgroundBlendMode = 'soft-light';
        }
        if (s && isImage(s)) node.style.backgroundImage = `url("${s}")`;
        else if (s) node.style.background = s;
        else if (f.map) node.style.backgroundImage = `url("${f.map}")`;
        else node.style.background = f.color ?? '#d8d4cc';
    }

    /** In-place update after a change: pressed states, current names, prices. Scroll position stays. */
    private updatePanel() {
        const e = this.elOf(this.element);
        if (!e) return;
        const body = $('panel-body'), top = body.scrollTop;
        for (const sec of body.querySelectorAll<HTMLElement>('.p-slot')) {
            const slot = this.c.slot(sec.dataset.slot!), st = this.c.state[slot.id];
            // a new model, or a fabric changing between blackout and sheer, rebuilds the finish lists
            const modeChanged = [...sec.querySelectorAll<HTMLElement>('.p-parts .p-group[data-mode]')].some((g) =>
                g.dataset.mode !== (this.c.sheer(st.finishes[g.dataset.part!]) ? 'sheer' : 'blackout'));
            if ((slot.kind === 'model' && sec.dataset.opt !== st.option) || modeChanged) this.fillParts(slot, sec.querySelector('.p-parts')!);
            const opt = this.c.option(slot);
            for (const b of sec.querySelectorAll<HTMLButtonElement>('.card')) {
                b.setAttribute('aria-pressed', String(b.dataset.opt === st.option));
                // taps the current vanity / sink does not take: shown greyed out, with the reason
                const ok = this.c.allowed(slot.id, b.dataset.opt);
                b.disabled = !ok;
                b.classList.toggle('unfit', !ok);
                let why = b.querySelector('.c-why');
                if (ok) { why?.remove(); b.setAttribute('aria-label', b.dataset.aria ?? ''); continue; }
                const text = this.c.reason(slot.id, b.dataset.opt!);
                if (!why) { why = el('span', 'c-why'); b.querySelector('.c-txt')!.appendChild(why); }
                why.textContent = text;
                b.setAttribute('aria-label', `${b.dataset.aria ?? ''}. Not available: ${text}`);
            }
            const mc = sec.querySelector(':scope > .p-group .p-cur');
            if (mc) mc.textContent = opt?.label ?? '';
            for (const g of sec.querySelectorAll<HTMLElement>('.p-parts .p-group')) {
                const cur = st.finishes[g.dataset.part!];
                for (const b of g.querySelectorAll<HTMLElement>('.sw')) b.setAttribute('aria-pressed', String(b.dataset.fin === cur));
                g.querySelector('.p-cur')!.textContent = this.c.finish(cur).label;
            }
        }
        const line = e.slots.map((s) => {
            const slot = this.c.slot(s), opt = slot.kind === 'model' ? this.c.option(slot) : undefined;
            return opt ? (opt.none ? opt.label : opt.name) : '';
        }).filter(Boolean).join(' · ');
        const price = this.elementPrice(e);
        $('panel-line').textContent = [line, price ? amount(price, this.cfg.currency) : ''].filter(Boolean).join('  ·  ');
        body.scrollTop = top;
    }

    // ---------------------------------------------------------------- bottom sheet (phones)
    private sheetHeights() {
        const h = innerHeight;
        return { peek: Math.round(Math.max(200, h * 0.32)), full: Math.round(h * 0.6) };
    }

    private sizeSheet() {
        const panel = $('panel');
        if (!narrowQ.matches) { panel.style.height = ''; return; }
        const hs = this.sheetHeights();
        panel.style.height = (this.snap === 'full' ? hs.full : hs.peek) + 'px';
        panel.dataset.snap = this.snap;
    }

    private setSnap(s: 'peek' | 'full') {
        this.snap = s;
        this.sizeSheet();
        this.fitView();
    }

    private wireSheet() {
        const panel = $('panel'), grip = $('panel-grip'), head = $('panel-head');
        let y0 = 0, h0 = 0, moved = false, id = -1;
        const down = (e: PointerEvent) => {
            if (!narrowQ.matches || (e.target as HTMLElement).closest('button')) return;
            id = e.pointerId; y0 = e.clientY; h0 = panel.getBoundingClientRect().height; moved = false;
            (e.currentTarget as HTMLElement).setPointerCapture(id);
            panel.classList.add('dragging');
        };
        const move = (e: PointerEvent) => {
            if (e.pointerId !== id) return;
            const dy = e.clientY - y0;
            if (Math.abs(dy) > 4) moved = true;
            const hs = this.sheetHeights();
            panel.style.height = Math.round(THREE.MathUtils.clamp(h0 - dy, 90, hs.full)) + 'px';
        };
        const up = (e: PointerEvent) => {
            if (e.pointerId !== id) return;
            id = -1;
            panel.classList.remove('dragging');
            const hs = this.sheetHeights(), h = panel.getBoundingClientRect().height;
            if (!moved) { this.setSnap(this.snap === 'full' ? 'peek' : 'full'); return; }
            if (h < hs.peek * 0.7) { this.sizeSheet(); this.leaveElement(); return; }
            this.setSnap(h > (hs.peek + hs.full) / 2 ? 'full' : 'peek');
        };
        for (const t of [grip, head]) {
            t.addEventListener('pointerdown', down);
            t.addEventListener('pointermove', move);
            t.addEventListener('pointerup', up);
            t.addEventListener('pointercancel', up);
        }
    }

    /** Keeps the subject in the part of the screen that the rail and panel leave free. */
    private fitView() {
        const looks = $('looks'), lh = looks.hidden ? 0 : looks.offsetHeight;
        // phones: the looks row sits just above the chip row
        looks.style.bottom = narrowQ.matches ? $('rail').offsetHeight + 'px' : '';
        if (narrowQ.matches) {
            const hs = this.sheetHeights();
            const rail = $('rail');
            const bottom = this.element ? (this.snap === 'full' ? hs.full : hs.peek) : rail.offsetHeight + lh;
            this.viewer.setInsets({ left: 0, right: 0, bottom });
        } else {
            const rail = $('rail'), panel = $('panel');
            const left = this.element ? 0 : rail.offsetLeft + rail.offsetWidth;
            const right = this.element ? panel.offsetWidth + 16 : 0;
            this.viewer.setInsets({ left, right, bottom: lh ? lh + 16 : 0 });
        }
    }

    // ---------------------------------------------------------------- changes
    /** Called after every configuration change. */
    refresh() {
        for (const b of $('rail').querySelectorAll<HTMLElement>('button[data-el]')) {
            const e = this.elOf(b.dataset.el!);
            if (e) b.querySelector('.s-val')!.textContent = this.valueText(e);
        }
        this.updatePanel();
        this.updateTotal();
        this.updateLooks();
        if (!$('summary').hidden) this.buildSummary();
        // taps follow the sink / vanity: their hotspots move too
        if (!this.element) this.renderSpots();
    }

    private total() { return this.c.summary().reduce((a, l) => a + l.price, 0); }

    /** The always-visible total; the number rolls to its new value. */
    private updateTotal(instant = false) {
        const to = this.total(), from = this.shownTotal < 0 ? to : this.shownTotal;
        const out = $('total-value'), btn = $('btn-total');
        btn.setAttribute('aria-label', `Indicative total ${amount(to, this.cfg.currency)}. Open the summary`);
        cancelAnimationFrame(this.totalRaf);
        if (instant || from === to) { this.shownTotal = to; out.textContent = amount(to, this.cfg.currency); return; }
        btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
        const t0 = performance.now(), dur = 420;
        const step = (now: number) => {
            const k = Math.min(1, Math.max(0, (now - t0) / dur)), e = 1 - Math.pow(1 - k, 3);
            this.shownTotal = from + (to - from) * e;
            out.textContent = amount(this.shownTotal, this.cfg.currency);
            if (k < 1) this.totalRaf = requestAnimationFrame(step); else this.shownTotal = to;
        };
        this.totalRaf = requestAnimationFrame(step);
    }

    // ---------------------------------------------------------------- summary
    toggleSummary(open: boolean) {
        const s = $('summary'), scrim = $('scrim');
        if (open === !s.hidden) return;
        if (open) {
            this.lastFocus = document.activeElement as HTMLElement;
            this.buildSummary();
            s.hidden = scrim.hidden = false;
            requestAnimationFrame(() => { s.classList.add('open'); scrim.classList.add('open'); });
            $('sum-close').focus({ preventScroll: true });
        } else {
            s.classList.remove('open'); scrim.classList.remove('open');
            setTimeout(() => { if (!s.classList.contains('open')) s.hidden = scrim.hidden = true; }, 240);
            this.lastFocus?.focus({ preventScroll: true });
        }
    }

    private buildSummary() {
        const body = $('sum-body');
        const top = body.scrollTop;
        body.textContent = '';
        let group = '', total = 0;
        for (const l of this.c.summary()) {
            if (l.group !== group) { group = l.group; body.appendChild(el('div', 'sum-group', group)); }
            const row = el('div', 'sum-line'), n = el('div', 'n');
            n.append(el('b', '', l.name));
            if (l.finishes.length) n.append(el('span', '', ', ' + l.finishes.join(', ')));
            row.append(n, el('div', 'p', l.price ? amount(l.price, this.cfg.currency) : '–'));
            body.appendChild(row);
            total += l.price;
        }
        const t = el('div', 'sum-total');
        t.append(el('span', '', 'Indicative total'), el('span', 'p', amount(total, this.cfg.currency)));
        const again = el('button', 'sum-reset', 'Start over');
        again.onclick = async () => { this.toggleSummary(false); await this.c.reset(); this.setZone('overview'); };
        body.append(t, this.codeBlock(), el('div', 'sum-note', 'Prices are placeholders that show how pricing can appear. The PDF includes a link and QR code that reopen exactly this configuration.'), again);
        body.scrollTop = top;
        this.buildCta();
    }

    /** The configuration code ("Quote this code in store") and a field to open one. */
    private codeBlock() {
        const box = el('div', 'sum-code'), code = this.getCode();
        if (code) {
            const row = el('div', 'sc-row');
            const b = el('button', 'sc-copy', 'Copy');
            b.setAttribute('aria-label', `Copy code ${code}`);
            b.onclick = async () => { try { await navigator.clipboard.writeText(code); this.toast('Code copied'); } catch { prompt('Your code', code); } };
            row.append(el('span', 'sc-label', 'Your code'), el('span', 'sc-code', code), b);
            box.append(row, el('div', 'sc-hint', 'Quote this code in store, or type it in here later to reopen this room.'));
        }
        const form = el('form', 'sc-form') as HTMLFormElement;
        const input = el('input') as HTMLInputElement;
        input.placeholder = 'Enter a code, e.g. GF1-…'; input.autocomplete = 'off'; input.spellcheck = false;
        input.setAttribute('aria-label', 'Configuration code');
        const go = el('button', 'sc-go', 'Open');
        go.type = 'submit';
        form.append(input, go);
        form.onsubmit = async (e) => {
            e.preventDefault();
            const v = input.value.trim();
            if (!v) return;
            if (await this.onCode(v)) this.toast('Configuration opened');
            else { this.toast('That code was not recognised'); input.focus(); }
        };
        box.append(form);
        return box;
    }

    /** Calls to action (config.cta): the primary one full width above Download PDF, the others below. */
    private buildCta() {
        const list = this.cfg.cta ?? [], primary = list.find((x) => x.primary);
        const a = $('sum-cta'), b = $('sum-cta2');
        a.textContent = b.textContent = '';
        $('btn-pdf').classList.toggle('primary', !primary);
        const vars = ctaVars(this.c.shareUrl(this.currentView, this.element), this.c.summary(), this.cfg.currency, this.getCode());
        for (const cta of list) {
            const cls = cta === primary ? 'cta primary' : 'cta';
            let node: HTMLElement;
            if (cta.kind === 'event' || !cta.href) {
                node = el('button', cls, cta.label);
            } else {
                const link = el('a', cls, cta.label);
                link.href = ctaHref(cta, vars);
                if (cta.kind === 'url') { link.target = '_blank'; link.rel = 'noopener'; }
                node = link;
            }
            node.dataset.cta = cta.id;
            node.addEventListener('click', () => {
                // a form that cannot be prefilled yet: the visitor pastes the configuration into the message
                if (cta.copy) navigator.clipboard?.writeText(vars.summary).then(() => this.toast('Configuration copied: paste it into the message'), () => {});
                this.onCta(cta);
            });
            (cta === primary ? a : b).appendChild(node);
        }
    }

    // ---------------------------------------------------------------- misc
    async copyLink() {
        const url = this.c.shareUrl(this.currentView, this.element);
        try { await navigator.clipboard.writeText(url); this.toast('Link copied'); }
        catch { prompt('Copy this link', url); }
    }

    toast(msg: string) {
        const t = $('toast');
        t.textContent = msg; t.hidden = false;
        clearTimeout((t as any)._h);
        (t as any)._h = setTimeout(() => (t.hidden = true), 2200);
    }
}
