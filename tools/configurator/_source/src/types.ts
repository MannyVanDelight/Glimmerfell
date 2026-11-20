// Data model of public/config.json. The whole configurator is driven by that one file:
// a client version is a new config plus their assets, not new code.

/**
 * A surface finish: a baked PBR texture set (`pbr`), a legacy colour texture (`map`), or a plain
 * colour. Every finish fills the same material slots (colour, normal, roughness/metal), so
 * swapping finishes never recompiles a shader.
 */
export interface Finish {
    label: string;
    /** Keep the material exactly as it came from Blender. */
    original?: boolean;
    /** Id of a texture set in textures/pbr/manifest.json (basecolor + normal + ORM). */
    pbr?: string;
    /**
     * Sets to use, in order, while `pbr` is not in the manifest yet: an id, or an object whose
     * fields (pbr, tint, gain, tile, rotation ...) replace the finish's own while it stands in.
     */
    pbrFallback?: (string | (Partial<Finish> & { pbr: string }))[];
    /**
     * Plain colour. With `pbr`: recolours the set to this average colour (relief, gloss and the
     * pattern's light/dark variation stay), e.g. one weave in several colours.
     */
    color?: string;
    /** Multiplies the PBR / map colour (sRGB hex). */
    tint?: string;
    /** Brightness factor on top of `tint` (1 = as baked). Values above 1 lighten a dark set. */
    gain?: number;
    /** Legacy tiling colour texture, path relative to the site root. */
    map?: string;
    /** Size of one texture repeat in metres. Default: the set's `tile` from the manifest (or 1). */
    tile?: number;
    /** Texture rotation in degrees (e.g. 90 to run planks the other way). */
    rotation?: number;
    /** Stretch along the texture's horizontal axis (straightens wavy wood grain into veneer). */
    stretch?: number;
    /** Normal map strength (1 = as baked). */
    normalScale?: number;
    /** Multiplies the baked roughness (PBR) . */
    roughnessScale?: number;
    /** Plain / legacy finishes: roughness. PBR: overrides the map with a constant when set. */
    roughness?: number;
    /** Plain / legacy finishes: metalness. PBR: multiplies the baked metal mask (default 1). */
    metalness?: number;
    /** Chip in the UI: an image path or a CSS colour. PBR finishes default to the set's swatch.webp. */
    swatch?: string;
    /** Indicative price difference for choosing this finish. */
    price?: number;
    /**
     * Group in the menu and material response: a manifest category (wood, stone, tile, metal,
     * fabric, plastic) or paint / lacquer / glass. Default: the PBR set's category.
     */
    category?: string;
    /** See-through fabric (blinds, curtains): alpha from the set's alpha.webp, or a fine woven alpha. */
    sheer?: boolean;
    /** Sheer only: overall opacity factor on top of the alpha map (1 = as the map says). */
    opacity?: number;
    /**
     * Upgrade used as soon as the set is in the manifest (e.g. a colour stand-in for a sheer set that
     * is still being baked). Fields replace the finish's own; `null` removes one.
     */
    pbrPreferred?: Partial<Record<keyof Finish, unknown>> & { pbr: string };
    /** Set by the catalogue: the finish was generated from a manifest set (not curated). */
    generated?: boolean;
    /** Small label on the swatch in the options panel, e.g. "Designer pick", "Bestseller", "New". */
    badge?: string;
}

/**
 * Rules that turn the PBR manifest into finish lists. A part names a `family`; the family lists the
 * manifest categories that make sense there and every set in them is offered, next to the part's
 * curated `finishes`.
 */
export interface Family {
    label?: string;
    /** Manifest categories offered (wood, stone, tile, metal, fabric, plastic). */
    categories: string[];
    /** Sets carrying a `use` in the manifest (e.g. "floor") are only offered where that use is listed. */
    use?: string[];
    /** Set ids left out; a trailing "*" matches a prefix (e.g. "leather_*"). */
    exclude?: string[];
    /** Set ids offered although their category is not listed. */
    include?: string[];
    /** Curated finish ids added to every part of the family (paints, lacquers ...). */
    extra?: string[];
    /** Sheer (alpha) sets are offered, and the part gets a Blackout / Sheer choice. */
    sheer?: boolean;
    /** Only sheer finishes (the see-through layer of a curtain). */
    sheerOnly?: boolean;
    /** The family's materials are cloth: physical material with sheen, low specular (see viewer). */
    cloth?: boolean;
    /** Price of a generated finish by category (times catalogue.premium of its set). */
    price?: Record<string, number>;
    /** Overrides for generated finishes by category or set id (set id wins): tile, rotation, stretch ... */
    defaults?: Record<string, Partial<Finish>>;
    /** Labels for generated finishes by set id. */
    labels?: Record<string, string>;
}

export interface Catalogue {
    families: Record<string, Family>;
    /** Price factor per set id (rare stones, precious metals, leathers). */
    premium?: Record<string, number>;
    /** Menu headings per category. */
    categoryLabels?: Record<string, string>;
    /** Order of the category groups in the menu. */
    categoryOrder?: string[];
    /** Show sheer finishes whose set is not baked yet with a woven stand-in alpha (development). */
    proceduralSheer?: boolean;
}

/** One entry of textures/pbr/manifest.json. */
export interface PbrSet {
    id: string;
    label: string;
    category: string;
    /** Metres covered by one repeat of the texture. */
    tile: number;
    /** Where the set is meant to be used (e.g. "floor"); such sets are offered only where a family lists the use. */
    use?: string;
    /** The set has an alpha.webp (sheer fabric). */
    alpha?: boolean;
    /** Takes its alpha.webp from another set. */
    alphaFrom?: string;
    /** Sheer sets: [g0, g1] — alpha rises to opaque where the cloth is seen edge-on: mix(alpha, 1, smoothstep(g0, g1, 1 - |n·v|)). */
    alphaGrazing?: [number, number];
    /** Sheer sets: average alpha of the alpha map (0..1). */
    opacity?: number;
    size: number;
    roughness: number;
    metallic: number;
    color: string;
    /** The set is uniform (flat metals / plastics): small textures are enough. */
    flat: boolean;
}

/** A part of an item that takes a finish on its own (fronts, benchtop, upholstery ...). */
export interface Part {
    id: string;
    label: string;
    /** Material names as in Blender (the exported "GF_" prefix is ignored). */
    materials: string[];
    /** Curated finishes (always offered); the family adds the generated ones at start-up. */
    finishes: string[];
    default?: string;
    /** Catalogue family (config.catalogue.families) that generates the rest of the list. */
    family?: string;
    /** Set at start-up: the curated finishes (part list + family extras) in config order. */
    curated?: string[];
    /**
     * "box": texture is projected in metres (written to a spare UV channel; the model's own UVs
     * stay intact), for flat panels whose own UVs don't tile. Default: the model's own UVs, scaled
     * to metres from their average texel density.
     */
    uv?: 'box';
    /** Extra texture rotation in degrees on this part (e.g. 90 where the model's UVs run sideways). */
    rotation?: number;
}

export interface Option {
    id: string;
    /** Short label on the button. */
    label: string;
    /** Name on the summary and PDF, e.g. "Sofa Peru 3". */
    name: string;
    /** Folder of a Glimmerfell Bake export (gf_lightmaps.json + GLBs). */
    dir?: string;
    /** A plain GLB without baked light (used for the shared tap library). */
    glb?: string;
    /** No model: the slot is left empty. */
    none?: boolean;
    price?: number;
    thumb?: string;
    parts?: Part[];
    /** Where items of other slots attach: key -> list of [x, y, z, rotationY°] in three.js axes. */
    anchors?: Record<string, number[][]>;
    /** Tap anchors by mount (deck / wall / side), from scene.json. */
    mounts?: Record<string, number[][]>;
    /** Soft contact shadow on the floor under the model. */
    shadow?: boolean;
    /** Small label on the card in the options panel, e.g. "Bestseller". */
    badge?: string;
}

export interface Slot {
    id: string;
    label: string;
    /** Heading in the slot list: Room, Kitchen, Living, Bed & Bath. */
    group: string;
    kind: 'surface' | 'model';
    /** Legacy; navigation now goes through `elements`. */
    camera?: string;
    /** Surface slots: name on the summary, e.g. "Floor". */
    name?: string;
    price?: number;
    parts?: Part[];
    options?: Option[];
    default?: string;
    /** This slot's models sit on the anchors of another slot's current option. */
    anchorSlot?: string;
    anchorKey?: string;
}

export type Vec3 = [number, number, number];

/** Orbit limits of a camera. Yaw/pitch in degrees, dist as multiples of the preset distance. */
export interface OrbitLimits {
    /** Yaw relative to the preset direction, e.g. [-100, 100]. */
    yaw?: [number, number];
    /** Elevation of the camera above the target in degrees (90 = straight down), e.g. [-8, 75]. */
    pitch?: [number, number];
    /** Zoom range as a multiple of the preset distance, e.g. [0.45, 1.6]. */
    dist?: [number, number];
}

export interface CameraPreset extends OrbitLimits {
    label?: string;
    position: Vec3;
    /** Orbit centre: the element or zone centre. */
    target: Vec3;
    fov?: number;
    /** Vertical fov a 9:16 screen needs at this position (scene.json, generated cameras). */
    fovPortrait?: number;
    portraitOk?: boolean;
    landscapeOk?: boolean;
    source?: 'user' | 'generated';
}

/** Navigation area (top bar tab). */
export interface Zone {
    id: string;
    label: string;
    camera: string;
    /** Hotspot position in the overview; defaults to the centre of the zone's element anchors. */
    anchor?: Vec3;
}

/** A key element: one hotspot + the slots it opens. */
export interface Element {
    id: string;
    label: string;
    /** Zone id, or "room" for elements offered in every zone (floor, walls). */
    zone: string;
    /** Close-up camera; room-wide elements keep the zone camera when omitted. */
    camera?: string;
    slots: string[];
    icon?: string;
    /** Hotspot point (overrides scene.json). */
    anchor?: Vec3;
    /** Room elements: hotspot point per zone id (overrides the automatic placement). */
    anchorByZone?: Record<string, Vec3>;
    /** Position in the zone's rail and in the panel's Next / Previous walk (lower first; default: config order). */
    order?: number;
}

/** A complete styled room ("look"): every slot set in one go. Values use the share-link syntax. */
export interface RoomLook {
    id: string;
    label: string;
    /** One line under the name. */
    line?: string;
    /** Slot id -> "option.finish…" (model slots) or "finish…" (surfaces); slots left out take their default. */
    state: Record<string, string>;
    /** Image on the card. Default: thumbs/looks/<id>.jpg. */
    thumb?: string;
    /** Camera to show when the look opens from a ?look= link without ?view=. */
    camera?: string;
}

/** A call to action at the end of the summary (and one line on the PDF). */
export interface Cta {
    id: string;
    label: string;
    /** url: opens href in a new tab · mailto: e-mail with subject/body · event: tells the embedding page (postMessage "cta"). */
    kind: 'url' | 'mailto' | 'event';
    /** url / mailto address. {url}, {items}, {total}, {code}, {summary} are filled in (url-encoded in a url). */
    href?: string;
    /** Also copy {summary} (code, total, link) to the clipboard, for a form that cannot be prefilled. */
    copy?: boolean;
    /** mailto: subject and body ({url}, {items}, {total}, {code}, {summary} are filled in). */
    subject?: string;
    body?: string;
    /** The main button (one per list); the others are secondary. */
    primary?: boolean;
    /** Text on the PDF next to the label (default: the address of href). */
    pdfText?: string;
}

export interface Preset {
    label: string;
    /** Legacy: camera id. */
    camera?: string;
    zone?: string;
    element?: string;
    state?: Record<string, string>;
}

/** An axis-aligned box in three.js coordinates. */
export interface BoxData { min: Vec3; max: Vec3; name?: string; kind?: string; element?: string }

/** public/assets/scene.json, written by the Blender export. */
export interface SceneData {
    room?: BoxData;
    cameras?: Record<string, CameraPreset>;
    elements?: Record<string, { anchor?: Vec3; bbox?: BoxData; zone?: string }>;
    anchors?: Record<string, Record<string, number[][] | Record<string, number[][]>>>;
    /** Taps allowed per host option (sink / vanity), their default and mount. */
    tapRules?: Record<string, Record<string, TapRule>>;
    colliders?: BoxData[];
    windows?: (BoxData & { normal?: Vec3 })[];
    doorways?: BoxData[];
    lights?: SceneLight[];
    sky?: { file?: string; env?: string; rotationY?: number; intensity?: number; sunDirection?: Vec3 };
}

export interface TapRule { allowed: string[]; default?: string; mount?: Record<string, string> }

export interface SceneLight { name?: string; position: Vec3; color?: Vec3; intensity?: number; watts?: number; type?: string }

/** Look settings (config.json "look"); every value has a default in the viewer. */
export interface Look {
    /** Brightness of the sky picture seen through the windows (1 = as stored in sky.jpg). */
    skyBackdrop?: number;
    /** Multiplier on the HDR sky used for reflections (on top of scene.json sky.intensity). */
    skyReflection?: number;
    /** Strength of the room reflections on every baked material. */
    reflections?: number;
    /** Probe resolution (cube face size). */
    probeSize?: number;
    /** Reflections fade where the baked light is below this fraction of the atlas median. */
    specularOcclusion?: number;
    /** Lowest reflection level in the darkest corners (0..1). */
    specularOcclusionFloor?: number;
    /** Light seen through the window glass (0..1). */
    glassTransmission?: number;
    /** Reflection strength of the window glass. */
    glassReflection?: number;
    /** Sheer fabric: light coming through from the window side (fraction of the fabric colour). */
    sheerGlow?: number;
    /** Largest texture edge loaded for finishes (px). */
    maxTextureSize?: number;
    /** Phones / tablets: largest edge of every texture except baked light (px, default 512). */
    lowMemoryTextureSize?: number;
    /** Phones / tablets: largest edge of baked light textures (px, default 1024). */
    lowMemoryLightmapSize?: number;
}

export interface Config {
    title: string;
    currency: string;
    shareBase?: string;
    base: string;
    /** Fallback camera box when scene.json has no room. */
    bounds: { min: Vec3; max: Vec3 };
    /**
     * Reflection probes (at most two). `box` is the room the probe stands in: it bounds the
     * box projection, and each surface reflects the probe of the room it is in.
     */
    probes: { position: Vec3; box?: { min: Vec3; max: Vec3 } }[];
    /** Fallback background colour when no sky picture loads. */
    sky?: [number, number, number];
    /** Strength of the specular-only lamp highlights (0 = off). */
    highlights?: number;
    look?: Look;
    /** Manifest of the PBR texture sets. Default textures/pbr/manifest.json. */
    pbrManifest?: string;
    /**
     * Materials to show as "mirror" / "glass" / "frosted" / "decal" / "emissive[:strength]" /
     * "paint:#hex:roughness:metalness" by Blender material name (".001" numbering ignored).
     */
    surfaces?: Record<string, string>;
    /** Filled from scene.json at start; entries in config.json only add limits/labels. */
    cameras: Record<string, CameraPreset>;
    /** Old camera / view names that still open, e.g. { "window": "blind" } (element or camera id). */
    viewAliases?: Record<string, string>;
    zones: Zone[];
    elements: Element[];
    /** Doorways the camera flies through when it changes rooms (fallback for scene.json). */
    doorways?: BoxData[];
    finishes: Record<string, Finish>;
    /** Category rules that fill the parts' finish lists from the PBR manifest. */
    catalogue?: Catalogue;
    slots: Slot[];
    presets: Record<string, Preset>;
    /** Address parameters of removed slots -> slots that take their value (old share links). */
    legacyParams?: Record<string, string[]>;
    /** Per host slot and option: which anchored options (taps) are allowed (scene.json). */
    tapRules?: Record<string, Record<string, TapRule>>;
    /**
     * Why an anchored option (tap) does not fit, shown under the greyed-out card: host slot -> host option ->
     * text, or -> { "<tap option>": text, "*": text }.
     */
    ruleReasons?: Record<string, Record<string, string | Record<string, string>>>;
    /** Complete styled rooms offered on the overview (?look=<id>). */
    looks?: RoomLook[];
    /** Calls to action in the summary and on the PDF. */
    cta?: Cta[];
}

/** One line of the summary / PDF. */
export interface SummaryLine {
    slot: string;
    group: string;
    name: string;
    finishes: string[];
    price: number;
}
