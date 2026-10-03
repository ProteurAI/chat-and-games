// GoldRush - the supply shed's catalogue (early game). A few relevant
// decisions, not a store: two tools and two small upgrades for each of
// them. Every text says what the thing really does - no "+20 power".
//
// Prices are integer cents, balanced with the canonical benchmark
// (tests/e2e/goldrush_bench.py, 100 seeds x 90 min, real sales trips):
// the shovel is earned after ~15-25 minutes of hand work, the pickaxe some
// 15-30 minutes of shovel work later; upgrades sit in between, so there is
// always a choice - improve the shovel now or save on. No timers, no
// levels, no cooldowns: only work, finds and prices slow you down.
//
// Upgrades are fine-tuning: all of them together make a tool ~1.2x
// (shovel) - the big steps come later from new kinds of tools, processing
// and machines.
//
// Phase 5 - processing (goldrush-processing.js): a bucket to carry ground
// to the wash place, the gold pan that washes the fine gold out of it, the
// classifier (a screen) that takes the stones out first, and one small
// upgrade each for bucket and pan. They improve RECOVERY - how much of the
// gold that is already in the ground comes back out - never "luck".
//
// Phase 6 - primitive mechanisation: a wheelbarrow (transport: ~85 l a
// trip) and a sluice box by the water tank (continuous washing while you
// work on), with two small sluice upgrades. They raise THROUGHPUT - litres
// per minute - far more than gold per litre; real machines come later.
//
// Phase 7 - first automation (goldrush-automation.js): a bulk hopper at the
// sluice's head that stores several barrow loads, and a motorised feeder that
// doses it into the sluice on its own, with one small upgrade each. They save
// ATTENTION - the sluice keeps running while you dig - not gold per litre.

export const SHOP_ITEMS = [
  {
    id: "shovel", kind: "tool", tool: "shovel", label: "Schaufel", price: 1100,
    text: "Bewegt pro Stich etwa so viel wie ein Dutzend Handgriffe - rund fünfmal so viel Erde pro Minute.",
  },
  {
    id: "pickaxe", kind: "tool", tool: "pickaxe", label: "Spitzhacke", price: 4800,
    text: "Bricht Felsbrocken und festen Stein, lockert harte Erde und Kies - dort arbeiten Hand und Schaufel danach deutlich leichter.",
    requires: { tools: ["shovel"], hard: true },
  },
  {
    id: "shovel.blade", kind: "upgrade", tool: "shovel", label: "Verstärktes Schaufelblatt", price: 1900,
    text: "Ein aufgenieteter Stahlrand: etwa 10 % mehr Erde pro Stich, beißt besser in Kies und harte Erde.",
    effect: { volMul: 1.1, effMul: [1, 1.08, 1.1, 1] },
    requires: { tools: ["shovel"] },
  },
  {
    id: "shovel.handle", kind: "upgrade", tool: "shovel", label: "Leichter Eschenstiel", price: 2600,
    text: "Leichter in der Hand: Ausholen, Kippen und Zurückziehen gehen schneller - etwa 7 % mehr Stiche pro Minute.",
    effect: { strikeMul: 0.98, followMul: 0.9 },                       // cycle 1,08 s -> ~1,01 s
    requires: { tools: ["shovel"] },
  },
  {
    id: "pickaxe.tip", kind: "upgrade", tool: "pickaxe", label: "Gehärtete Spitze", price: 2400,
    text: "Gehärteter Stahl: ein Viertel mehr Schaden an Felsbrocken, schlägt festen Stein schneller ab.",
    effect: { rockMul: 1.25, effMul: [1, 1, 1, 1.25] },
    requires: { tools: ["pickaxe"] },
  },
  {
    id: "pickaxe.head", kind: "upgrade", tool: "pickaxe", label: "Schwerer Kopf", price: 3400,
    text: "Mehr Gewicht vorn: trifft Fels deutlich härter und lockert weiter - holt dafür etwas langsamer aus.",
    effect: { rockMul: 1.4, strikeMul: 1.12, loosenMul: 1.2 },
    requires: { tools: ["pickaxe"] },
  },
  {
    id: "bucket", kind: "equipment", label: "Eimer", price: 1400,
    text: "Fasst rund 10 Liter. Stell ihn neben dich und grab hinein – so trägst du goldhaltige Erde zum Waschplatz, statt sie wegzuwerfen.",
    requires: { tools: ["shovel"] },
  },
  {
    id: "pan", kind: "equipment", label: "Goldpfanne", price: 11000,
    text: "Am Waschplatz schwenkst du Erde aus dem Eimer im Wasser: das Leichte geht über den Rand, Gold bleibt liegen – auch das feine, das beim Graben verloren geht.",
    requires: { equipment: ["bucket"] },
  },
  {
    id: "classifier", kind: "equipment", label: "Sieb", price: 16000,
    text: "Ein Rüttelsieb über der Wanne: Steine und Klumpen bleiben oben, durch fällt ein feines Konzentrat – weniger zu waschen, und die Pfanne hält mehr vom Feingold.",
    requires: { equipment: ["pan"] },
  },
  {
    id: "pan.riffles", kind: "upgrade", tool: "pan", label: "Riffelpfanne", price: 6000,
    text: "Eingepresste Rillen im Pfannenrand halten feines Gold beim Schwenken fest – etwa ein Achtel mehr Feingold aus jeder Pfanne.",
    effect: { recoveryMul: 1.12 },
    requires: { equipment: ["pan"] },
  },
  {
    id: "bucket.large", kind: "upgrade", tool: "bucket", label: "Großer Eimer", price: 4000,
    text: "Ein 14-Liter-Eimer: weniger Wege zum Waschplatz – dafür voll spürbar schwerer.",
    effect: { capacityMul: 1.4 },
    requires: { equipment: ["bucket"] },
  },
  {
    id: "wheelbarrow", kind: "equipment", label: "Schubkarre", price: 30000,
    text: "Fasst rund 85 Liter. Stell sie neben dich und grab hinein, dann schieb sie zum Waschplatz – oder später zum Trichter der Waschrinne und kipp sie aus. Voll ist sie spürbar schwer, bergauf erst recht.",
    requires: { equipment: ["bucket"] },
  },
  {
    id: "sluice", kind: "equipment", label: "Waschrinne", price: 48000,
    text: "Eine Holzrinne mit Riffelmatte am Wassertank: Material in den Trichter, Wasser an – sie wäscht von selbst, während du weitergräbst. Die Riffel halten das Gold; ab und zu ausbürsten und das Schwerkonzentrat in der Pfanne fertig waschen.",
    requires: { equipment: ["pan"] },
  },
  {
    id: "sluice.hopper", kind: "upgrade", tool: "sluice", label: "Großer Trichter", price: 38000,
    text: "Ein höherer Aufgabetrichter: fasst 90 statt 50 Liter – eine ganze Schubkarre, die Rinne läuft länger ohne dich.",
    requires: { equipment: ["sluice"] },
  },
  {
    id: "sluice.mat", kind: "upgrade", tool: "sluice", label: "Moosmatte", price: 85000,
    text: "Eine Matte mit feinem Flor unter den Riffeln: hält mehr vom Feingold fest – etwa ein Sechstel mehr aus jeder Ladung.",
    effect: { capture: 0.75 },
    requires: { equipment: ["sluice"] },
  },
  {
    id: "bulkhopper", kind: "equipment", label: "Vorratstrichter", price: 105000,
    text: "Ein großer Stahltrichter auf Holzgerüst am Kopf der Waschrinne, mit Rampe: fasst rund 360 Liter – über vier Schubkarren. Oben hineinkippen; am Kontrollpfosten den Schieber ziehen, und er füllt den Trichter der Rinne nach.",
    requires: { equipment: ["sluice"] },
  },
  {
    id: "feeder", kind: "equipment", label: "Dosierer", price: 120000,
    text: "Eine Rüttelrinne mit Motor unter dem Vorratstrichter: führt das Material gleichmäßig in die Waschrinne, von selbst – so gefüttert verkraftet die Rinne 12 statt 10 Liter pro Minute. Auf AUTO läuft er, solange das Wasser an ist; ist der Trichter der Rinne voll, wartet er.",
    requires: { equipment: ["bulkhopper"] },
  },
  {
    id: "bulk.extension", kind: "upgrade", tool: "bulkhopper", label: "Aufsatzbretter", price: 100000,
    text: "Ein Bretterkranz auf dem Trichterrand: 540 statt 360 Liter – die Rinne läuft länger, ohne dass du nachfüllst.",
    requires: { equipment: ["bulkhopper"] },
  },
  {
    id: "feeder.fine", kind: "upgrade", tool: "feeder", label: "Feindosierung", price: 140000,
    text: "Ein genauer einstellbarer Auslass: 14 statt 12 Liter pro Minute, ohne die Rinne zu überladen – mehr nimmt sie nicht.",
    requires: { equipment: ["feeder"] },
  },
];

export const shopItem = (id) => SHOP_ITEMS.find((i) => i.id === id) || null;
export const upgradesFor = (tool) => SHOP_ITEMS.filter((i) => i.kind === "upgrade" && i.tool === tool);
export const EQUIPMENT = SHOP_ITEMS.filter((i) => i.kind === "equipment").map((i) => i.id);
const NEED_TEXT = { shovel: "Schaufel besitzen", pickaxe: "Spitzhacke besitzen", bucket: "Eimer besitzen", pan: "Goldpfanne besitzen", classifier: "Sieb besitzen",
  wheelbarrow: "Schubkarre besitzen", sluice: "Waschrinne besitzen", bulkhopper: "Vorratstrichter besitzen", feeder: "Dosierer besitzen" };

/**
 * What an item is for this player right now:
 *   { state: "owned" | "locked" | "available", needs: [{ text, met }], affordable, missing }
 * state = { owned: Set of tool ids, upgrades: Set of ids, equipment: Set of ids, hardSeen, cashCents }
 */
export function itemStatus(item, state) {
  const eq = state.equipment || new Set();
  const owned = item.kind === "tool" ? state.owned.has(item.tool) : item.kind === "equipment" ? eq.has(item.id) : state.upgrades.has(item.id);
  const needs = [];
  const r = item.requires || {};
  for (const t of r.tools || []) needs.push({ text: NEED_TEXT[t], met: state.owned.has(t) });
  for (const t of r.equipment || []) needs.push({ text: NEED_TEXT[t], met: eq.has(t) });
  if (r.hard) needs.push({ text: "auf Stein oder einen Felsbrocken gestoßen", met: !!state.hardSeen });
  const locked = !owned && needs.some((n) => !n.met);
  const missing = Math.max(0, item.price - state.cashCents);
  return { state: owned ? "owned" : locked ? "locked" : "available", needs, affordable: !owned && !locked && missing === 0, missing };
}
