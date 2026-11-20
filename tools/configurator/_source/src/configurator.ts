// Slot logic: which model sits in each slot, which finish is on each part, loading models on
// demand, and turning the whole configuration into (and back from) a shareable address.

import * as THREE from 'three';
import type { Config, Finish, Option, Part, Slot, SummaryLine } from './types';
import { Viewer, contactShadow } from './viewer';
import { applyFinish, boxProject, ensureFinish, isSharedTexture, manifestSets, matKey, originalTextures, pbrSet, prefetchFinish, releaseUnused, uvDensity } from './finishes';
import { categoryOf, clothMaterials, expandCatalogue, isSheer } from './catalogue';
import type { CodeVersion } from './code';

interface SlotState { option?: string; finishes: Record<string, string> }
/** UV channel of the exported CFG_Finish layer (node extra gf_cfg_finish_uv), 0 when the mesh has none. */
function finishUv(m: THREE.Mesh): number {
    const ch = Number(m.userData?.gf_cfg_finish_uv ?? 0);
    return ch > 0 && m.geometry.getAttribute(ch === 1 ? 'uv1' : 'uv' + ch) ? ch : 0;
}

type MatIndex = Map<string, { mat: THREE.MeshStandardMaterial; meshes: THREE.Mesh[] }[]>;
interface Loaded { root: THREE.Object3D; index: MatIndex }

function indexMaterials(root: THREE.Object3D): MatIndex {
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || m.name === 'cfg_contact_shadow') return;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            if (!byMat.has(mat)) byMat.set(mat, []);
            byMat.get(mat)!.push(m);
        }
    });
    const index: MatIndex = new Map();
    for (const [mat, meshes] of byMat) {
        const k = matKey(mat.name);
        if (!index.has(k)) index.set(k, []);
        index.get(k)!.push({ mat: mat as THREE.MeshStandardMaterial, meshes });
    }
    return index;
}

export class Configurator {
    state: Record<string, SlotState> = {};
    private base!: Loaded;
    private loaded = new Map<string, Loaded>();          // "slot:option" -> model
    private loading = new Map<string, Promise<Loaded | null>>();
    private anchored = new Map<string, THREE.Group>();   // slot id -> placed copies
    private busy = 0;
    onChange: (slot: string) => void = () => {};
    onBusy: (busy: boolean) => void = () => {};

    constructor(public cfg: Config, private viewer: Viewer) {}

    slot(id: string) { return this.cfg.slots.find((s) => s.id === id)!; }
    option(slot: Slot, id = this.state[slot.id]?.option) { return slot.options?.find((o) => o.id === id); }
    parts(slot: Slot): Part[] { return slot.kind === 'surface' ? slot.parts ?? [] : this.option(slot)?.parts ?? []; }
    finish(id: string): Finish { return this.cfg.finishes[id] ?? { label: id }; }
    /** Menu group of a finish (manifest category, or paint / lacquer / glass). */
    category(id: string) { return categoryOf(this.finish(id), manifestSets()); }
    /** See-through (sheer) fabric. */
    sheer(id: string) { return isSheer(this.finish(id), manifestSets()); }
    hasSlot(id: string) { return this.cfg.slots.some((s) => s.id === id); }

    /** Where the models of an anchored slot (taps) currently sit: [x, y, z, rotY][]. */
    anchorPoints(slotId: string): number[][] {
        const slot = this.cfg.slots.find((s) => s.id === slotId);
        if (!slot?.anchorSlot) return [];
        return this.anchorsFor(slot, this.state[slot.id]?.option);
    }

    /** Tap rule of the host's current option (scene.json tapRules), if any. */
    private rule(slot: Slot) {
        if (!slot.anchorSlot) return undefined;
        return this.cfg.tapRules?.[slot.anchorSlot]?.[this.state[slot.anchorSlot]?.option ?? ''];
    }

    /** Anchored slots (taps): only options the host's current option allows (no clipping, reachable). */
    allowed(slotId: string, optionId?: string): boolean {
        const slot = this.slot(slotId), r = this.rule(slot);
        return !r || !optionId || r.allowed.includes(optionId);
    }

    /** Why an option the host does not allow is unavailable (config ruleReasons, else a generic line). */
    reason(slotId: string, optionId: string): string {
        const slot = this.slot(slotId), hostSlot = slot.anchorSlot;
        if (!hostSlot) return '';
        const hostOpt = this.state[hostSlot]?.option ?? '';
        const r = this.cfg.ruleReasons?.[hostSlot]?.[hostOpt];
        const text = typeof r === 'string' ? r : r?.[optionId] ?? r?.['*'];
        return text ?? `Doesn't fit the ${this.option(this.slot(hostSlot))?.label.toLowerCase() ?? hostSlot}`;
    }

    /** Anchors for an option of an anchored slot: by its mount (deck / wall / side) on the host's current option. */
    private anchorsFor(slot: Slot, optionId?: string): number[][] {
        const host = this.option(this.slot(slot.anchorSlot!));
        const mount = (optionId && this.rule(slot)?.mount?.[optionId]) || 'deck';
        if (host?.mounts) return host.mounts[mount] ?? [];
        return host?.anchors?.[slot.anchorKey ?? slot.id] ?? [];
    }

    /** Anchored slots whose option the host no longer allows switch to the rule's default. Returns the changed slots. */
    private enforceRules(): Slot[] {
        const changed: Slot[] = [];
        for (const slot of this.cfg.slots) {
            const r = this.rule(slot), st = this.state[slot.id];
            if (!r || !st.option || r.allowed.includes(st.option)) continue;
            const next = r.default && r.allowed.includes(r.default) ? r.default : r.allowed.find((id) => slot.options!.some((o) => o.id === id));
            if (!next) continue;
            st.option = next;
            this.fillFinishes(slot);
            changed.push(slot);
        }
        return changed;
    }

    // ---------------------------------------------------------------- state
    private defaults(): Record<string, SlotState> {
        const s: Record<string, SlotState> = {};
        for (const slot of this.cfg.slots) {
            const st: SlotState = { finishes: {} };
            if (slot.kind === 'model') st.option = slot.default ?? slot.options![0].id;
            s[slot.id] = st;
        }
        this.state = s;
        for (const slot of this.cfg.slots) this.fillFinishes(slot);
        return s;
    }

    /** Every part of the current option has a finish; ones that no longer exist fall back to the default. */
    private fillFinishes(slot: Slot) {
        const st = this.state[slot.id], next: Record<string, string> = {};
        for (const p of this.parts(slot)) {
            const cur = st.finishes[p.id];
            next[p.id] = cur && p.finishes.includes(cur) ? cur : p.default ?? p.finishes[0];
        }
        st.finishes = next;
    }

    /** "option.finish.finish" for model slots, "finish.finish" for surfaces. */
    private parse(slot: Slot, value: string) {
        const tokens = value.split('.').filter(Boolean), st = this.state[slot.id];
        if (slot.kind === 'model') {
            const id = tokens.shift();
            if (id && slot.options!.some((o) => o.id === id)) { st.option = id; st.finishes = {}; }
            this.fillFinishes(slot);
        }
        this.parts(slot).forEach((p, i) => { if (tokens[i] && p.finishes.includes(tokens[i])) st.finishes[p.id] = tokens[i]; });
    }

    private encode(slot: Slot): string {
        const st = this.state[slot.id];
        const fin = this.parts(slot).map((p) => st.finishes[p.id]);
        return (slot.kind === 'model' ? [st.option, ...fin] : fin).join('.');
    }

    /** `view` = zone camera id, `el` = element id (both optional). */
    toQuery(view?: string, el?: string | null): string {
        const q = new URLSearchParams();
        for (const slot of this.cfg.slots) q.set(slot.id, this.encode(slot));
        if (view) q.set('view', view);
        if (el) q.set('el', el);
        const debug = new URLSearchParams(location.search).get('debug');
        if (debug) q.set('debug', debug);
        return q.toString().replace(/%2C/g, ',');
    }

    shareUrl(view?: string, el?: string | null): string {
        const base = this.cfg.shareBase || location.origin + location.pathname;
        const q = new URLSearchParams(this.toQuery(view, el));
        q.delete('debug');
        return base + '?' + q.toString().replace(/%2C/g, ',');
    }

    /**
     * PBR finishes point at a manifest id, optionally with fallbacks for sets that may not be baked
     * yet (`pbrFallback`). A finish whose set (and every fallback) is missing is dropped from the
     * parts that list it, so the menu never offers a blank chip; a part default that disappears
     * falls back to the part's first finish (old share links do the same).
     */
    private resolveFinishes() {
        const gone = new Set<string>();
        for (const [id, f] of Object.entries(this.cfg.finishes)) {
            if (!f.pbr) continue;
            const ids = [f.pbr, ...(f.pbrFallback ?? [])];
            const hit = ids.find((x) => pbrSet(typeof x === 'string' ? x : x.pbr));
            if (hit) {
                if (hit !== f.pbr) {
                    const alt = typeof hit === 'string' ? { pbr: hit } : hit;
                    console.info(`[finishes] ${id}: ${f.pbr} not baked yet, using ${alt.pbr}`);
                    Object.assign(f, alt);
                }
            } else {
                gone.add(id);
                console.warn(`[finishes] ${id}: texture set ${ids.map((x) => (typeof x === 'string' ? x : x.pbr)).join(' / ')} not in the manifest; finish hidden`);
            }
        }
        if (!gone.size) return;
        const fix = (p: Part) => {
            p.finishes = p.finishes.filter((x) => !gone.has(x));
            if (p.default && gone.has(p.default)) p.default = undefined;
        };
        for (const s of this.cfg.slots) {
            for (const p of s.parts ?? []) fix(p);
            for (const o of s.options ?? []) for (const p of o.parts ?? []) fix(p);
        }
    }

    // ---------------------------------------------------------------- start-up
    /** Loads the room and the configuration in the address. Returns where to look first. */
    async init(params: URLSearchParams): Promise<{ view: string | null; el: string | null; zone?: string; element?: string }> {
        expandCatalogue(this.cfg, manifestSets());
        this.viewer.clothKeys = clothMaterials(this.cfg, matKey);
        this.resolveFinishes();
        this.defaults();
        const preset = this.cfg.presets[params.get('p') ?? ''];
        for (const [id, v] of Object.entries(preset?.state ?? {})) { const s = this.slot(id); if (s) this.parse(s, v); }
        // ?look= sets the whole room; slot values in the address still win
        const look = this.cfg.looks?.find((l) => l.id === params.get('look'));
        for (const [id, v] of Object.entries(look?.state ?? {})) { if (this.hasSlot(id)) this.parse(this.slot(id), v); }
        // old share links: a removed slot's value goes to the slots that replaced it (e.g. floor -> 3 sections)
        for (const [old, ids] of Object.entries(this.cfg.legacyParams ?? {})) {
            const v = this.hasSlot(old) ? null : params.get(old);
            if (v) for (const id of ids) if (this.hasSlot(id) && !params.get(id)) this.parse(this.slot(id), v);
        }
        for (const slot of this.cfg.slots) { const v = params.get(slot.id); if (v) this.parse(slot, v); }
        this.enforceRules();

        const root = await this.viewer.loadBaked(this.cfg.base);
        this.base = { root, index: indexMaterials(root) };
        await this.applySurfaces(this.base);
        await Promise.all(this.cfg.slots.filter((s) => s.kind === 'model' && !s.anchorSlot).map((s) => this.showOption(s)));
        await Promise.all(this.cfg.slots.filter((s) => s.anchorSlot).map((s) => this.showOption(s)));
        this.viewer.refreshReflections(0);
        return { view: params.get('view') ?? preset?.camera ?? look?.camera ?? null, el: params.get('el'), zone: preset?.zone, element: preset?.element };
    }

    // ---------------------------------------------------------------- models
    private async load(slot: Slot, opt: Option): Promise<Loaded | null> {
        const key = slot.id + ':' + opt.id;
        if (opt.none || (!opt.dir && !opt.glb)) return null;
        if (this.loaded.has(key)) return this.loaded.get(key)!;
        if (!this.loading.has(key)) {
            this.setBusy(1);
            this.loading.set(key, (async () => {
                try {
                    const wrap = new THREE.Group();
                    wrap.name = key;
                    if (opt.dir) {
                        const root = await this.viewer.loadBaked(opt.dir);
                        wrap.add(root);
                        if (opt.shadow) { const s = contactShadow(root); if (s) wrap.add(s); }
                        this.viewer.scene.add(wrap);
                    } else {
                        wrap.add(await this.viewer.loadPlain(opt.glb!));    // template; copies are placed on anchors
                    }
                    wrap.visible = false;
                    const l: Loaded = { root: wrap, index: indexMaterials(wrap) };
                    await this.applySurfaces(l);
                    await this.applyParts(slot, l, opt.id);
                    this.loaded.set(key, l);
                    return l;
                } catch (err) {
                    console.error('[configurator] could not load', key, err);
                    return null;
                } finally { this.setBusy(-1); }
            })());
        }
        return this.loading.get(key)!;
    }

    private setBusy(d: number) {
        this.busy += d;
        this.onBusy(this.busy > 0);
        // low-memory devices: once everything has settled, let go of what is not on screen
        if (this.busy === 0 && this.viewer.lowMemory) {
            clearTimeout(this.cleanTimer);
            this.cleanTimer = setTimeout(() => { if (this.busy === 0) this.evict(); }, 600);
        }
    }
    private cleanTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Unloads option models that are not shown (taps stay: a small shared library) and finish
     * textures no surface uses. Choosing one again loads it again, from the browser cache.
     */
    private evict() {
        for (const [key, l] of [...this.loaded]) {
            const i = key.indexOf(':'), slotId = key.slice(0, i), optId = key.slice(i + 1);
            const slot = this.cfg.slots.find((s) => s.id === slotId);
            if (!slot || slot.anchorSlot || this.state[slotId]?.option === optId) continue;
            this.loaded.delete(key);
            this.loading.delete(key);
            this.viewer.disposeModel(l.root, isSharedTexture, originalTextures);
        }
        releaseUnused(this.viewer.scene);
        this.viewer.invalidate();
    }

    /** Shows the slot's current option (loading it first if needed) and hides the others. */
    private async showOption(slot: Slot) {
        const opt = this.option(slot)!;
        const l = await this.load(slot, opt);
        if (this.state[slot.id].option !== opt.id) return;          // the visitor moved on while it loaded
        for (const o of slot.options!) {
            const other = this.loaded.get(slot.id + ':' + o.id);
            if (other && !slot.anchorSlot) other.root.visible = o.id === opt.id;
        }
        if (l) await this.applyParts(slot, l);
        if (this.state[slot.id].option !== opt.id) return;
        if (slot.anchorSlot) this.place(slot, l);
        // whatever sits on this slot's anchors moves with it
        for (const dep of this.cfg.slots.filter((s) => s.anchorSlot === slot.id)) {
            this.place(dep, this.loaded.get(dep.id + ':' + this.state[dep.id].option) ?? null);
        }
        this.viewer.invalidate();
    }

    /** Copies a library model onto every anchor of the slot it depends on (taps on sinks / basins). */
    private place(slot: Slot, l: Loaded | null) {
        const old = this.anchored.get(slot.id);
        if (old) { this.viewer.scene.remove(old); this.anchored.delete(slot.id); }
        if (!l) return;
        const anchors = this.anchorsFor(slot, this.state[slot.id].option);
        const group = new THREE.Group();
        for (const [x, y, z, rot = 0] of anchors) {
            const copy = l.root.clone(true);
            copy.visible = true;
            copy.position.set(x, y, z);
            copy.rotation.y = THREE.MathUtils.degToRad(rot);
            group.add(copy);
        }
        this.viewer.scene.add(group);
        this.anchored.set(slot.id, group);
    }

    // ---------------------------------------------------------------- finishes
    /** Materials of a part in a loaded model. Blender numbers repeated names ("Benchtop.001"); those are the same surface. */
    private hits(part: Part, l: Loaded, siblings: Part[] = []) {
        // a numbered name that another part lists by itself belongs to that part
        const claimed = new Set(siblings.filter((p) => p !== part).flatMap((p) => p.materials.map(matKey)));
        const out: { mat: THREE.MeshStandardMaterial; meshes: THREE.Mesh[] }[] = [];
        for (const name of part.materials) {
            const key = matKey(name);
            out.push(...(l.index.get(key) ?? []));
            for (const [k, v] of l.index) if (k.startsWith(key + '.') && /^\.\d{3}$/.test(k.slice(key.length)) && !claimed.has(k)) out.push(...v);
        }
        return out;
    }

    /** Parts that share a model with `part` (same slot option or surface slot). */
    private siblings(part: Part): Part[] {
        for (const s of this.cfg.slots) {
            if (s.parts?.includes(part)) return s.parts;
            for (const o of s.options ?? []) if (o.parts?.includes(part)) return o.parts;
        }
        return [];
    }

    /** Loads the finish's textures, then applies it (unless `still()` says the visitor moved on). */
    private async applyPart(part: Part, finishId: string, l: Loaded, still: () => boolean = () => true) {
        const f = this.finish(finishId);
        const hits = this.hits(part, l, this.siblings(part));
        if (!hits.length) return;
        await ensureFinish(f);
        if (!still()) return;
        for (const { mat, meshes } of hits) {
            // model UVs scaled to metres from their texel density; box projection for flat panels or when UVs are missing
            let channel = 0, mpu = 0;
            // CFG_Finish UV layer from the export (1 UV = 1 m, clean layout) where the model's own UVs are poor
            const fin = part.uv !== 'box' && meshes.length > 0 && meshes.every((m) => finishUv(m) > 0) ? finishUv(meshes[0]) : 0;
            if (fin) { applyFinish(mat, f, fin, 1, part.rotation ?? 0); continue; }
            if (part.uv !== 'box') {
                let wsum = 0, dsum = 0;
                for (const m of meshes) { const d = uvDensity(m); if (d > 0) { dsum += d; wsum++; } }
                mpu = wsum ? dsum / wsum : 0;
            }
            if (part.uv === 'box' || mpu <= 0) { for (const m of meshes) channel = boxProject(m); mpu = 1; }
            applyFinish(mat, f, channel, mpu, part.rotation ?? 0);
        }
    }

    private async applyParts(slot: Slot, l: Loaded, optionId = this.state[slot.id].option) {
        const st = this.state[slot.id];
        const opt = slot.kind === 'model' ? this.option(slot, optionId) : undefined;
        const parts = slot.kind === 'surface' ? slot.parts ?? [] : opt?.parts ?? [];
        await Promise.all(parts.map((p) => this.applyPart(p, st.finishes[p.id] ?? p.default ?? p.finishes[0], l)));
    }

    /** Room surfaces (floor, fronts, benchtop ...) can also appear on option models, e.g. the benchtop around a sink. */
    private async applySurfaces(l: Loaded) {
        const jobs: Promise<void>[] = [];
        for (const slot of this.cfg.slots) {
            if (slot.kind !== 'surface') continue;
            for (const p of slot.parts ?? []) jobs.push(this.applyPart(p, this.state[slot.id].finishes[p.id], l));
        }
        await Promise.all(jobs);
    }

    /** Starts loading a finish's textures (pointer over a swatch), so the swap is instant. */
    prefetch(finishId: string) { prefetchFinish(this.finish(finishId)); }

    // ---------------------------------------------------------------- public changes
    async setOption(slotId: string, optionId: string) {
        const slot = this.slot(slotId), st = this.state[slotId];
        if (st.option === optionId) return;
        st.option = optionId;
        this.fillFinishes(slot);
        const deps = this.enforceRules();         // e.g. a vessel vanity that does not take the current tap
        this.onChange(slotId);
        await this.showOption(slot);
        await Promise.all(deps.map((d) => this.showOption(d)));
        this.viewer.refreshReflections();
        this.onChange(slotId);
    }

    setFinish(slotId: string, partId: string, finishId: string) {
        const slot = this.slot(slotId), st = this.state[slotId];
        const part = this.parts(slot).find((p) => p.id === partId);
        if (!part || st.finishes[partId] === finishId) return;
        st.finishes[partId] = finishId;
        const still = () => this.state[slotId].finishes[partId] === finishId;
        const targets = slot.kind === 'surface' ? [this.base, ...this.loaded.values()]
            : [this.loaded.get(slotId + ':' + st.option)].filter(Boolean) as Loaded[];
        this.onChange(slotId);
        this.setBusy(1);
        Promise.all(targets.map((l) => this.applyPart(part, finishId, l, still))).finally(() => {
            this.setBusy(-1);
            this.viewer.invalidate();
            this.viewer.refreshReflections();
        });
    }

    async reset() { await this.applyState({}); }

    /**
     * Sets the whole room at once (a look, or {} for the defaults). Every model and texture needed is
     * fetched first while the current room stays on screen, then everything swaps together.
     */
    async applyState(values: Record<string, string>) {
        this.setBusy(1);
        try {
            this.defaults();
            for (const [id, v] of Object.entries(values)) if (this.hasSlot(id)) this.parse(this.slot(id), v);
            this.enforceRules();
            await Promise.all([
                ...this.cfg.slots.filter((s) => s.kind === 'model').map((s) => this.load(s, this.option(s)!)),
                ...this.cfg.slots.flatMap((s) => this.parts(s).map((p) => ensureFinish(this.finish(this.state[s.id].finishes[p.id])))),
            ]);
            await this.applySurfaces(this.base);
            for (const l of this.loaded.values()) await this.applySurfaces(l);
            for (const s of this.cfg.slots.filter((s) => s.kind === 'model' && !s.anchorSlot)) await this.showOption(s);
            for (const s of this.cfg.slots.filter((s) => s.anchorSlot)) await this.showOption(s);
        } finally { this.setBusy(-1); }
        this.viewer.refreshReflections();
        this.onChange('*');
    }

    /** Runs `fn` on the state a set of values would give, without loading or showing anything. */
    preview<T>(values: Record<string, string>, fn: () => T): T {
        const saved = this.state;
        try {
            this.defaults();
            for (const [id, v] of Object.entries(values)) if (this.hasSlot(id)) this.parse(this.slot(id), v);
            this.enforceRules();
            return fn();
        } finally { this.state = saved; }
    }

    /** The configuration as one comparable string (no view). */
    stateKey() { return this.cfg.slots.map((s) => this.encode(s)).join('&'); }

    /** Slot values in share-link syntax ("option.finish…"), every slot. */
    values(): Record<string, string> { return Object.fromEntries(this.cfg.slots.map((s) => [s.id, this.encode(s)])); }

    /** The live catalogue as a configuration-code version (see code.ts). */
    codeVersion(): CodeVersion {
        const lists = (parts?: Part[]) => (parts ?? []).map((p) => [...p.finishes]);
        return {
            slots: this.cfg.slots.map((s) => ({
                id: s.id,
                options: s.kind === 'surface' ? [{ id: '', parts: lists(s.parts) }] : s.options!.map((o) => ({ id: o.id, parts: lists(o.parts) })),
            })),
            defaults: this.preview({}, () => this.values()),
            looks: (this.cfg.looks ?? []).map((l) => ({ id: l.id, values: this.preview(l.state, () => this.values()) })),
        };
    }

    // ---------------------------------------------------------------- summary
    /** One line per item, named like "Sofa Peru 3, brown leather". */
    summary(): SummaryLine[] {
        const lines: SummaryLine[] = [];
        for (const slot of this.cfg.slots) {
            const st = this.state[slot.id], opt = slot.kind === 'model' ? this.option(slot) : undefined;
            if (slot.kind === 'model' && (!opt || opt.none)) continue;
            const fin = this.parts(slot).map((p) => this.finish(st.finishes[p.id]));
            lines.push({
                slot: slot.id, group: slot.group,
                name: opt ? opt.name : slot.name ?? slot.label,
                finishes: fin.map((f) => f.label.toLowerCase()),
                price: (opt ? opt.price ?? 0 : slot.price ?? 0) + fin.reduce((a, f) => a + (f.price ?? 0), 0),
            });
        }
        return lines;
    }
}
