// GoldRush - developer command registry (QA tools).
//
// The developer panel (goldrush-devtools.js) is drawn from this registry: it
// knows nothing about buckets or conveyors. Every phase registers its own
// commands - phase 1-5 in goldrush-devcommands.js; a later phase adds a
// pack the same way, e.g.
//
//   registerDevCommand({
//     id: "sluice.spawn", category: "material", label: "Schleuse aufstellen",
//     available: (ctx) => ctx.game.processing.owned.has("sluice") || "Erst die Schleuse besitzen",
//     run: (ctx) => ctx.actions.spawnSluice(),
//   });
//
// and lists the pack in DEV_PACKS (goldrush-devtools.js). Command fields:
//   id         unique ("<area>.<what>")
//   category   one of DEV_CATEGORIES (or a category registered later)
//   label      button text (German, as the rest of the UI)
//   hint       one line under the button (optional)
//   group      sub-heading inside the category (optional)
//   kind       "button" (default) | "input" | "file" | "toggle" | "choice" | "items" | "info"
//   cheat      true: changes the mine (snapshot first, marks it devModified)
//   confirm    { title, text, ok, danger } - asked before running (destructive things)
//   available  (ctx) => true | "why not" - greyed out with the reason
//   run        (ctx, arg) => { ok, text } | { ok: false, error } (may be async;
//              arg: the typed value for "input", the file's text for "file")
//   input      for kind "input": { label, placeholder, inputmode, button }
//   value/set  for kind "toggle" (boolean) and "choice" (option id): read / change panel state
//   options    for kind "choice": (ctx) => [{ id, label }]
//   rows       for kind "items": (ctx) => [{ id, label, status, sub, actions: [{ id, label, run, cheat, confirm }] }]
//   view       for kind "info": (ctx) => [[label, value], ...]
//   order      sort key inside the category (default: registration order)

export const DEV_CATEGORIES = [
  { id: "quick", label: "Schnelltest" },
  { id: "economy", label: "Wirtschaft" },
  { id: "equipment", label: "Ausrüstung" },
  { id: "material", label: "Material / Processing" },
  { id: "world", label: "Welt" },
  { id: "save", label: "Save / QA" },
  { id: "diag", label: "Diagnose" },
];

class DevCommandRegistry {
  constructor() {
    this.commands = new Map();
    this.categories = DEV_CATEGORIES.map((c) => ({ ...c }));
    this._n = 0;
  }

  register(cmd) {
    if (!cmd || typeof cmd.id !== "string" || !cmd.id) throw new Error("dev command: id fehlt");
    if (!this.categories.some((c) => c.id === cmd.category)) throw new Error(`dev command ${cmd.id}: unbekannte Kategorie ${cmd.category}`);
    const kind = cmd.kind || "button";
    const need = { button: "run", input: "run", file: "run", toggle: "set", choice: "set", items: "rows", info: "view" }[kind];
    if (!need) throw new Error(`dev command ${cmd.id}: unbekannte Art ${kind}`);
    if (typeof cmd[need] !== "function") throw new Error(`dev command ${cmd.id}: ${need} fehlt`);
    this.commands.set(cmd.id, { order: this._n++, ...cmd, kind });
    return cmd.id;
  }

  unregister(id) { return this.commands.delete(id); }

  registerCategory(cat) {
    if (!cat || !cat.id || this.categories.some((c) => c.id === cat.id)) return false;
    this.categories.push({ id: cat.id, label: cat.label || cat.id });
    return true;
  }

  get(id) { return this.commands.get(id) || null; }

  list(category) {
    return [...this.commands.values()].filter((c) => c.category === category).sort((a, b) => a.order - b.order);
  }
}

export const devRegistry = new DevCommandRegistry();
export const registerDevCommand = (cmd) => devRegistry.register(cmd);
export const registerDevCategory = (cat) => devRegistry.registerCategory(cat);
