// One-off helper that added the furniture and tap slots to public/config.json from the bake report.
// Kept for reference; edit config.json directly from now on.
import fs from 'node:fs';
const file = new URL('../public/config.json', import.meta.url);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
Object.assign(c.finishes, {
    'orig-peru': { label: 'Cream leather', original: true, swatch: '#cfc3b0' },
    'orig-white-paint': { label: 'White painted', original: true, swatch: '#e9e6df' },
    'orig-walnut': { label: 'Walnut', original: true, swatch: '#6b4a33' },
    'lacquer-sage2': { label: 'Sage lacquer', color: '#8e9a86', roughness: 0.4, price: 300 },
    'linen-white': { label: 'White linen', color: '#eceae4', roughness: 0.95 },
    'linen-sand': { label: 'Sand linen', color: '#cdbfa6', roughness: 0.95 },
    'linen-sage': { label: 'Sage linen', color: '#9aa791', roughness: 0.95, price: 120 },
    'linen-charcoal': { label: 'Charcoal linen', color: '#404144', roughness: 0.95, price: 120 },
});
const fab = ['fabric-linen', 'fabric-stone', 'fabric-sage', 'fabric-rust', 'fabric-navy', 'fabric-charcoal', 'leather-brown'];
const linen = ['linen-white', 'linen-sand', 'linen-sage', 'linen-charcoal'];
const metal = ['metal-chrome', 'metal-brass', 'metal-black', 'metal-gunmetal'];
const tap = (id, label, name, f, mats, def, price) => ({ id, label, name, glb: `assets/taps/${f}.glb`, price,
    parts: [{ id: 'metal', label: 'Finish', materials: mats, finishes: metal, default: def }] });
const lib = {
    gooseneck: tap('gooseneck', 'Gooseneck', 'Tap Gooseneck', 'tap-gooseneck-black', ['Sink & faucet'], 'metal-black', 420),
    pullout: tap('pullout', 'Pull-out', 'Tap Pull-Out', 'tap-pull-out-steel', ['FaucetMetal.001'], 'metal-chrome', 690),
    flow: tap('flow', 'Flow', 'Tap Flow', 'flow-single-lever-kitchen-mixer-tap', ['Black', 'metal.001'], 'metal-black', 540),
    tall: tap('tall', 'Tall 07', 'Tap Tall 07', 'tap-07', ['chrome metal'], 'metal-chrome', 760),
    slim: tap('slim', 'Basin slim', 'Tap Basin Slim', 'faucet-tap-matt-black', ['CCL Matte Metal Black'], 'metal-black', 290),
    classic: tap('classic', 'Basin classic', 'Tap Basin Classic', 'faucet-tap-chrome', ['Clean chrome'], 'metal-chrome', 310),
};
const cl = (o) => JSON.parse(JSON.stringify(o));
const add = [
    { id: 'tap', label: 'Kitchen tap', group: 'Kitchen', kind: 'model', camera: 'sink', anchorSlot: 'sink', anchorKey: 'tap',
        options: [lib.gooseneck, lib.pullout, lib.flow, lib.tall].map(cl) },
    { id: 'sofa', label: 'Sofa', group: 'Living', kind: 'model', camera: 'living', default: 'peru3', options: [
        { id: 'peru3', label: 'Peru 3', name: 'Sofa Peru 3', dir: 'assets/sofa_peru-3-seater-sofa', price: 3400, shadow: true, thumb: 'thumbs/sofa_peru-3-seater-sofa.jpg',
            parts: [{ id: 'upholstery', label: 'Upholstery', materials: ['Sofa', 'Sofa Cushion'], finishes: ['orig-peru', ...fab] },
                { id: 'legs', label: 'Legs', materials: ['Gold'], finishes: ['metal-brass', 'metal-black', 'metal-chrome'] }] },
        { id: 'modular', label: 'DL Modular', name: 'Sofa DL Modular', dir: 'assets/sofa_dl-modular-sofa', price: 4200, shadow: true, thumb: 'thumbs/sofa_dl-modular-sofa.jpg',
            parts: [{ id: 'upholstery', label: 'Upholstery', materials: ['MTL_Velvet_backrest', 'MTL_Velvet_seat', 'MTL_Velvet_seams'], finishes: fab, default: 'fabric-sage' }] },
        { id: 'corner', label: 'Corner L', name: 'Sofa Corner L', dir: 'assets/sofa_couch-1', price: 4900, shadow: true, thumb: 'thumbs/sofa_couch-1.jpg',
            parts: [{ id: 'upholstery', label: 'Upholstery', materials: ['Fabric 131'], finishes: fab, default: 'fabric-stone' },
                { id: 'cushions', label: 'Cushions', materials: ['Fabric 05', 'Fabric'], finishes: fab, default: 'fabric-navy' }] }] },
    { id: 'bed', label: 'Bed', group: 'Bed & Bath', kind: 'model', camera: 'bed', default: 'floss', options: [
        { id: 'floss', label: 'Floss', name: 'Bed Floss', dir: 'assets/bed_floss-bed', price: 3900, shadow: true, thumb: 'thumbs/bed_floss-bed.jpg',
            parts: [{ id: 'frame', label: 'Frame fabric', materials: ['Fabric 134'], finishes: fab, default: 'fabric-stone' },
                { id: 'base', label: 'Base', materials: ['Imbuia wood'], uv: 'box', finishes: ['veneer-walnut', 'veneer-oak', 'lacquer-charcoal'] },
                { id: 'linen', label: 'Linen', materials: ['black blanket'], finishes: linen, default: 'linen-charcoal' }] },
        { id: 'soft', label: 'Soft Modern', name: 'Bed Soft Modern', dir: 'assets/bed_soft-modern-bed', price: 4600, shadow: true, thumb: 'thumbs/bed_soft-modern-bed.jpg',
            parts: [{ id: 'frame', label: 'Frame fabric', materials: ['Fabric.001'], finishes: fab, default: 'fabric-charcoal' },
                { id: 'linen', label: 'Linen', materials: ['Blanket', 'Sheet', 'Pillows'], finishes: linen }] },
        { id: 'suite', label: 'Suite One', name: 'Bed Suite One', dir: 'assets/bed_bedroom-kit-one', price: 5800, shadow: true, thumb: 'thumbs/bed_bedroom-kit-one.jpg',
            parts: [{ id: 'frame', label: 'Upholstery', materials: ['Yellow Miracle soft Fabric', 'Yellow Miracle soft Fabric.001'], finishes: fab, default: 'fabric-linen' },
                { id: 'linen', label: 'Linen', materials: ['fabric.003'], finishes: linen }] }] },
    { id: 'vanity', label: 'Vanity', group: 'Bed & Bath', kind: 'model', camera: 'vanity', default: 'single', options: [
        { id: 'single', label: 'Single 1200', name: 'Vanity Single 1200', dir: 'assets/vanity_single-bathroom-vanity', price: 2400, thumb: 'thumbs/vanity_single-bathroom-vanity.jpg',
            anchors: { tap: [[-1.70, 0.739, 6.45, 180]] },
            parts: [{ id: 'cabinet', label: 'Cabinet', materials: ['Material.005'], finishes: ['orig-walnut', 'lacquer-white', 'lacquer-charcoal', 'lacquer-navy'] }] },
        { id: 'floating', label: 'Floating 1500', name: 'Vanity Floating 1500', dir: 'assets/vanity_bathroom-furniture-set', price: 3100, thumb: 'thumbs/vanity_bathroom-furniture-set.jpg',
            anchors: { tap: [[-1.25, 0.738, 6.25, -90]] },
            parts: [{ id: 'cabinet', label: 'Cabinet', materials: ['Wood Painted White'], finishes: ['orig-white-paint', 'lacquer-charcoal', 'lacquer-navy', 'lacquer-sage2'] }] },
        { id: 'double', label: 'Beira Double', name: 'Vanity Beira Double 1800', dir: 'assets/vanity_beira-double-bathroom-vanity', price: 4300, thumb: 'thumbs/vanity_beira-double-bathroom-vanity.jpg',
            anchors: { tap: [[-2.15, 0.861, 6.42, 180], [-1.25, 0.861, 6.42, 180]] },
            parts: [{ id: 'cabinet', label: 'Cabinet', materials: ['Procedural Wood'], uv: 'box', finishes: ['veneer-oak', 'veneer-walnut', 'lacquer-white', 'lacquer-charcoal'] }] }] },
    { id: 'basintap', label: 'Basin tap', group: 'Bed & Bath', kind: 'model', camera: 'vanity', anchorSlot: 'vanity', anchorKey: 'tap',
        options: [lib.flow, lib.gooseneck, lib.slim, lib.classic].map(cl) },
];
c.slots = c.slots.filter((s) => !add.some((a) => a.id === s.id)).concat(add);
// materials glTF can't describe and the exporter could not tag: name -> how to show them
c.surfaces = { 'Mirror': 'mirror', 'mirror': 'mirror', 'AR3DMat Procedural Realistic Mirror': 'mirror' };
fs.writeFileSync(file, JSON.stringify(c, null, 1));
console.log(c.slots.map((s) => s.id).join(' '));
