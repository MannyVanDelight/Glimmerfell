// Finish catalogue: turns the PBR manifest into the finish list of every part, by category rules
// in config.json ("catalogue"). A part names a family; every manifest set in the family's categories
// is offered next to the part's curated finishes, so a new set in the manifest shows up wherever it
// makes sense without editing the part lists, and never where it makes none (no metal upholstery).
//
// Generated finish ids are "<family>-<set id>" (stable, so share links keep working). Curated
// finishes keep their ids, labels and prices; a curated finish that shows a set as it is (no
// recolour) replaces the generated entry for that set.

import type { Catalogue, Config, Family, Finish, Part, PbrSet } from './types';

export const DEFAULT_ORDER = ['paint', 'lacquer', 'wood', 'stone', 'tile', 'glass', 'metal', 'fabric', 'plastic'];
export const DEFAULT_LABELS: Record<string, string> = {
    paint: 'Paint', lacquer: 'Lacquer', wood: 'Wood', stone: 'Stone', tile: 'Tiles', glass: 'Glass',
    metal: 'Metal', fabric: 'Fabric', plastic: 'Synthetics', other: 'Other',
};

const matches = (id: string, rules: string[] = []) =>
    rules.some((r) => (r.endsWith('*') ? id.startsWith(r.slice(0, -1)) : id === r));

/** Category of a finish: its own, else its set's. */
export function categoryOf(f: Finish, sets: Map<string, PbrSet>): string {
    return f.category ?? (f.pbr ? sets.get(f.pbr)?.category : undefined) ?? 'other';
}

/** A finish is sheer when it says so or its set carries an alpha map. */
export function isSheer(f: Finish, sets: Map<string, PbrSet>): boolean {
    if (f.sheer) return true;
    const s = f.pbr ? sets.get(f.pbr) : undefined;
    return !!(s && (s.alpha || s.alphaFrom));
}

/** Sets the family offers, in manifest order. */
export function familySets(fam: Family, sets: Map<string, PbrSet>): PbrSet[] {
    return [...sets.values()].filter((s) => {
        if (matches(s.id, fam.exclude)) return false;
        const sheer = !!(s.alpha || s.alphaFrom);
        if (sheer && !fam.sheer) return false;
        if (!sheer && fam.sheerOnly) return false;
        if (matches(s.id, fam.include)) return true;
        if (!fam.categories.includes(s.category)) return false;
        if (s.use && !(fam.use ?? []).includes(s.use)) return false;
        return true;
    });
}

/**
 * Applies `pbrPreferred` upgrades whose set is baked (a colour stand-in becomes the real set).
 * Run before the catalogue so the upgraded finish takes the generated entry's place.
 */
function upgrade(cfg: Config, sets: Map<string, PbrSet>) {
    for (const [id, f] of Object.entries(cfg.finishes)) {
        const up = f.pbrPreferred;
        if (!up || !sets.has(up.pbr)) continue;
        const rec = f as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(up)) { if (v === null) delete rec[k]; else rec[k] = v; }
        delete f.pbrPreferred;
        console.info(`[catalogue] ${id}: now uses ${up.pbr}`);
    }
}

/**
 * Fills cfg.finishes with the generated entries and every family part's `finishes` with the full,
 * ordered list: grouped by category (the default's category first, the default first in it), then
 * by label. Parts without a family keep their list as it is.
 */
export function expandCatalogue(cfg: Config, sets: Map<string, PbrSet>) {
    upgrade(cfg, sets);
    const cat: Catalogue | undefined = cfg.catalogue;
    if (!cat) return;
    const order = cat.categoryOrder ?? DEFAULT_ORDER;
    const rank = (c: string) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };

    // sheer stand-ins (no alpha set yet) only while procedural sheer is on
    const hidden = new Set<string>();
    for (const [id, f] of Object.entries(cfg.finishes)) {
        if (f.sheer && !(f.pbr && sets.has(f.pbr)) && !cat.proceduralSheer) hidden.add(id);
    }

    const generated = new Map<string, string[]>();      // family -> generated ids
    const gen = (famId: string, fam: Family, curated: string[]) => {
        // sets a curated finish already shows unchanged
        const shown = new Set(curated.map((id) => cfg.finishes[id]).filter((f) => f?.pbr && !f.color && !f.tint).map((f) => f!.pbr!));
        const ids: string[] = [];
        for (const s of familySets(fam, sets)) {
            if (shown.has(s.id)) continue;
            const id = `${famId}-${s.id}`;
            if (!cfg.finishes[id]) {
                const d = { ...(fam.defaults?.[s.category] ?? {}), ...(fam.defaults?.[s.id] ?? {}) };
                const base = fam.price?.[s.category] ?? 0;
                const price = Math.round((base * (cat.premium?.[s.id] ?? 1)) / 10) * 10;
                cfg.finishes[id] = { label: fam.labels?.[s.id] ?? s.label, pbr: s.id, price, category: s.category, generated: true, ...d };
            }
            ids.push(id);
        }
        return ids;
    };

    const fix = (p: Part) => {
        if (!p.family) return;
        const fam = cat.families[p.family];
        if (!fam) { console.warn(`[catalogue] part ${p.id}: unknown family ${p.family}`); return; }
        const curated = [...new Set([...p.finishes, ...(fam.extra ?? [])])].filter((id) => cfg.finishes[id] && !hidden.has(id));
        const key = p.family + '|' + curated.join();
        let more = generated.get(key);
        if (!more) { more = gen(p.family, fam, curated); generated.set(key, more); }
        const all = [...new Set([...curated, ...more])];
        const def = p.default && all.includes(p.default) ? p.default : curated[0] ?? all[0];
        const label = (id: string) => cfg.finishes[id].label.toLowerCase();
        const c0 = categoryOf(cfg.finishes[def], sets);
        all.sort((a, b) => {
            const ca = categoryOf(cfg.finishes[a], sets), cb = categoryOf(cfg.finishes[b], sets);
            const ra = ca === c0 ? -1 : rank(ca), rb = cb === c0 ? -1 : rank(cb);
            if (ra !== rb) return ra - rb;
            if (a === def) return -1;
            if (b === def) return 1;
            return label(a).localeCompare(label(b));
        });
        p.finishes = all;
        p.default = def;
        p.curated = curated;
    };
    for (const s of cfg.slots) {
        for (const p of s.parts ?? []) fix(p);
        for (const o of s.options ?? []) for (const p of o.parts ?? []) fix(p);
    }
}

/** Blender material keys (lower case, no numbering) of cloth parts: "cloth", or "sheer" when a Blackout / Sheer choice exists. */
export function clothMaterials(cfg: Config, key: (n: string) => string): Map<string, 'cloth' | 'sheer'> {
    const out = new Map<string, 'cloth' | 'sheer'>();
    const fams = cfg.catalogue?.families ?? {};
    const add = (p: Part) => {
        const fam = p.family ? fams[p.family] : undefined;
        if (!fam?.cloth) return;
        for (const m of p.materials) {
            const k = key(m).replace(/\.\d{3}$/, '');
            if (fam.sheer || fam.sheerOnly) out.set(k, 'sheer'); else if (!out.has(k)) out.set(k, 'cloth');
        }
    };
    for (const s of cfg.slots) {
        for (const p of s.parts ?? []) add(p);
        for (const o of s.options ?? []) for (const p of o.parts ?? []) add(p);
    }
    return out;
}
