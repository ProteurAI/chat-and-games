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
//
// Phase 9 - the mechanised claim: a prospecting kit (samples, notebook, flags -
// finding the rich ground), then machines that need money AND progress on the
// mountain contract (requires.mountainPct, goldrush-contract.js): a mine intake
// hopper with a conveyor to the plant, a trommel screen over the bulk hopper, a
// wide high-flow sluice, a compact excavator and its hydraulic breaker. Each
// one moves the bottleneck: hauling -> screening -> washing -> digging -> rock.

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
  // Prompt 10 (human QA): the shovel grows in steps you see - a bigger blade (+28 % a stroke), the reinforced
  // edge (+10 %), at last the pro shovel: together ~+52 % over the basic one (the excavator stays a big jump)
  {
    id: "shovel.wide", kind: "upgrade", tool: "shovel", label: "Großes Schaufelblatt", price: 1600,
    text: "Ein breiteres, längeres Blatt: gut ein Viertel mehr Erde pro Stich – etwas schwerer, holt minimal langsamer aus.",
    effect: { volMul: 1.28, strikeMul: 1.05, followMul: 1.04 },
    requires: { tools: ["shovel"] },
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
    id: "shovel.pro", kind: "upgrade", tool: "shovel", label: "Profi-Schaufel", price: 9000,
    text: "Glasfaserstiel, gehärtetes Blatt: noch einmal etwas mehr pro Stich und ruhiger in der Hand. Mit großem Blatt und Kante rund die Hälfte mehr als die einfache Schaufel.",
    effect: { volMul: 1.06, strikeMul: 0.96, effMul: [1, 1.03, 1.03, 1] },
    requires: { tools: ["shovel"], upgrades: ["shovel.wide", "shovel.blade", "shovel.handle"] },
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
    id: "bucket.xl", kind: "upgrade", tool: "bucket", label: "Zinkeimer", price: 7000,
    text: "Ein verzinkter 19-Liter-Eimer mit Holzgriff: noch weniger Wege – voll ein ordentliches Gewicht.",
    effect: { capacityMul: 1.9 },
    requires: { equipment: ["bucket"], upgrades: ["bucket.large"] },
  },
  {
    id: "wheelbarrow", kind: "equipment", label: "Schubkarre", price: 30000,
    text: "Fasst rund 85 Liter. Stell sie neben dich und grab hinein, dann schieb sie zum Waschplatz – oder später zum Trichter der Waschrinne und kipp sie aus. Voll ist sie spürbar schwer, bergauf erst recht.",
    requires: { equipment: ["bucket"] },
  },
  // Prompt 10 (human QA): the barrow in steps - it rolls easier, takes bumps better, at last carries more
  {
    id: "barrow.bearings", kind: "upgrade", tool: "wheelbarrow", label: "Kugellager & Gummigriffe", price: 9000,
    text: "Ein Rad auf Kugellagern, gummierte Griffe: rollt leichter an, verliert auf Kies weniger Schwung.",
    effect: { accelMul: 1.15, dragMul: 0.65 },
    requires: { equipment: ["wheelbarrow"] },
  },
  {
    id: "barrow.wheel", kind: "upgrade", tool: "wheelbarrow", label: "Breiter Luftreifen", price: 14000,
    text: "Ein breiter, weicher Luftreifen: Kanten, Grabspuren und Kies schütteln die volle Karre deutlich weniger.",
    effect: { roughMul: 0.5 },
    requires: { equipment: ["wheelbarrow"] },
  },
  {
    id: "barrow.tray", kind: "upgrade", tool: "wheelbarrow", label: "Aufsatzbretter", price: 26000,
    text: "Bretter rund um die Mulde: fasst 110 statt 85 Liter – voll ist sie entsprechend schwerer.",
    effect: { capacityMul: 1.3 },
    requires: { equipment: ["wheelbarrow"], upgrades: ["barrow.wheel"] },
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
  {
    id: "prospectkit", kind: "equipment", label: "Probenset", price: 4500,
    text: "Sechs Probenbeutel, eine kleine Kelle, zwölf nummerierte Fähnchen und ein Notizbuch: [R] nimmt genau unter dem Fadenkreuz eine Probe von etwa einem Liter, am Waschtrog wäscht du sie schnell in der Pfanne aus – das Notizbuch hält fest, wie viel Gold pro Liter drin war. [F] steckt ein Fähnchen.",
    requires: { equipment: ["pan"] },
  },
  {
    id: "conveyor", kind: "equipment", label: "Förderband mit Aufgabetrichter", price: 130000,
    text: "Ein Stahltrichter am Westfuß des Bergs (240 l) und ein Gurtförderband, das ihn in den Vorratstrichter entleert: grab direkt in den Trichter oder kipp die Schubkarre hinein – der weite Weg die Rampe hinauf entfällt. Läuft, staut sich, wenn der Vorratstrichter voll ist, und läuft von selbst weiter.",
    requires: { equipment: ["bulkhopper"], mountainPct: 0.9 },
  },
  {
    id: "trommel", kind: "equipment", label: "Trommelsieb", price: 150000,
    text: "Eine sich drehende Siebtrommel mit Sprühdüsen am Kopf des Förderbands: Wasser aus dem Tank wäscht das Material, Steine und Klumpen fallen am Ende als Überkorn auf einen Haufen, nur das Feine (mit fast allem Gold) geht in den Vorratstrichter – die Rinne bekommt weniger Ballast.",
    requires: { equipment: ["conveyor"], mountainPct: 1.1 },
  },
  {
    id: "sluice.highflow", kind: "upgrade", tool: "sluice", label: "Hochleistungsrinne", price: 100000,
    text: "Eine breite Rinne mit tiefen Riffeln und ein weiterer Dosierauslass: gesiebt verarbeitet sie bis zu 32 Liter pro Minute statt 14 – und die Riffel fassen mehr, bevor sie gereinigt werden müssen.",
    requires: { equipment: ["trommel"] },
  },
  {
    id: "excavator", kind: "equipment", label: "Kompaktbagger", price: 200000,
    text: "Ein kleiner Kettenbagger mit 45-Liter-Löffel: einsteigen, an den Hang fahren, der Löffel gräbt in einem Zug so viel wie ein paar Dutzend Schaufelstiche – und kippt in den Aufgabetrichter, die Schubkarre oder auf die Abraumhalde. Festen Fels bricht er nicht.",
    requires: { equipment: ["conveyor"], mountainPct: 1.45 },
  },
  {
    id: "excavator.breaker", kind: "upgrade", tool: "excavator", label: "Hydraulikhammer", price: 240000,
    text: "Ein Anbauhammer für den Bagger (am Bagger gegen den Löffel tauschen): bricht festen Fels und Felsbrocken in Geröll, das der Löffel dann aufnimmt.",
    requires: { equipment: ["excavator"], mountainPct: 2.0 },
  },
  // Prompt 10 - the working mine: logistics and processing. The excavator digs onto the raw stockpile, the
  // loader carries it to the plant; the plant grows to keep up (prices / gates: the A10-E10 benchmark)
  {
    id: "loader", kind: "equipment", label: "Kompakt-Radlader", price: 280000,
    text: "Ein knickgelenkter Radlader mit einer Schaufel von gut 250 Litern: holt das Rohmaterial vom Haufen, den der Bagger aufschüttet, und kippt es in den Aufgabetrichter – oder räumt Überkorn und Tailings weg. Er gräbt keinen gewachsenen Berg; das bleibt die Arbeit des Baggers.",
    requires: { equipment: ["excavator"], mountainPct: 2.3 },
  },
  {
    id: "conveyor.fast", kind: "upgrade", tool: "conveyor", label: "Förderband-Ausbau", price: 160000,
    text: "Ein zweiter, stärkerer Antrieb am Kopf, Leitbleche an der Aufgabe und ein Aufsatz für den Trichter: das Band läuft schneller und trägt mehr – gut 130 statt 64 Liter pro Minute, der Trichter fasst 420 statt 240 Liter (eine volle Laderschaufel passt hinein).",
    requires: { equipment: ["conveyor", "loader"] },
  },
  {
    id: "autominer", kind: "equipment", label: "Bergseiten-Abbaugerät", price: 300000,
    text: "Eine kleine Raupen-Abbaueinheit mit Hydraulikarm und Schneidkopf: an den Fuß der Bergflanke gestellt, baut sie dort selbst ab – ein Stück von gut zweieinhalb Metern Breite – und gibt das Material über ihr Band in den Aufgabetrichter oder auf den Rohhaufen. Hartgestein schafft sie nicht. Ist ihr Abschnitt leer, muss sie versetzt werden.",
    requires: { equipment: ["excavator", "conveyor"], mountainPct: 3.0 },
  },
  {
    id: "washplant", kind: "equipment", label: "Waschanlage", price: 320000,
    text: "Ein Verteilerkasten über den Köpfen von drei breiten Rinnen – die Hochleistungsrinne wird die erste davon: der Dosierer gibt bis zu 120 Liter pro Minute auf, gut drei Viertel des Feingolds bleiben in den Riffeln. Beim Reinigen landet das Konzentrat in einer Wanne an der Anlage – mit dem Eimer abholen, am Waschtrog auswaschen.",
    requires: { equipment: ["trommel", "loader"], upgrades: ["sluice.highflow"] },
  },
  {
    id: "washplant.recovery", kind: "upgrade", tool: "washplant", label: "Streckmetall-Riffel & Moosmatten", price: 950000,
    text: "Streckmetall über dichten Moosmatten in allen drei Rinnen: hält mehr vom feinen Gold – gut 84 statt 77 Prozent.",
    requires: { equipment: ["washplant"], mountainPct: 8.0 },
  },
  {
    id: "trommel.fast", kind: "upgrade", tool: "trommel", label: "Trommel-Ausbau", price: 180000,
    text: "Ein zweiter Antrieb und ein zweiter Sprühbalken: die Trommel dreht schneller und wäscht doppelt so viel – 120 statt 60 Liter pro Minute.",
    requires: { equipment: ["trommel", "loader"] },
  },
];

export const shopItem = (id) => SHOP_ITEMS.find((i) => i.id === id) || null;
export const upgradesFor = (tool) => SHOP_ITEMS.filter((i) => i.kind === "upgrade" && i.tool === tool);
export const EQUIPMENT = SHOP_ITEMS.filter((i) => i.kind === "equipment").map((i) => i.id);
const NEED_TEXT = { shovel: "Schaufel besitzen", pickaxe: "Spitzhacke besitzen", bucket: "Eimer besitzen", pan: "Goldpfanne besitzen", classifier: "Sieb besitzen",
  wheelbarrow: "Schubkarre besitzen", sluice: "Waschrinne besitzen", bulkhopper: "Vorratstrichter besitzen", feeder: "Dosierer besitzen",
  prospectkit: "Probenset besitzen", conveyor: "Förderband besitzen", trommel: "Trommelsieb besitzen", excavator: "Kompaktbagger besitzen", loader: "Radlader besitzen",
  washplant: "Waschanlage besitzen" };
const pct = (v) => v.toFixed(v < 10 ? 2 : 1).replace(".", ",").replace(/,?0+$/, "").replace(/,$/, "");

/**
 * What an item is for this player right now:
 *   { state: "owned" | "locked" | "available", needs: [{ text, met }], affordable, missing }
 * state = { owned: Set of tool ids, upgrades: Set of ids, equipment: Set of ids, hardSeen, cashCents,
 *           mountainPct (phase 9: the contract - share of the original mountain removed, %) }
 */
export function itemStatus(item, state) {
  const eq = state.equipment || new Set();
  const owned = item.kind === "tool" ? state.owned.has(item.tool) : item.kind === "equipment" ? eq.has(item.id) : state.upgrades.has(item.id);
  const needs = [];
  const r = item.requires || {};
  for (const t of r.tools || []) needs.push({ text: NEED_TEXT[t], met: state.owned.has(t) });
  for (const t of r.equipment || []) needs.push({ text: NEED_TEXT[t], met: eq.has(t) });
  for (const u of r.upgrades || []) { const it = SHOP_ITEMS.find((i) => i.id === u); needs.push({ text: `${it ? it.label : u} besitzen`, met: state.upgrades.has(u) }); }
  if (r.hard) needs.push({ text: "auf Stein oder einen Felsbrocken gestoßen", met: !!state.hardSeen });
  if (r.mountainPct) {
    const now = state.mountainPct || 0;
    needs.push({ text: `Bergauftrag: ${pct(r.mountainPct)} % des Bergs abgetragen (jetzt ${pct(Math.floor(now * 100) / 100)} %)`, met: now >= r.mountainPct, contract: true });
  }
  const locked = !owned && needs.some((n) => !n.met);
  const missing = Math.max(0, item.price - state.cashCents);
  return { state: owned ? "owned" : locked ? "locked" : "available", needs, affordable: !owned && !locked && missing === 0, missing };
}
