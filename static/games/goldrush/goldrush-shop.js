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
];

export const shopItem = (id) => SHOP_ITEMS.find((i) => i.id === id) || null;
export const upgradesFor = (tool) => SHOP_ITEMS.filter((i) => i.kind === "upgrade" && i.tool === tool);

/**
 * What an item is for this player right now:
 *   { state: "owned" | "locked" | "available", needs: [{ text, met }], affordable, missing }
 * state = { owned: Set of tool ids, upgrades: Set of ids, hardSeen, cashCents }
 */
export function itemStatus(item, state) {
  const owned = item.kind === "tool" ? state.owned.has(item.tool) : state.upgrades.has(item.id);
  const needs = [];
  const r = item.requires || {};
  for (const t of r.tools || []) needs.push({ text: t === "shovel" ? "Schaufel besitzen" : "Spitzhacke besitzen", met: state.owned.has(t) });
  if (r.hard) needs.push({ text: "auf Stein oder einen Felsbrocken gestoßen", met: !!state.hardSeen });
  const locked = !owned && needs.some((n) => !n.met);
  const missing = Math.max(0, item.price - state.cashCents);
  return { state: owned ? "owned" : locked ? "locked" : "available", needs, affordable: !owned && !locked && missing === 0, missing };
}
