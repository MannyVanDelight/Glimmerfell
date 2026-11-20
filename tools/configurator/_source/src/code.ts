// Configuration codes without a server ("GF1-7K2Q-M9A3"): a code stores, for one catalogue
// version, which slots differ from a base (the defaults or a look) and the option / finish
// *indices* of those slots. The index lists of every version live in public/codes.json, which
// only grows: an old code always decodes with the version it was made with, back to plain ids,
// so reordering or extending the catalogue never breaks it. Removing a version from the file does.
//
// After a catalogue change (new finishes, options, slots, looks or defaults) the live catalogue no
// longer matches the newest version: in development the console says so, and
// configurator.saveCodeVersion() appends the new version (README, "Configuration codes").

/** One catalogue version: per slot, its options and each option's parts with their finish ids. */
export interface CodeVersion {
    /** Slots in code order. Surface slots have one option with id "". */
    slots: { id: string; options: { id: string; parts: string[][] }[] }[];
    /** Slot values ("option.finish…") of the defaults. */
    defaults: Record<string, string>;
    /** Slot values of each look (complete), in base order 1..n. */
    looks: { id: string; values: Record<string, string> }[];
}
export interface CodeFile { versions: Record<string, CodeVersion> }

// Crockford base32: no I, L, O, U (read as 1, 1, 0, V-less), so codes survive being read aloud or typed
const ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const bitsFor = (n: number) => (n <= 1 ? 0 : Math.ceil(Math.log2(n)));

class Bits {
    bits: number[] = [];
    pos = 0;
    put(v: number, n: number) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1); }
    get(n: number) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | (this.bits[this.pos++] ?? 0); return v; }
}

function check(chars: string): string {
    let s = 0;
    for (let i = 0; i < chars.length; i++) s = (s + (ABC.indexOf(chars[i]) + 1) * (i + 3)) % 32;
    return ABC[s];
}

const split = (slot: CodeVersion['slots'][number], value: string) => {
    const t = value.split('.');
    const surface = slot.options.length === 1 && slot.options[0].id === '';
    return { opt: surface ? '' : t[0] ?? '', fin: surface ? t : t.slice(1) };
};

/** Same catalogue? (decides whether a new version is needed) */
export function sameVersion(a: CodeVersion, b: CodeVersion) { return JSON.stringify(a) === JSON.stringify(b); }

/** The newest version number in the file (0 = none). */
export function latest(file: CodeFile) { return Math.max(0, ...Object.keys(file.versions).map(Number)); }

/** Encodes slot values with one version. Null when a value is not in that version's lists. */
export function encode(file: CodeFile, values: Record<string, string>): string | null {
    const v = latest(file), ver = file.versions[v];
    if (!ver) return null;
    // a slot the version does not know would be lost: no code (the link still works)
    if (Object.keys(values).some((id) => !ver.slots.some((s) => s.id === id))) return null;
    const bases = [ver.defaults, ...ver.looks.map((l) => l.values)];
    let best: string | null = null;
    // try every base (defaults, each look) and keep the shortest code
    bases.forEach((base, bi) => {
        const b = new Bits();
        b.put(bi, bitsFor(bases.length));
        for (const slot of ver.slots) {
            const val = values[slot.id] ?? base[slot.id];
            if (val === base[slot.id]) { b.put(0, 1); continue; }
            b.put(1, 1);
            const { opt, fin } = split(slot, val);
            const oi = slot.options.findIndex((o) => o.id === opt);
            if (oi < 0) { b.bits = []; return; }
            b.put(oi, bitsFor(slot.options.length));
            for (const [pi, list] of slot.options[oi].parts.entries()) {
                const fi = list.indexOf(fin[pi]);
                if (fi < 0) { b.bits = []; return; }
                b.put(fi, bitsFor(list.length));
            }
        }
        if (!b.bits.length && ver.slots.length) return;
        while (b.bits.length % 5) b.bits.push(0);
        let chars = '';
        for (let i = 0; i < b.bits.length; i += 5) chars += ABC[parseInt(b.bits.slice(i, i + 5).join(''), 2)];
        chars = chars.replace(/0+$/, '');          // trailing zeros = unchanged slots, restored on decode
        const body = chars + check(`${v}:${chars}`.replace(/[^0-9A-Z]/g, ''));
        const code = `GF${v}-` + body.match(/.{1,4}/g)!.join('-');
        if (!best || code.length < best.length) best = code;
    });
    return best;
}

/** Slot values of a code, or null (unknown version, typo, wrong check character). */
export function decode(file: CodeFile, code: string): Record<string, string> | null {
    const m = /^GF(\d+)-?([0-9A-Z-]+)$/.exec(code.toUpperCase().replace(/\s+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'));
    if (!m) return null;
    const v = m[1], body = m[2].replace(/-/g, ''), ver = file.versions[v];
    if (!ver || body.length < 1) return null;
    const chars = body.slice(0, -1);
    if (check(`${v}:${chars}`.replace(/[^0-9A-Z]/g, '')) !== body.slice(-1)) return null;
    const b = new Bits();
    for (const ch of chars) { const x = ABC.indexOf(ch); if (x < 0) return null; b.put(x, 5); }
    const bases = [ver.defaults, ...ver.looks.map((l) => l.values)];
    const base = bases[b.get(bitsFor(bases.length))];
    if (!base) return null;
    const out: Record<string, string> = { ...base };
    for (const slot of ver.slots) {
        if (!b.get(1)) continue;
        const o = slot.options[b.get(bitsFor(slot.options.length))];
        if (!o) return null;
        const fin: string[] = [];
        for (const list of o.parts) { const f = list[b.get(bitsFor(list.length))]; if (!f) return null; fin.push(f); }
        out[slot.id] = [...(o.id ? [o.id] : []), ...fin].join('.');
    }
    return out;
}
