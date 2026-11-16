// extension.js — Piece 2: the VS Code wiring for Protoplanet.
//
// This file only talks to VS Code (events, webview, status bar,
// globalState). All the pet logic lives in petLogic.js, which is pure
// JS and tested in plain Node (test-pet.js). Keep it that way: if you
// add a rule about how the pet behaves, it goes in petLogic.js, not here.
//
// Ambient rule: this extension NEVER interrupts coding. Evolutions
// show in the pet window and status bar. The exceptions (Devon,
// Nov 12 — round 6): three short toasts — a stage-up, a birth, and a
// mutation at birth — plus the one-time first-run starter pick, the
// "New planet" confirmation, and the one-time maxed-planet prompt.
// Everything else stays out of the way while typing.

'use strict';

const os = require('os');
const vscode = require('vscode');
const Planet = require('./planet.js');
const Logic = require('./petLogic.js');

const STATE_KEY = 'protoplanet.state';
const VIEW_ID = 'protoplanet.petView';
const FONT_STACK = "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

// ---------------------------------------------------------------------------
// The app: owns the state, the status bar, the sidebar view, and saving.
// ---------------------------------------------------------------------------
class ProtoplanetApp {
  constructor(context) {
    this.context = context;
    // Round 16 overhaul — deserializeState returns a result object:
    // { state, backupJson, notice, migrated }. A migration or an
    // unreadable save carries the ORIGINAL serialized JSON in
    // backupJson — stash it under the backup key BEFORE any saveNow()
    // can overwrite STATE_KEY (load runs in the constructor, before
    // the first save, so doing it here is safe). The constructor
    // can't await, so the write is fire-and-forget like saveNow().
    // The notice fires once, only when a backup was needed.
    const loaded = Logic.deserializeState(context.globalState.get(STATE_KEY, ''));
    if (loaded.backupJson !== null) {
      context.globalState.update('protoplanet.state.backup.v1', loaded.backupJson);
    }
    this.state = loaded.state;
    if (loaded.notice) this.notify(loaded.notice);
    // Birth notifications (round 6): the key of the planet already
    // notified — seed:generation — so a reload never re-toasts an old
    // hatch. Set from the LOADED state before the first pushState();
    // a first run starts at null (no planet yet).
    this.lastBirthKey = this.state.current ? `${this.state.current.seed}:${this.state.generation}` : null;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'protoplanet.showPet';
    this.statusBar.tooltip = 'Protoplanet — click to show your planet';
    this.statusBar.show();
    this.viewProvider = new PetViewProvider(this);
    this.systemPanel = null; // the Solar System panel (step 4), or null
    this.prestigePanel = null; // the Prestige / fusion panel (step 4b), or null
    this.prestigeResult = null; // the last fusion result, shown until dismissed
    this.mutationFlash = null; // round 10: the mutation id to flash gold in the sidebar on the next push (birth or apply), then cleared
    this.sharePanel = null; // the Share card panel (P0, Nov 12), or null
    this.saveTimer = null;
    context.subscriptions.push(this.statusBar);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.viewProvider)
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.showPet', () => this.showPet())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.openSolarSystem', () => this.openSolarSystem())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.openPrestige', () => this.openPrestige())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.sharePlanet', () => this.openShare())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.hatchFromSeed', () => this.hatchFromSeed())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.newPlanet', () => this.newPlanet())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.applyMineral', () => this.applyMineral())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.salvagePlanet', () => this.salvagePlanet())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.prestige', () => this.prestige())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.viewMinerals', () => this.viewMinerals())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.openShop', () => this.openShop())
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDidChangeTextDocument(e))
    );
    this.pushState();
  }

  // -- state ---------------------------------------------------------------

  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    // globalState.update is async; we don't wait — a save is also
    // triggered on every stage change / new planet.
    this.context.globalState.update(STATE_KEY, Logic.serializeState(this.state));
  }

  scheduleSave(immediate) {
    if (immediate) { this.saveNow(); return; }
    if (this.saveTimer) return; // one pending save is enough
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, Logic.CONFIG.SAVE_DEBOUNCE_MS);
  }

  // -- typing = XP ----------------------------------------------------------

  onDidChangeTextDocument(e) {
    if (!this.state.current) return; // no planet yet (first-run pick pending)
    if (!Logic.shouldCountDocument(e.document.uri.scheme)) return;
    // Undo/redo replays old edits — counting them would double-count XP.
    if (e.reason === vscode.TextDocumentChangeReason.Undo ||
        e.reason === vscode.TextDocumentChangeReason.Redo) return;
    const n = Logic.countInsertedChars(e.contentChanges);
    if (n <= 0) return;
    const res = Logic.applyXp(this.state, n, Logic.randomSeed);
    // Stage-up toast (round 6 — Devon): edge-triggered — applyXp
    // reports the crossing exactly once, so ordinary typing inside a
    // stage never toasts, and a reload never replays one. A big paste
    // earns no XP at all (round 11), so it never jumps stages.
    if (res.stageChanged) this.notifyStageUp(res.stageIdx);
    // Round 11 — a story event is a rare surprise worth one toast:
    // "✦ Something happened on GJ-364c: Meteor Impact".
    // Edge-triggered like the stage-up toast (applyXp reports it
    // exactly once), and the event itself is journal-only — no
    // visual change to the planet.
    if (res.event) this.notify(`✦ Something happened on ${Logic.nameForPlanet(this.state.current)}: ${res.event.title}`);
    this.pushState();
    // Stage changes save immediately; plain typing is debounced so
    // we don't write to disk on every keystroke.
    this.scheduleSave(res.stageChanged || res.rebirthed);
    // First time the planet maxes out (Civilization, 2200+ XP):
    // offer a fresh planet. Once per planet — XP only ever rises,
    // so becameMax fires on the one transition. Optional: the maxed
    // planet keeps growing either way.
    if (res.becameMax) this.promptMaxedPlanet();
  }

  // -- notifications (round 6, Nov 12 — Devon) ------------------------------
  // Three short toasts, each once per event. The text lives in
  // petLogic.js (pure builders); this is only the showing.

  notify(text) {
    vscode.window.showInformationMessage(text);
  }

  // Stage-up: "GJ-364c reached Molten!". Fires from the typing path
  // on applyXp's edge trigger. Reaching Civilization ALSO fires the
  // one-time maxed-planet prompt below — separate toast, separate
  // prompt, both once.
  notifyStageUp(stageIdx) {
    const cur = this.state.current;
    if (!cur) return;
    this.notify(Logic.stageUpMessage(cur, stageIdx));
  }

  // Round 11 — the archive is full (200/200): archiving refuses
  // instead of silently deleting the oldest planet. One shared
  // message for every birth / switch / fuse path that hits it.
  notifyArchiveFull() {
    this.notify(`Archive is full (${(this.state.past || []).length}/${Logic.CONFIG.PAST_LIMIT}) — salvage an archived planet from the Index to make room.`);
  }

  // Round 14 — a birth refused for lack of a Birth mineral. One
  // shared message for every birth path that hits it (new planet,
  // seed hatch, maxed prompt, post-destroy prompt, prestige).
  notifyNeedPlainMineral() {
    this.notify(Logic.needPlainMineralMessage());
  }

  // Round 14 — a salvage that lost mutation minerals (grow-it-first):
  // one plain message naming what was lost and why. Silent when
  // nothing was lost.
  notifySalvageLoss(planet, res) {
    if (!res || !res.ok) return;
    const msg = Logic.salvageLostMessage(planet, res.lostMutations);
    if (msg) this.notify(msg);
  }

  // The identity of the living planet — seed:generation. A new life
  // always bumps the generation, so the key changes on every birth
  // even if a seed ever repeated. The generation is the planet's own
  // stamped field when it has one (round 7) — a reactivated planet
  // keeps its generation, so its key stays its own.
  birthKey() {
    const cur = this.state.current;
    return cur ? `${cur.seed}:${Number.isInteger(cur.generation) ? cur.generation : this.state.generation}` : null;
  }

  // Birth toasts: "GJ-364c was born!" plus "…was born with a mutation:
  // Blood Moon!" when it was born with one, plus a set toast when the
  // birth completes a family ("GJ-364c is the Moon Lord!"). Detected
  // HERE, in pushState, by planet identity — every birth path (first
  // run, new planet, recycle, prestige, seed hatch) funnels through
  // pushState right after the birth, so no path can miss it and no
  // call site needs its own notify call. Reload-safe: lastBirthKey
  // starts at the loaded planet's key (set in the constructor), so a
  // restart never re-toasts an old birth. A newborn with a mutation
  // also flashes gold in the sidebar (the reveal moment) — the flag
  // rides the same push and clears right after.
  maybeNotifyBirth() {
    const key = this.birthKey();
    if (key && key !== this.lastBirthKey) {
      this.lastBirthKey = key;
      // Round 16 overhaul — the mutation-at-birth toast gets a ✦
      // prefix ("✦ <planet> was born with a mutation: Green Moon!").
      // The plain birth toast is unchanged. Matched by identity
      // against mutationMessage, not by substring.
      const mutMsg = Logic.mutationMessage(this.state.current);
      for (const msg of Logic.birthNotifications(this.state.current)) {
        this.notify(mutMsg && msg === mutMsg ? `✦ ${msg}` : msg);
      }
      const muts = (this.state.current && this.state.current.mutations) || [];
      if (muts.length > 0) this.mutationFlash = muts[0];
    } else if (!key) {
      this.lastBirthKey = null;
    }
  }

  // -- commands --------------------------------------------------------------

  async showPet() {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async newPlanet() {
    const answer = await vscode.window.showWarningMessage(
      'Start a fresh planet? Your current planet will be kept in your collection. Costs 1 Birth mineral (first planet free).',
      { modal: true },
      'Yes, new planet'
    );
    if (answer !== 'Yes, new planet') return;
    const res = Logic.newPlanet(this.state, Logic.randomSeed);
    if (!res.ok) {
      if (res.reason === 'archive full') this.notifyArchiveFull();
      else if (res.reason === 'no plain mineral') this.notifyNeedPlainMineral();
      return;
    }
    this.saveNow();
    this.pushState();
  }

  // "Hatch from seed" (Nov 12 — Devon): hatch a planet from a
  // shared seed number — the seed's base planet, mutations stripped,
  // so nobody gets your rare mutated planet just by pasting its
  // seed. Input box for the seed, then the same modal confirm as
  // New planet (the current planet is archived into the collection).
  // User-invoked from the Command Palette, so the input box and the
  // confirm are fine — the no-popups rule is about typing, and this
  // never fires while typing. No info popup: the result shows in the
  // pet window and status bar.
  async hatchFromSeed() {
    const raw = await vscode.window.showInputBox({
      prompt: 'Protoplanet: hatch a planet from a shared seed',
      placeHolder: 'Seed, e.g. 805839337 or 948502300-icy',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v.trim()) return null;
        const r = Logic.parseSeedInput(v);
        return r.ok ? null : r.reason;
      },
    });
    if (raw === undefined) return; // dismissed
    const parsed = Logic.parseSeedInput(raw);
    if (!parsed.ok) return; // validateInput already rejected it; defensive
    const shown = parsed.terrain ? `${parsed.seed}-${parsed.terrain}` : String(parsed.seed);
    const answer = await vscode.window.showWarningMessage(
      `Hatch the planet from seed ${shown}? Your current planet will be kept in your collection. The hatched planet is the seed's base planet — it never carries mutations. Costs 1 Birth mineral (first planet free).`,
      { modal: true },
      'Yes, hatch it'
    );
    if (answer !== 'Yes, hatch it') return;
    const hatchRes = Logic.hatchFromSeed(this.state, parsed.seed, parsed.terrain);
    if (!hatchRes.ok) {
      if (hatchRes.reason === 'archive full') this.notifyArchiveFull();
      else if (hatchRes.reason === 'no plain mineral') this.notifyNeedPlainMineral();
      return;
    }
    this.saveNow();
    this.pushState();
  }

  // The ONE exception to the no-popups-while-typing rule (Devon,
  // Nov 12): the planet just reached Civilization — fully evolved.
  // A single non-modal prompt offers a fresh planet; "Keep growing"
  // just closes it, and the maxed planet keeps gaining XP either way.
  // The new planet goes through the same flow as the command (the
  // current planet is kept in the collection).
  async promptMaxedPlanet() {
    const answer = await vscode.window.showInformationMessage(
      'Your planet reached Civilization — fully evolved! It keeps growing with every character. Start a fresh planet? Your current planet will be kept in your collection.',
      'Start a new planet',
      'Keep growing'
    );
    if (answer !== 'Start a new planet') return;
    const maxedRes = Logic.newPlanet(this.state, Logic.randomSeed);
    if (!maxedRes.ok) {
      if (maxedRes.reason === 'archive full') this.notifyArchiveFull();
      else if (maxedRes.reason === 'no plain mineral') this.notifyNeedPlainMineral();
      return;
    }
    this.saveNow();
    this.pushState();
  }

  // -- step 2 commands: minerals, salvage/recycle, prestige --------------
  // All three are user-invoked (Command Palette), so a QuickPick or a
  // confirmation is fine — the no-popups rule is about typing, and
  // these never fire while typing. Results surface in the pet window
  // and status bar, never as a notification.

  // Round 17 fix A — the shared apply confirm, used by both the
  // "Apply a mineral" command and the inventory tap. The confirm
  // names the CURRENTLY GROWING planet (state.current — no picker:
  // to apply to another planet, grow it first) and states the 50%
  // odds from the same helper the roll uses — never a restated 50%.
  // Cancel consumes nothing: the flip only happens after "Apply".
  // Duplicate protection lives in Logic.attemptMutation (blocked,
  // mineral NOT consumed); the callers filter duplicates first.
  async confirmAndApplyMineral(mineralId, mutName) {
    const odds = Logic.applyOdds();
    const planetName = Logic.nameForPlanet(this.state.current);
    const confirm = await vscode.window.showWarningMessage(
      `Apply ${mutName} to ${planetName} — your growing planet? ${Logic.formatOdds(odds.success)} success, ${Logic.formatOdds(odds.failure)} failure. Mineral is consumed either way.`,
      { modal: true },
      'Apply',
      'Cancel'
    );
    if (confirm !== 'Apply') return;
    const res = Logic.attemptMutation(this.state, mineralId);
    if (!res.ok) {
      vscode.window.showInformationMessage('That mineral can\'t go on this planet anymore.');
      return;
    }
    if (res.success) {
      // The sidebar flashes gold + flickers once on the new mutation
      // (the reveal moment) — the flag rides the next push, then
      // clears so typing never re-flashes it.
      this.mutationFlash = res.mutationId;
      this.notify(`✦ ${res.mutationName} took hold on ${Logic.nameForPlanet(this.state.current)}!`);
      for (const setId of (res.setsCompleted || [])) {
        const msg = Logic.setMessage(this.state.current, setId);
        if (msg) this.notify(msg);
      }
    } else {
      this.notify(`The ${res.mutationName} mineral fizzled out.`);
    }
    this.saveNow();
    this.pushState();
  }

  // Round 17 fix L — the NEVER-auto-apply rule, shared by the
  // "Apply a mineral" command and the inventory tap: the mineral
  // picker ALWAYS appears, even with exactly one mineral — no
  // single-item shortcut, ever — and it ALWAYS lists every mineral,
  // Birth included ("Pays for 1 birth — cannot be applied"), never
  // a filtered list that can come up empty. Tapping a Birth mineral
  // shows the guidance copy and consumes nothing; tapping a
  // Mutation mineral goes to the named confirm — the pick itself
  // never spends anything.
  async pickMineralGroup(placeHolder) {
    const inv = Logic.mineralInventory(this.state);
    if (inv.groups.length === 0) {
      this.notify('No minerals yet — salvage a planet to get one, or buy one in the Protoplanet shop.');
      return null;
    }
    const items = inv.groups.map((g) => ({
      label: `${g.label}${g.count > 1 ? ` ×${g.count}` : ''}`,
      description: g.applyText,
      group: g,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder,
      ignoreFocusOut: true,
    });
    return pick ? pick.group : null;
  }

  // The shared tap handler for a picked mineral group (inventory tap
  // and apply command alike): a Birth group shows the guidance copy
  // and is never consumed; a Mutation group the planet already has
  // says so up front; anything else goes to the named confirm — the
  // pick itself never spends anything.
  async handleMineralGroupPick(group) {
    if (!group) return;
    // Birth minerals pay for births — they can never be applied.
    if (!group.mutation) {
      this.notify("Birth minerals can't be applied — they pay for births. Get a Mutation mineral from the shop or salvage.");
      return;
    }
    if (!this.state.current) {
      this.notify('No planet is growing — hatch one first, then spend a mineral on it.');
      return;
    }
    const mutName = (Planet.mutationDef(group.mutation) || {}).name || group.label.replace(/ mineral$/, '');
    // Already on the growing planet: say so up front instead of
    // showing a confirm that could never succeed (attemptMutation
    // would block it too — the mineral is never consumed).
    if ((this.state.current.mutations || []).includes(group.mutation)) {
      this.notify(`${mutName} is already on ${Logic.nameForPlanet(this.state.current)} — pick a mineral it doesn't have yet.`);
      return;
    }
    // One mineral of this mutation (a group may hold several —
    // they're identical, so the first one is spent).
    const mineral = (this.state.minerals || []).find((m) => m.mutation === group.mutation);
    if (!mineral) {
      this.notify('That mineral can\'t go on this planet anymore.');
      return;
    }
    await this.confirmAndApplyMineral(mineral.id, mutName);
  }

  // Spend a mineral to try to put its mutation on the planet you love
  // (round 10 — the mineral IS the mutation; feeding is gone). The
  // command opens the SAME combined mineral list as the inventory —
  // every mineral, Birth included — through the shared picker, and
  // the picker always appears, even with one mineral (round 17 fix
  // L: no single-item shortcut, no bare info message instead of a
  // list). The pick is NOT the commit anymore: a native confirm
  // states the 50% odds before the flip, and cancelling consumes
  // nothing.
  async applyMineral() {
    if (!this.state.current) {
      vscode.window.showInformationMessage('No planet is growing — hatch one first, then spend a mineral on it.');
      return;
    }
    const odds = Logic.applyOdds();
    const group = await this.pickMineralGroup(
      `Protoplanet: spend a mineral — ${Logic.formatOdds(odds.success)} chance to put its mutation on your planet`
    );
    await this.handleMineralGroupPick(group);
  }

  // Round 14 — the mineral inventory: a QuickPick listing every
  // mineral grouped by KIND (round 16 overhaul) — Birth minerals
  // together ("Pays for 1 birth — cannot apply"), then Mutation
  // minerals by mutation — plus the Stardust balance in the
  // placeholder. Round 17 fix A — tapping a Mutation mineral goes
  // STRAIGHT to the apply confirm for the currently growing planet
  // (no picker, no redirect toast); tapping a Birth mineral shows
  // the guidance copy instead — it pays for births, it can't apply.
  // Round 17 fix L — the list and the tap handling are shared with
  // the apply command (pickMineralGroup / handleMineralGroupPick):
  // the picker always appears, even with one mineral, and Birth
  // minerals are always listed, never hidden.
  async viewMinerals() {
    const inv = Logic.mineralInventory(this.state);
    const group = await this.pickMineralGroup(
      `Protoplanet: minerals — ✦ ${Math.floor(inv.stardust).toLocaleString()} Stardust`
    );
    await this.handleMineralGroupPick(group);
  }

  // Round 14 — the shop: spend Stardust on minerals. Every purchase
  // adds a MINERAL, never a direct mutation — the player still
  // applies it with the 50% coin flip. Insufficient funds = a plain
  // message, no purchase. The Family Mutation Mineral asks for the
  // family in a second pick, naming the exact mutations and odds per family.
  // Round 16 overhaul — exactly three items, labels + odds rendered
  // from the shared probability helpers (§7), never hardcoded:
  // Birth Mineral (500 ✦, creates one planet), Random Mutation
  // Mineral (50,000 ✦, 1 of 13), Family Mutation Mineral (80,000 ✦,
  // Moon/Rings/Glow/Sky only). The Mystery Mineral is gone
  // (round 15 — Devon).
  async openShop() {
    const bal = () => Math.floor(this.state.stardust || 0).toLocaleString();
    const price = (n) => n.toLocaleString(); // 50,000 reads better than 50000
    const wheel = Logic.wheelOdds();
    const apply = Logic.applyOdds();
    const mutationCount = Planet.CONFIG.MUTATIONS.length;
    const items = [
      {
        label: `Birth Mineral — ${price(Logic.CONFIG.SHOP_BIRTH_PRICE)} ✦`,
        description: 'Creates one planet · 100% success',
        kind: 'birth',
      },
      {
        label: `Random Mutation Mineral — ${price(Logic.CONFIG.SHOP_RANDOM_MUTATION_PRICE)} ✦`,
        description: `1 of ${mutationCount} mutations · ${Logic.formatOdds(apply.success)} application chance`,
        detail: `1 of ${mutationCount}, each equally likely (${Logic.formatOdds(wheel.perMutation)} each)`,
        kind: 'random',
      },
      {
        label: `Family Mutation Mineral — ${price(Logic.CONFIG.SHOP_FAMILY_PICK_PRICE)} ✦`,
        description: 'Choose family · see exact odds before purchase',
        kind: 'family',
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Protoplanet: shop — ✦ ${bal()} Stardust`,
      ignoreFocusOut: true,
    });
    if (!pick) return;
    if (pick.kind === 'family') {
      const famItems = Logic.CONFIG.FAMILY_PICK_FAMILIES.map((f) => {
        const odds = Logic.familyPickOdds(f);
        const names = (odds.mutations || []).map((id) => (Planet.mutationDef(id) || {}).name || id);
        return {
          label: f.charAt(0).toUpperCase() + f.slice(1),
          description: `${Logic.formatOdds(odds.perMutation, 'one-in')} each: ${names.join(', ')}`,
          id: f,
        };
      });
      const famPick = await vscode.window.showQuickPick(famItems, {
        placeHolder: 'Protoplanet: pick a family for your mutation mineral',
        ignoreFocusOut: true,
      });
      if (!famPick) return;
      const res = Logic.buyFamilyPick(this.state, famPick.id);
      if (!res.ok) { this.notify(`Not enough Stardust — a Family Mutation Mineral costs ${price(Logic.CONFIG.SHOP_FAMILY_PICK_PRICE)} ✦.`); return; }
      this.notify(`Family Mutation Mineral: you got a ${Logic.mineralName(res.mineral)}! Spend it from 'Protoplanet: Apply a mineral to your planet'.`);
    } else if (pick.kind === 'birth') {
      const res = Logic.buyBirthMineral(this.state);
      if (!res.ok) { this.notify(`Not enough Stardust — a Birth Mineral costs ${price(Logic.CONFIG.SHOP_BIRTH_PRICE)} ✦.`); return; }
      this.notify(`You bought a ${Logic.mineralName(res.mineral)}!`);
    } else if (pick.kind === 'random') {
      const res = Logic.buyRandomMutationMineral(this.state);
      if (!res.ok) { this.notify(`Not enough Stardust — a Random Mutation Mineral costs ${price(Logic.CONFIG.SHOP_RANDOM_MUTATION_PRICE)} ✦.`); return; }
      this.notify(`Random Mutation Mineral: you got a ${Logic.mineralName(res.mineral)}! Spend it from 'Protoplanet: Apply a mineral to your planet'.`);
    }
    this.saveNow();
    this.pushState();
  }

  // Round 16 overhaul — the salvage warning, built from
  // Logic.salvagePreview BEFORE anything is destroyed: the exact
  // yield, the exact mutations that would be lost to the
  // grow-it-first rule, and the way to keep them. `action` is the
  // question sentence; the yield/loss lines follow it.
  salvageConfirmMessage(planet, action) {
    const preview = Logic.salvagePreview(planet);
    const yields = preview.yields.map((m) => Logic.mineralName(m)).join(', ');
    let msg = `${action} It would yield: ${yields}.`;
    if (preview.lost.length > 0) {
      const names = preview.lost.map((id) => (Planet.mutationDef(id) || {}).name || id);
      msg += ` Its ${names.join(', ')} ${preview.lost.length === 1 ? 'mineral would' : 'minerals would'} be lost — grow it to stage 4 (Crust, 600 XP) first to keep its mutation minerals.`;
    }
    return msg;
  }

  // The pick-list detail for a salvageable planet: what it carries,
  // plus the pre-confirm warning when a mutated planet is below
  // stage 4 — its mutation minerals would be lost.
  salvageDetail(planet) {
    const preview = Logic.salvagePreview(planet);
    if (preview.lost.length > 0) {
      const names = preview.lost.map((id) => (Planet.mutationDef(id) || {}).name || id).join(', ');
      return `Carries: ${names} — below stage 4, its ${names} would be lost`;
    }
    const mutLabel = Planet.mutationLabel(planet);
    if (mutLabel) return `Carries: ${mutLabel}`;
    // Round 17 — a plain Civilization planet yields two Birth
    // minerals, not one: count them from the preview, never hardcode.
    const birthCount = preview.yields.filter((m) => m.kind === 'birth').length;
    return birthCount === 1
      ? 'No mutation — yields one Birth mineral'
      : `No mutation — yields ${birthCount} Birth minerals`;
  }

  async salvagePlanet() {
    const items = [];
    if (this.state.current) {
      items.push({
        label: `Recycle current planet — ${this.state.current.summary}`,
        description: 'Destroy it for minerals and hatch a fresh planet right away',
        detail: this.salvageDetail(this.state.current),
        kind: 'current',
      });
      // Round 9 (Devon): a second choice — destroy it and grow
      // NOTHING yet. The prompt after asks what grows next.
      items.push({
        label: `Destroy current planet — ${this.state.current.summary}`,
        description: 'Destroy it for minerals (no new planet) — you pick what grows next',
        detail: this.salvageDetail(this.state.current),
        kind: 'destroyCurrent',
      });
    }
    this.state.past.forEach((p, i) => {
      items.push({
        label: `Salvage ${p.summary}`,
        description: 'Destroy it for minerals (no new planet)',
        detail: this.salvageDetail(p),
        kind: 'past',
        index: i,
      });
    });
    if (items.length === 0) return;
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Protoplanet: destroy a planet for minerals (permanent)',
      ignoreFocusOut: true,
    });
    if (!pick) return;
    if (pick.kind === 'current') {
      const doomedRecycle = this.state.current;
      const answer = await vscode.window.showWarningMessage(
        this.salvageConfirmMessage(doomedRecycle, 'Recycle your current planet? It will be destroyed for minerals and a fresh planet hatches right away.'),
        { modal: true },
        'Yes, recycle it'
      );
      if (answer !== 'Yes, recycle it') return;
      const recycleRes = Logic.recycleCurrent(this.state, Logic.randomSeed);
      this.notifySalvageLoss(doomedRecycle, recycleRes);
    } else if (pick.kind === 'destroyCurrent') {
      const doomedDestroy = this.state.current;
      const answer = await vscode.window.showWarningMessage(
        this.salvageConfirmMessage(doomedDestroy, 'Destroy your current planet? It will be destroyed for minerals and nothing grows until you pick what comes next.'),
        { modal: true },
        'Yes, destroy it'
      );
      if (answer !== 'Yes, destroy it') return;
      const destroyRes = Logic.destroyCurrent(this.state);
      this.notifySalvageLoss(doomedDestroy, destroyRes);
      this.saveNow();
      this.pushState();
      await this.promptAfterDestroy();
      return;
    } else {
      const doomedSalvage = this.state.past[pick.index];
      const answer = await vscode.window.showWarningMessage(
        this.salvageConfirmMessage(doomedSalvage, 'Salvage this planet from your collection? It will be destroyed for minerals.'),
        { modal: true },
        'Yes, salvage it'
      );
      if (answer !== 'Yes, salvage it') return;
      const salvageRes = Logic.salvageArchived(this.state, pick.index);
      this.notifySalvageLoss(doomedSalvage, salvageRes);
    }
    this.saveNow();
    this.pushState();
  }

  // After a destroy-with-no-new-planet (round 9 — Devon): ask what
  // grows next, in the VS Code dropdown. The starter pick is only
  // for the first planet — later births are random by default — but
  // the pick is still offered for when they want to tilt the birth.
  // Dismissing the prompt is fine: nothing grows until they say so.
  async promptAfterDestroy() {
    if (this.state.current) return; // something is already growing
    const items = [];
    const revivable = (this.state.past || []).map((p, i) => ({ p, i })).filter(({ p }) => p.planet);
    if (revivable.length > 0) {
      items.push({
        label: 'Grow an old planet',
        description: 'Pick one from your collection',
        detail: 'It comes back exactly as it was — same XP, stage, mutations',
        kind: 'grow',
      });
    }
    items.push({
      label: 'Birth a new planet',
      description: 'Fully random — no starter pick',
      detail: 'The starter pick is only for your first planet',
      kind: 'birth',
    });
    items.push({
      label: 'Birth a new planet — pick a terrain',
      description: 'Pick a terrain to tilt the birth',
      detail: 'Icy, Lava, Jungle, Rocky or Ocean — like your first planet',
      kind: 'birthTerrain',
    });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Protoplanet: your planet is gone — what grows next?',
      ignoreFocusOut: true,
    });
    if (!pick) return;
    if (pick.kind === 'grow') {
      const planetItems = revivable.map(({ p, i }) => ({
        label: `${p.summary}`,
        description: Logic.stageInfo(p.chars || 0).name,
        detail: p.mutations && p.mutations.length > 0
          ? `Carries: ${p.mutations.map((id) => (Planet.mutationDef(id) || {}).name || id).join(', ')}`
          : 'No mutation',
        index: i,
      }));
      const planetPick = await vscode.window.showQuickPick(planetItems, {
        placeHolder: 'Protoplanet: grow an old planet again',
        ignoreFocusOut: true,
      });
      if (!planetPick) return;
      const res = Logic.makeCurrent(this.state, planetPick.index);
      if (!res.ok) {
        if (res.reason === 'archive full') this.notifyArchiveFull();
        return;
      }
      // A switch is NOT a birth — tell the birth detector the new
      // key is already seen, or pushState would toast "X was born!"
      // for a planet that has been alive for weeks (round 7).
      this.lastBirthKey = this.birthKey();
      this.notify(`${Logic.nameForPlanet(res.planet)} is growing again!`);
      this.saveNow();
      this.pushState();
    } else if (pick.kind === 'birth') {
      const birthRes = Logic.newPlanet(this.state, Logic.randomSeed);
      if (!birthRes.ok) {
        if (birthRes.reason === 'archive full') this.notifyArchiveFull();
        else if (birthRes.reason === 'no plain mineral') this.notifyNeedPlainMineral();
        return;
      }
      this.saveNow();
      this.pushState();
    } else if (pick.kind === 'birthTerrain') {
      const terrainItems = Logic.CONFIG.STARTER_TERRAINS.map((id) => {
        const t = Planet.CONFIG.TERRAINS.find((t) => t.id === id);
        return { label: t ? t.label : id, description: t ? t.desc : '', id };
      });
      const terrainPick = await vscode.window.showQuickPick(terrainItems, {
        placeHolder: 'Protoplanet: pick a starter terrain',
        ignoreFocusOut: true,
      });
      // Dismissing the pick is fine — the planet is fully random then.
      const birthTerrainRes = Logic.newPlanet(this.state, Logic.randomSeed, terrainPick ? terrainPick.id : undefined);
      if (!birthTerrainRes.ok) {
        if (birthTerrainRes.reason === 'archive full') this.notifyArchiveFull();
        else if (birthTerrainRes.reason === 'no plain mineral') this.notifyNeedPlainMineral();
        return;
      }
      this.saveNow();
      this.pushState();
    }
  }

  async prestige() {
    const eligible = Logic.eligiblePrestigeParents(this.state);
    if (eligible.length < 2) {
      await vscode.window.showWarningMessage(
        'Prestige needs two planets that reached Civilization (2200+ characters) and have not been parents yet.',
        { modal: false }
      );
      return;
    }
    const pickParent = async (exclude) => {
      const items = eligible
        .filter((p) => p !== exclude)
        .map((p) => ({
          label: p.label,
          description: p.mutations.length > 0
            ? p.mutations.map((id) => (Planet.mutationDef(id) || {}).name || id).join(', ')
            : 'No mutation',
          detail: `Grown from ${p.chars} characters`,
          parent: p,
        }));
      return vscode.window.showQuickPick(items, {
        placeHolder: exclude ? 'Protoplanet: pick the second parent' : 'Protoplanet: pick the first parent',
        ignoreFocusOut: true,
      });
    };
    const first = await pickParent(null);
    if (!first) return;
    const second = await pickParent(first.parent);
    if (!second) return;
    const a = first.parent, b = second.parent;
    // Round 16 overhaul — the confirm states the real numbers from
    // the shared helper: each parent mutation's inheritance chance
    // (50% one parent / 75% both), the 1-Birth-mineral cost, and the
    // parents-stay fate. When the per-mutation list is too long for
    // one confirm (>4), it goes in a second QuickPick step first —
    // never a new screen.
    const mutCounts = {};
    for (const p of [a, b]) {
      for (const id of (p.mutations || [])) mutCounts[id] = (mutCounts[id] || 0) + 1;
    }
    const inheritLines = Object.keys(mutCounts).map((id) => {
      const name = (Planet.mutationDef(id) || {}).name || id;
      const chance = Logic.inheritanceOdds(mutCounts[id]);
      return `${name}: ${Logic.formatOdds(chance)} (${mutCounts[id] === 2 ? 'both parents' : 'one parent'})`;
    });
    if (inheritLines.length > 4) {
      const inheritItems = Object.keys(mutCounts).map((id) => {
        const name = (Planet.mutationDef(id) || {}).name || id;
        const chance = Logic.inheritanceOdds(mutCounts[id]);
        return {
          label: name,
          description: `${Logic.formatOdds(chance)} inheritance — ${mutCounts[id] === 2 ? 'both parents carry it' : 'one parent carries it'}`,
        };
      });
      const inheritPick = await vscode.window.showQuickPick(inheritItems, {
        placeHolder: 'Protoplanet: inheritance chances — pick any row to continue to the confirm',
        ignoreFocusOut: true,
      });
      if (!inheritPick) return;
    }
    const inheritText = inheritLines.length === 0
      ? 'Neither parent carries a mutation — the offspring rolls fresh at the usual rare odds.'
      : (inheritLines.length > 4
        ? 'Inheritance chances are listed in the previous step.'
        : `Inheritance: ${inheritLines.join('; ')}.`);
    const answer = await vscode.window.showWarningMessage(
      `Prestige ${a.label} + ${b.label}? Costs 1 Birth mineral. Their offspring starts as dust. ${inheritText} The parents stay in your collection but can't be parents again.`,
      { modal: true },
      'Yes, prestige them'
    );
    if (answer !== 'Yes, prestige them') return;
    const res = Logic.prestige(this.state,
      { kind: a.kind, index: a.index },
      { kind: b.kind, index: b.index },
      Logic.randomSeed);
    if (!res.ok) {
      if (res.reason === 'archive full') this.notifyArchiveFull();
      else if (res.reason === 'no plain mineral') this.notifyNeedPlainMineral();
      return; // state changed between picks (shouldn't happen), or the archive is full, or no Birth mineral
    }
    this.recordPrestigeResult(res);
    this.saveNow();
    this.pushState();
  }

  // -- step 4: the Solar System / collection view ---------------------------
  // A full webview panel (not the sidebar): the orrery takes up the
  // screen, and the Index is its own full-screen mode, reached from
  // the top bar. The panel is a dumb view of the state — every decision
  // (slots, ranks, place/remove) lives in petLogic.js; this class
  // only builds the view model and applies the webview's messages.

  openSolarSystem() {
    if (this.systemPanel) { this.systemPanel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
      'protoplanet.system',
      'Protoplanet — Solar System',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // scroll/selection survive tab switches
        localResourceRoots: [this.context.extensionUri],
      }
    );
    this.systemPanel = panel;
    panel.webview.html = this.getSystemHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onSystemMessage(msg));
    panel.onDidDispose(() => { this.systemPanel = null; });
    this.postSystemState();
  }

  // Everything the panel needs, in one JSON-safe message. Each planet
  // carries its full traits (`planet`) so the webview can render it
  // with planet.js — archived records store the full snapshot (step
  // 4), so a tilted birth roll renders exactly as it was born.
  // One planet, ready for a panel to render: full traits (`planet`)
  // so the webview can draw it with planet.js, plus the flat fields
  // the cards and detail views show. Shared by the Solar System and
  // Prestige panels. Archived records store the full snapshot (step
  // 4), so a tilted birth roll renders exactly as it was born.
  renderablePlanet(record, kind) {
    let traits = record.planet;
    if (!traits && kind === 'current') {
      // The live planet IS its own snapshot: makePlanet builds it from
      // generatePlanet plus xp/chars, so it carries every trait field
      // the renderer needs. Never re-roll the current planet from its
      // seed — a planet hatched under an older generation rule re-rolls
      // into a DIFFERENT planet with current code. GJ-364c (seed
      // 948502300) was hatched under the pre-guarantee 75% starter
      // bias: the stored planet has a grey moon (tint 244, radius 4),
      // a wide ring and size 0.9126, while the re-roll gives a peach
      // moon (209, radius 2), a double ring and size 1.0013. The
      // sidebar already renders the stored object; the panel must
      // render the same one (Nov 12, round 5).
      traits = record;
    }
    if (!traits) {
      // Pre-step-4 record (no snapshot): re-roll from the seed and
      // apply the stored mutations. Best effort — a tilted birth
      // roll's mutation-granted traits (e.g. a green moon's tint)
      // can't be fully rebuilt from the seed alone.
      // The stored terrain MUST be passed as the starter terrain:
      // the seed alone does not encode a starter pick. Without it the
      // re-roll does a weighted terrain pick, so a starter-picked icy
      // planet (GJ-364c, seed 948502300) came back LAVA in the panel —
      // red/orange disc + red moon while the sidebar (which renders
      // the live object) stayed icy blue. The label said "Icy world"
      // because it reads record.terrain, but the pixels used the
      // re-rolled lava traits. Passing the stored terrain reproduces
      // the exact planet: the starter pick consumes one rng draw, so
      // moons/rings/size are identical either way (verified Nov 12).
      // Records with no stored terrain (pre-step-4) fall back to the
      // weighted pick, as before.
      traits = Planet.generatePlanet(record.seed, record.terrain);
      traits.mutations = (record.mutations || []).slice();
    }
    // Display stage: CAPPED at Civilization — the final stage
    // (End was cut Nov 12), so the cap is a safeguard and the
    // panels always show the planet at its true stage.
    const dStage = Logic.displayStageForXp(record.chars || 0);
    return {
      seed: record.seed,
      name: Logic.nameForPlanet(record),
      terrain: record.terrain,
      terrainLabel: record.terrainLabel,
      summary: record.summary,
      chars: record.chars || 0,
      // The current planet's generation is its own stamped field
      // (round 7) — a reactivated Gen 1 planet still reads Gen 1,
      // not the lives counter. Old saves fall back to the counter.
      generation: kind === 'current'
        ? (Number.isInteger(record.generation) ? record.generation : this.state.generation)
        : record.generation,
      archivedAt: record.archivedAt || null,
      mutations: (record.mutations || []).slice(),
      mutationLabel: Planet.mutationLabel({ mutations: record.mutations || [] }),
      // Round 10: the set titles this planet earned (Moon Lord, Ring
      // King) — a whole family on one planet. { id, name } pairs, so
      // the panels never hardcode set names.
      sets: Logic.setsForPlanet(record).map((id) => {
        const d = Logic.setDef(id);
        return { id, name: d ? d.name : id };
      }),
      parents: record.parents || null,
      usedAsParent: !!record.usedAsParent,
      // Round 11 — the Discovery Journal travels with the planet:
      // the live planet carries it directly; an archived planet
      // carries it in its snapshot (flat records predate it).
      journal: (record.journal || (traits && traits.journal) || []).map((e) => ({
        t: e.t, kind: e.kind, title: e.title || null, text: e.text,
      })),
      kind,
      stageIdx: dStage,
      stageName: Planet.STAGES[dStage].name,
      // Round 14: Stardust per character this planet earns, so the
      // Index and detail sheet can compare planets at a glance.
      // Round 15 revision (Devon, Nov 14 — the separate Stardust
      // tab is gone): the detail sheet shows the FULL breakdown
      // (stage base, mutations, journal, family combo), so every
      // renderable planet carries its own breakdown lines.
      earnRate: Logic.earnRate(record),
      earnRateText: Logic.formatRate(Logic.earnRate(record)),
      earnBreakdown: Logic.earnBreakdown(record),
      planet: traits,
    };
  }

  solarSystemViewModel() {
    Logic.normalizeSystem(this.state);
    const rank = Logic.systemRank(this.state);
    const renderable = (record, kind) => this.renderablePlanet(record, kind);
    const slots = [];
    let ringsUsed = 0;
    for (let i = 0; i < rank.totalSlots; i++) {
      const slot = this.state.system[i] || null;
      const resolved = Logic.resolveSlotPlanet(this.state, slot);
      if (resolved) ringsUsed++;
      slots.push({
        index: i,
        unlocked: true,
        unlockLabel: null,
        planet: resolved ? renderable(resolved.record, resolved.kind) : null,
      });
    }
    // The next two locked rings stay visible (dashed, labeled) — the
    // locked ring IS the progression UI. More than two would crowd
    // the orrery; the rest unlock as you finish more planets.
    for (let i = rank.totalSlots; i < Math.min(rank.totalSlots + 2, Logic.CONFIG.SYSTEM_MAX_RINGS); i++) {
      if (rank.nextAt === null) break;
      slots.push({
        index: i,
        unlocked: false,
        unlockLabel: Logic.lockedRingLabel(this.state, i),
        planet: null,
      });
    }
    const index = this.state.past.map((p) => renderable(p, 'past'));
    if (this.state.current) index.push(renderable(this.state.current, 'current'));
    // Round 10: the Mutation Index — all 13 mutations, found vs
    // missing, which planets carry each, honest odds. Found means
    // discovered (state.discovered) — a mutation stays found even
    // after its planet is destroyed.
    const discovered = new Set(this.state.discovered || []);
    // Round 19 — the Mutations tab is a Fusion hub + mineral inventory
    // + Sets now (Devon, Nov 15): the bingo card (one card per mutation
    // with per-mutation carrier lists) is gone — a mutation lives on many
    // planets, so listing carriers reads like it can only be on one.
    // The header keeps the found count + honest odds; the sets carry
    // per-mutation progress instead of a single holder line.
    const mutationIndex = {
      total: Planet.CONFIG.MUTATIONS.length,
      foundCount: Planet.CONFIG.MUTATIONS.filter((m) => discovered.has(m.id)).length,
      oddsText: `about 1 in ${Math.round(1 / Planet.CONFIG.MUTATION_CHANCE)} births`,
      // Round 16 overhaul — the any-mutation line. The "About 1 in
      // 10" is Devon's approved intro wording (the exact computed
      // chance is 8.73%, "1 in 11" — never render it raw here); the
      // per-mutation "1 in 143" comes from the shared helper.
      anyOddsText: `About 1 in 10 planets is born with a mutation · each one about ${Logic.formatOdds(Logic.birthMutationOdds().perMutation, 'one-in')}`,
      sets: Logic.CONFIG.SETS.map((s) => {
        const holder = index.find((p) => Logic.setsForPlanet(p).includes(s.id));
        return {
          id: s.id,
          name: s.name,
          required: s.required.map((id) => {
            const def = Planet.mutationDef(id);
            const carrier = index.find((p) => (p.mutations || []).includes(id));
            return {
              id,
              name: def ? def.name : id,
              found: discovered.has(id),
              carrier: carrier ? carrier.name : null,
            };
          }),
          holder: holder ? holder.name : null,
        };
      }),
    };
    // Round 19 — Fusion hub summary: the two parent slots (best ready
    // parents first, then the planets closest to Civilization), the
    // ready count, and the Birth-mineral balance for the cost line.
    // No Gen anywhere — the label was removed in round 17.
    const eligible = Logic.eligiblePrestigeParents(this.state);
    const resolveRecord = (desc) => (desc.kind === 'current' ? this.state.current : this.state.past[desc.index]);
    const readyParents = eligible
      .map((d) => ({ record: resolveRecord(d), kind: d.kind }))
      .filter((x) => x.record)
      .sort((a, b) => (((b.record.mutations || []).length - (a.record.mutations || []).length)
        || ((b.record.chars || 0) - (a.record.chars || 0))));
    const allRecords = [
      ...(this.state.current ? [{ record: this.state.current, kind: 'current' }] : []),
      ...(this.state.past || []).map((p) => ({ record: p, kind: 'past' })),
    ];
    const nextClosest = allRecords
      .filter((x) => !Logic.prestigeEligible(x.record))
      .sort((a, b) => (b.record.chars || 0) - (a.record.chars || 0));
    const slotFor = (x) => {
      if (!x) return null;
      return {
        planet: renderable(x.record, x.kind),
        ready: Logic.prestigeEligible(x.record),
        chars: x.record.chars || 0,
        toCiv: Math.max(0, Logic.CONFIG.PRESTIGE_MIN_CHARS - (x.record.chars || 0)),
      };
    };
    const fusionSlots = [];
    if (readyParents.length >= 2) {
      fusionSlots.push(slotFor(readyParents[0]), slotFor(readyParents[1]));
    } else if (readyParents.length === 1) {
      fusionSlots.push(slotFor(readyParents[0]), slotFor(nextClosest[0]));
    } else {
      fusionSlots.push(slotFor(nextClosest[0]), slotFor(nextClosest[1]));
    }
    const fusion = {
      readyCount: eligible.length,
      minChars: Logic.CONFIG.PRESTIGE_MIN_CHARS,
      slots: fusionSlots,
      birthCount: Logic.mineralSummary(this.state).birth,
      birthCost: 1,
    };
    // Round 19 — the mineral inventory for the tab: Mutation minerals
    // first (alphabetical), then Birth — the same grouping as
    // mineralInventory(), plus each mutation's real description and
    // the shop prices for the footer line.
    const minerals = Logic.mineralInventory(this.state);
    minerals.groups = minerals.groups.map((g) => ({
      ...g,
      desc: g.mutation ? ((Planet.mutationDef(g.mutation) || {}).desc || '') : '',
    }));
    minerals.shopPrices = {
      birth: Logic.CONFIG.SHOP_BIRTH_PRICE,
      random: Logic.CONFIG.SHOP_RANDOM_MUTATION_PRICE,
      family: Logic.CONFIG.SHOP_FAMILY_PICK_PRICE,
    };
    return {
      type: 'system',
      rank: rank.rank,
      finished: rank.finished,
      totalSlots: rank.totalSlots,
      nextAt: rank.nextAt,
      toNext: rank.toNext,
      ringsUsed,
      totalPlanets: index.length,
      // Round 11 — the archive cap is visible: N/200 in the Index.
      archiveCount: (this.state.past || []).length,
      archiveLimit: Logic.CONFIG.PAST_LIMIT,
      slots,
      index,
      mutationIndex,
      // Round 19 — Fusion hub summary + mineral inventory for the
      // redesigned Mutations tab.
      fusion,
      minerals,
      // Round 14: the Stardust balance and what the whole system earns.
      stardust: this.state.stardust || 0,
      systemEarnRate: Logic.systemEarnRate(this.state),
      systemEarnRateText: Logic.formatRate(Logic.systemEarnRate(this.state)),
    };
  }

  postSystemState() {
    if (this.systemPanel) this.systemPanel.webview.postMessage(this.solarSystemViewModel());
  }

  // Messages from the panel: place a planet on a ring, take one off,
  // or grow an archived planet again. The panel never mutates state
  // itself — it asks, the logic decides, and the fresh state is
  // pushed back.
  async onSystemMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'place' && Number.isInteger(msg.ring)) {
      const res = Logic.placePlanet(this.state, msg.ring, msg.seed, msg.generation);
      if (res.ok) { this.saveNow(); this.pushState(); }
    } else if (msg.type === 'remove' && Number.isInteger(msg.ring)) {
      const res = Logic.removeFromSystem(this.state, msg.ring);
      if (res.ok) { this.saveNow(); this.pushState(); }
    } else if (msg.type === 'makeCurrent' && Number.isInteger(msg.seed) && Number.isInteger(msg.generation)) {
      // Grow an archived planet again (round 7 — Devon): the Index
      // detail sheet asks by seed+generation, the same identity the
      // slots use. A switch is NOT a birth — the planet keeps its
      // generation and its XP — so the birth detector must be told
      // the new key is already seen, or pushState would toast
      // "X was born!" for a planet that has been alive for weeks.
      const idx = this.state.past.findIndex((p) => p.seed === msg.seed && p.generation === msg.generation);
      if (idx < 0) return;
      const res = Logic.makeCurrent(this.state, idx);
      if (res.ok) {
        this.lastBirthKey = this.birthKey();
        this.notify(`${Logic.nameForPlanet(res.planet)} is growing again!`);
        this.saveNow();
        this.pushState();
      } else if (res.reason === 'archive full') {
        this.notifyArchiveFull();
      }
    } else if (msg.type === 'salvage' && Number.isInteger(msg.seed) && Number.isInteger(msg.generation)) {
      // Salvage an archived planet from its detail sheet (round 11):
      // destroying it for minerals is also how a full archive frees
      // a slot. Same confirm as the salvage command.
      const idx = this.state.past.findIndex((p) => p.seed === msg.seed && p.generation === msg.generation);
      if (idx < 0) return;
      const doomedPanel = this.state.past[idx];
      const answer = await vscode.window.showWarningMessage(
        this.salvageConfirmMessage(doomedPanel, 'Salvage this planet from your collection? It will be destroyed for minerals.'),
        { modal: true },
        'Yes, salvage it'
      );
      if (answer !== 'Yes, salvage it') return;
      const salvagePanelRes = Logic.salvageArchived(this.state, idx);
      this.notifySalvageLoss(doomedPanel, salvagePanelRes);
      this.saveNow();
      this.pushState();
    } else if (msg.type === 'openPrestige') {
      // Round 19 — the Mutations tab's Fusion hub opens the fusion
      // panel without the command palette.
      this.openPrestige();
    } else if (msg.type === 'applyMineral' && typeof msg.mutation === 'string') {
      // Round 19 — an Apply button on a mineral row runs the same
      // apply flow as the command, pre-filled with that mineral
      // (named confirm, 50/50, nothing consumed on cancel).
      const inv = Logic.mineralInventory(this.state);
      const group = inv.groups.find((g) => g.mutation === msg.mutation);
      if (!group) {
        this.notify("That mineral is gone — it may have been spent already.");
        return;
      }
      await this.handleMineralGroupPick(group);
    }
  }

  // -- step 4b: the Prestige / fusion panel --------------------------------
  // A dedicated full-screen webview (like the Solar System panel): pick
  // two eligible parents, see what the offspring stands to inherit,
  // fuse them — a violent ASCII collision, not a gentle fade (Devon,
  // Nov 11) — and watch the offspring hatch with its lineage. The
  // panel is a dumb view — every decision (eligibility, the fusion
  // itself) lives in petLogic.js; this class only builds the view
  // model and applies the webview's messages.
  //
  // Parent fate (Devon's call): parents STAY in the collection, each
  // usable as a parent only ONCE (retire, not destroy). The flag
  // PRESTIGE_CONSUMES_PARENTS flips that later, only if he says so —
  // nothing in this panel assumes either fate; it shows what the
  // logic did.

  openPrestige() {
    if (this.prestigePanel) { this.prestigePanel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
      'protoplanet.prestige',
      'Protoplanet — Prestige',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // picks survive tab switches
        localResourceRoots: [this.context.extensionUri],
      }
    );
    this.prestigePanel = panel;
    panel.webview.html = this.getPrestigeHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onPrestigeMessage(msg));
    panel.onDidDispose(() => { this.prestigePanel = null; this.prestigeResult = null; });
    this.postPrestigeState();
  }

  // Everything the panel needs: every planet in the collection with
  // its eligibility, the inheritance multipliers, the base mutation
  // chance (so the panel can show the real % before fusing), and the
  // last fusion result (if any).
  prestigeViewModel() {
    const eligible = Logic.eligiblePrestigeParents(this.state);
    const planets = [];
    const pushEntry = (record, kind, index) => {
      const r = this.renderablePlanet(record, kind);
      r.index = index;
      r.eligible = Logic.prestigeEligible(record);
      r.eligibilityReason = r.eligible
        ? null
        : (record.usedAsParent ? 'already-parent' : 'too-young');
      r.progressToCiv = Math.min(1, (record.chars || 0) / Logic.CONFIG.PRESTIGE_MIN_CHARS);
      planets.push(r);
    };
    if (this.state.current) pushEntry(this.state.current, 'current', -1);
    this.state.past.forEach((p, i) => pushEntry(p, 'past', i));
    // Growing planet first, then newest archived first.
    planets.sort((a, b) => {
      if (a.kind === 'current') return -1;
      if (b.kind === 'current') return 1;
      return (b.archivedAt || 0) - (a.archivedAt || 0);
    });
    return {
      type: 'prestige',
      eligibleCount: eligible.length,
      canFuse: eligible.length >= 2,
      minChars: Logic.CONFIG.PRESTIGE_MIN_CHARS,
      inheritOne: Logic.CONFIG.PRESTIGE_INHERIT_CHANCE_ONE,
      inheritBoth: Logic.CONFIG.PRESTIGE_INHERIT_CHANCE_BOTH,
      consumesParents: Logic.CONFIG.PRESTIGE_CONSUMES_PARENTS,
      mutationChance: Planet.CONFIG.MUTATION_CHANCE,
      // Round 16 overhaul — a fusion costs 1 Birth mineral.
      birthCost: 'Costs 1 Birth mineral',
      planets,
      result: this.prestigeResult,
    };
  }

  postPrestigeState() {
    if (this.prestigePanel) this.prestigePanel.webview.postMessage(this.prestigeViewModel());
  }

  // The shape the panel shows after a fusion: the offspring (renderable),
  // its parents' lineage records, and which of its mutations it actually
  // inherited vs rolled fresh. Shared by the panel and the QuickPick
  // command — both paths land in the same place.
  recordPrestigeResult(res) {
    const parentMuts = new Set();
    for (const p of res.parents) for (const id of (p.mutations || [])) parentMuts.add(id);
    this.prestigeResult = {
      offspring: this.renderablePlanet(res.planet, 'current'),
      parents: res.parents,
      inherited: (res.planet.mutations || []).filter((id) => parentMuts.has(id)),
      fresh: (res.planet.mutations || []).filter((id) => !parentMuts.has(id)),
    };
  }

  // Messages from the panel: fuse two parents, dismiss the result, or
  // jump to the Solar System. The panel never mutates state itself.
  onPrestigeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'prestige' && msg.a && msg.b) {
      const res = Logic.prestige(this.state,
        { kind: msg.a.kind, index: msg.a.index },
        { kind: msg.b.kind, index: msg.b.index },
        Logic.randomSeed);
      if (res.ok) {
        this.recordPrestigeResult(res);
        this.saveNow();
        this.pushState();
      } else if (res.reason === 'archive full') {
        this.notifyArchiveFull();
      } else if (res.reason === 'no plain mineral') {
        this.notifyNeedPlainMineral();
      }
    } else if (msg.type === 'dismissResult') {
      this.prestigeResult = null;
      this.postPrestigeState();
    } else if (msg.type === 'openSystem') {
      this.openSolarSystem();
    }
  }

  // -- share card (P0, Nov 12 — Devon picked it first from the
  // popularity assessment). One click: a panel with the planet card —
  // the live ASCII render plus name, seed, stage and mutation — a
  // Download PNG button (the art as a real PNG, postable to X/Reddit
  // or a README), a Copy seed button (the seed hatches the exact same
  // planet, so it IS the shareable planet), and a Markdown block for
  // a GitHub README. The panel is a dumb view like the others: the
  // filename and markdown come from petLogic.js, the PNG bytes are
  // drawn in the webview and only written to disk here.
  openShare() {
    if (!this.state.current) {
      vscode.window.showInformationMessage('No planet yet — pick a starter first, then share it.');
      return;
    }
    if (this.sharePanel) { this.sharePanel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
      'protoplanet.share',
      'Protoplanet — Share your planet',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // the card survives tab switches
        localResourceRoots: [this.context.extensionUri],
      }
    );
    this.sharePanel = panel;
    panel.webview.html = this.getShareHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onShareMessage(msg));
    panel.onDidDispose(() => { this.sharePanel = null; });
    this.postShareState();
  }

  // Everything the card needs: the renderable planet (same shared
  // helper as the Solar System and Prestige panels) plus the PNG
  // filename and the README markdown from petLogic.js. `shareSeed` is
  // the seed as it is shared — the bare seed, or seed-terrain when
  // the planet's terrain was pinned by a starter pick (Nov 12
  // seed-hatch fix): the panel, the copy button and the PNG caption
  // all show the same string.
  shareViewModel() {
    const p = this.renderablePlanet(this.state.current, 'current');
    const filename = Logic.shareCardFilename(p.name, p.generation);
    return { type: 'share', ...p, filename, shareSeed: Logic.shareSeedFor(p), markdown: Logic.shareCardMarkdown(p, filename) };
  }

  postShareState() {
    // No planet (destroyed with nothing growing yet): the card has
    // nothing to render — skip the push instead of crashing in
    // shareViewModel (round 9). The panel keeps its last card.
    if (this.sharePanel && this.state.current) this.sharePanel.webview.postMessage(this.shareViewModel());
  }

  // Messages from the panel: copy the seed / markdown to the
  // clipboard, or save the PNG the panel drew on its canvas. The
  // panel never touches the clipboard or the disk itself — it asks,
  // the host decides. A cancelled save dialog is silent (no popup).
  async onShareMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'copySeed' && this.state.current) {
      await vscode.env.clipboard.writeText(this.shareViewModel().shareSeed);
      if (this.sharePanel) this.sharePanel.webview.postMessage({ type: 'copied', what: 'seed' });
    } else if (msg.type === 'copyMarkdown') {
      await vscode.env.clipboard.writeText(this.shareViewModel().markdown);
      if (this.sharePanel) this.sharePanel.webview.postMessage({ type: 'copied', what: 'markdown' });
    } else if (msg.type === 'downloadPng' && typeof msg.dataUrl === 'string' && typeof msg.filename === 'string') {
      const m = msg.dataUrl.match(/^data:image\/png;base64,(.+)$/);
      if (!m) return; // not a PNG data URL — ignore, don't write garbage
      const folder = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0])
        ? vscode.workspace.workspaceFolders[0].uri
        : vscode.Uri.file(os.homedir());
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, msg.filename),
        filters: { 'PNG image': ['png'] },
        saveLabel: 'Save planet card',
      });
      if (!uri) return; // cancelled
      await vscode.workspace.fs.writeFile(uri, Buffer.from(m[1], 'base64'));
      // Confirmation lives in the panel (the Download button flashes
      // "Saved!"), not a popup — the no-popups rule stays intact.
      if (this.sharePanel) this.sharePanel.webview.postMessage({ type: 'saved', filename: msg.filename });
    }
  }

  async maybeFirstRun() {
    if (this.state.starterDone) return;
    const items = Logic.CONFIG.STARTER_TERRAINS.map((id) => {
      const t = Planet.CONFIG.TERRAINS.find((t) => t.id === id);
      return { label: t ? t.label : id, description: t ? t.desc : '', id };
    });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Protoplanet: pick your first planet',
      ignoreFocusOut: true,
    });
    // Dismissing the pick is fine — the planet is fully random then.
    Logic.startFirstPlanet(this.state, Logic.randomSeed(), pick ? pick.id : undefined);
    this.saveNow();
    this.pushState();
    // First run: actually SHOW the planet. The sidebar view is only
    // created when the user opens it — without this the pick looks
    // like it did nothing: the state is saved, but postState() drops
    // the message because the webview doesn't exist yet. Focusing the
    // view resolves it, the webview sends 'ready', and the provider
    // posts the fresh state, so the hatch is visible right away.
    await this.showPet();
  }

  // -- pushing state to the UI ------------------------------------------------

  // The view model the webview and status bar share. Everything the
  // webview needs to render is in here; the planet object is plain
  // JSON-safe data, so it survives postMessage.
  viewModel() {
    const cur = this.state.current;
    if (!cur) return null;
    const info = Logic.stageInfo(cur.xp);
    return {
      type: 'state',
      planet: cur,
      stageIdx: info.stageIdx,
      stageName: info.name,
      stageDesc: info.desc,
      // The mutation tag — "MUTATION · Glitch" or null. Born with the
      // planet (Nov 11 redesign), so it's in the view model from stage
      // 0: the window shows it right away, no tier, just the name.
      mutationLabel: Planet.mutationLabel(cur),
      // Round 10: the mutation id to flash gold in the sidebar on this
      // push (a birth or a successful apply) — null the rest of the
      // time, so typing never re-flashes it.
      mutationFlash: this.mutationFlash || null,
      stageStart: info.stageStart,
      // Per-stage bar (round 6): the bar resets at every stage-up —
      // inStage is the XP earned inside this stage, span is what the
      // stage takes in total (null at Civilization). The sidebar label
      // and the status bar read these, not the cumulative total.
      inStage: info.inStage,
      span: info.span,
      xp: cur.xp,
      nextXp: info.nextXp, // null at Civilization: no next stage
      isMax: info.isMax, // fully evolved (Civilization+) — orange XP bar
      chars: cur.chars,
      // The planet's own generation (round 7) — a reactivated planet
      // keeps its birth order. Old saves fall back to the counter.
      generation: Number.isInteger(cur.generation) ? cur.generation : this.state.generation,
      summary: cur.summary,
      // Step 2: the mineral inventory for the webview's meta line.
      minerals: Logic.mineralSummary(this.state),
      // Round 14: the Stardust balance and this planet's earn rate.
      stardust: this.state.stardust || 0,
      earnRate: Logic.earnRate(cur),
      earnRateText: Logic.formatRate(Logic.earnRate(cur)),
      // Round 19: the whole system's per-character total, for the
      // floating chip next to the balance (the meta line above already
      // shows this planet's own rate).
      systemEarnRateText: Logic.formatRate(Logic.systemEarnRate(this.state)),
    };
  }

  pushState() {
    // Birth toasts first: a new planet's birth toast fires on the
    // push right after the birth (see maybeNotifyBirth).
    this.maybeNotifyBirth();
    const vm = this.viewModel();
    if (vm) {
      // viewModel() already computed the stage info — reuse it.
      // The mutation tag rides along in the status bar too, so a rare
      // planet is unmissable even with the sidebar closed. The mineral
      // count rides along as well (◆N), so the inventory is visible
      // at a glance without opening the panel.
      // Per-stage numbers (round 6): the status bar shows progress
      // inside the stage (192/200), not the cumulative total.
      // Maxed (Civilization+): total XP + "· MAX" instead of a
      // threshold — past Civilization there is no next stage, and
      // the bar is orange.
      this.statusBar.text = `$(globe) ${vm.stageName} · ${vm.isMax ? vm.xp : vm.inStage + '/' + vm.span} XP${vm.isMax ? ' · MAX' : ''}`
        + (vm.mutationLabel ? ` · ${vm.mutationLabel}` : '')
        + ` · ✦${Math.floor(vm.stardust).toLocaleString()}`
        + (vm.minerals && vm.minerals.total > 0 ? ` · ◆${vm.minerals.total}` : '');
    } else {
      this.statusBar.text = '$(globe) Protoplanet — hatching…';
    }
    this.viewProvider.postState(vm);
    // The flash is one-shot: it rode this push to the sidebar, and
    // typing must never re-flash it.
    this.mutationFlash = null;
    // The Solar System panel gets the same push (its own view model)
    // — typing never opens it, but a new planet while it is open must
    // show the new planet in the Index right away.
    this.postSystemState();
    // Same for the Prestige panel — typing can make the current
    // planet eligible, and a fusion from the palette must show up
    // there too.
    this.postPrestigeState();
    // Same for the Share card — typing while it is open must keep
    // the card (stage, XP, seed) showing the live planet.
    this.postShareState();
  }

  // -- webview HTML ----------------------------------------------------------

  getWebviewHtml(webview) {
    const nonce = getNonce();
    const planetJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'planet.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>
  /* Fixed-size cells — THE rule from the piece-1 fix. The grid is
     rendered with gridToHtml() (explicit-width inline-block run spans)
     and this CSS fixes height/line-height. The font never decides cell
     geometry, so the planet is a circle on any screen, any font. The
     cell ratio is 10:18, same as the PIL renderer and the v5 clip. */
  html, body { -webkit-text-size-adjust: none; text-size-adjust: none; }
  body { margin: 0; padding: 10px; background: transparent; overflow: hidden;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family); }
  /* Dark card (Devon, Nov 12 — round 2, restyled round 3): the
     round-1 guess was transparent — the pet floating on the VS Code
     gray. Devon wants Pokechi's card: a gray rounded-corner card
     holding the planet AND the XP bar, so it reads as one tidy unit
     at any size. Round 3: rounded corners (10px) and a lighter gray
     (#2b2b2b) — Devon explicitly asked for the rounded card here;
     that overrides the Instrument no-radius rule, which applies to
     the full-screen panels, not this card. No glow. */
  #wrap { background: #2b2b2b; border: 1px solid #3d3d3d; border-radius: 10px; padding: 8px; overflow: hidden; position: relative; }
  /* Round 17 (D) — floating Stardust chip: absolutely positioned in
     the top-right corner of the card, so it takes no layout space —
     the XP bar and its label keep their exact positions. Same amber
     pill as the orrery topbar chip, dark-backed so it reads over the
     planet art. pointer-events none so it never intercepts a drag;
     unselectable like the art. Updated per keystroke with the state
     push (see the 'state' message handler). */
  #sdChip { position: absolute; top: 6px; right: 6px; z-index: 2;
    padding: 2px 8px; border: 1px solid #e8b64c; border-radius: 999px;
    color: #e8b64c; font-size: 11px; white-space: nowrap;
    background: rgba(0, 0, 0, 0.45); pointer-events: none;
    user-select: none; -webkit-user-select: none; }
  /* Compact (collapsed sidebar): tighter margins so the XP bar stays
     visible in a short view. Round 3: the stage line hides entirely
     at minimum sizes (Devon: the stage doesn't need saying at this
     size — it's in the detail sheet / Index) and the body + card
     padding shrink, so the art gets ~20px back and the planet stops
     being a tiny icon at 150px tall. The XP bar + number always stay. */
  body.compact { padding: 6px; }
  body.compact #stageName { display: none; }
  body.compact #wrap { padding: 6px; }
  body.compact #xplabel { margin: 2px 0 3px; }
  body.compact #meta { margin-top: 2px; }
  /* No scrollbar, ever (Devon, Nov 12 — round 2): the content fits
     the view height by construction (see layout()); this is the
     backstop so a mis-measure can clip, never scroll. */
  /* The grid is centered in the card: at short heights the coarse
     grid is narrower than the card (the height binds, not the width),
     and a left-aligned smudge in a wide card looks like a bug. */
  .pp-grid { margin: 0; text-align: center;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
    user-select: none; -webkit-user-select: none;
    -webkit-text-size-adjust: none; text-size-adjust: none; }
  .pp-run { display: inline-block; height: var(--pp-ch, 18px);
    line-height: var(--pp-ch, 18px); vertical-align: top; overflow: hidden;
    white-space: pre; font-kerning: none; }
  #stageName { font-size: 13px; font-weight: 600; margin: 10px 0 2px; }
  #stageDesc { font-size: 12px; opacity: .75; margin: 0 0 8px; line-height: 1.4; }
  /* The mutation tag — Devon's rule: rarities must be VERY noticeable,
     or people click past them. Bold, letter-spaced, amber on dark,
     right under the stage name. Hidden when the planet has none. */
  #mutationLabel { display: inline-block; font-size: 11px; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase; color: #ffd75f;
    background: rgba(255, 215, 95, .12); border: 1px solid rgba(255, 215, 95, .55);
    border-radius: 3px; padding: 2px 7px; margin: 0 0 8px; }
  /* Round 10 — the reveal moment: when a mutation lands (birth or a
     successful apply), the tag pulses gold for 2s and the card
     flickers once. One-shot, driven by msg.mutationFlash. */
  #mutationLabel.flash { animation: ppFlash 2s ease 1; }
  @keyframes ppFlash { 0% { box-shadow: 0 0 0 rgba(255, 215, 95, 0); } 15% { box-shadow: 0 0 16px rgba(255, 215, 95, .9); } 100% { box-shadow: 0 0 0 rgba(255, 215, 95, 0); } }
  #wrap.glitchFlash { animation: ppGlitch .9s steps(2) 1; }
  @keyframes ppGlitch { 0%, 100% { opacity: 1; } 20% { opacity: .35; } 40% { opacity: .9; } 60% { opacity: .45; } 80% { opacity: .95; } }
  /* The XP bar has to READ as a bar, not a black strip (Devon, Nov 11):
     at 0 XP the fill is empty, so the track itself needs a visible
     border — plus a label with the numbers, so there's no guessing. */
  #xpbar { height: 10px; background: #1a1a1a; border: 1px solid rgba(232, 182, 76, 0.5);
    border-radius: 5px; overflow: hidden; }
  #xpbar.maxed { border-color: rgba(255, 140, 26, 0.6); }
  #xpfill { height: 100%; background: #e8b64c; width: 0%; }
  /* Maxed (Civilization+) — Pokechi-style: the XP bar turns orange
     once the planet is fully evolved, gold before that. */
  #xpfill.maxed { background: #ff8c1a; }
  #xplabel { font-size: 11px; color: #e8b64c; opacity: .9; margin: 4px 0 6px; }
  #xplabel.maxed { color: #ff8c1a; }
  #meta { font-size: 11px; opacity: .7; margin-top: 6px; line-height: 1.5; }
</style>
</head>
<body>
<div id="wrap"><pre class="pp-grid" id="grid"></pre><div id="xpbar"><div id="xpfill"></div></div><div id="xplabel">XP 0 / 100</div></div>
<div id="stageName">Your planet is hatching&hellip;</div>
<div id="mutationLabel" style="display:none"></div>
<p id="stageDesc">Pick a starter and start typing &mdash; every character grows it.</p>
<div id="meta"></div>
<script nonce="${nonce}" src="${planetJsUri}"></script>
<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  const P = window.Protoplanet;
  const gridEl = document.getElementById('grid');
  const wrapEl = document.getElementById('wrap');
  // Round 17 (D) — floating Stardust chip: created here as the card's
  // first child (not in the static HTML) so the card's static markup
  // — the round-3 Pokechi card asserted by test-pet — stays exactly
  // as-is. Absolutely positioned (see #sdChip), so it takes no layout
  // space; the XP bar and label keep their exact positions. The
  // 'state' handler below keeps #sdBal live per keystroke.
  const sdChipEl = document.createElement('div');
  sdChipEl.id = 'sdChip';
  sdChipEl.innerHTML = '✦ <span id="sdBal">0</span><span id="sdRate" class="rate"></span>';
  wrapEl.insertBefore(sdChipEl, wrapEl.firstChild);
  const root = document.documentElement;
  const FONT_STACK = ${JSON.stringify(FONT_STACK)};
  let cellW = 3, cellH = 5.4, state = null, sec = 0, stageStartSec = 0, lastCrop = null, lastDims = null, lastLayoutAt = -1e9, layoutPending = false;

  // --- Fixed-cell layout (same approach as preview.html) ------------------
  // The sidebar is narrow, so cells scale down to fit the width — the
  // 10:18 ratio never changes. The font size is measured from the real
  // monospace font at runtime, so one glyph advance == one cell width.
  // At sidebar width the glyphs are tiny, but the planet's shape,
  // colors, rings and motion still read. (A full-size view is piece 4.)
  // Apply a cell size: the font is measured from the real monospace
  // font at runtime, so one glyph advance == one cell width.
  function applyCells(w, h) {
    cellW = w; cellH = h;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-family:' + FONT_STACK +
      ';font-size:16px;letter-spacing:0;white-space:pre;';
    probe.textContent = 'MMMMMMMMMMMMMMMMMMMM'; // 20 chars
    document.body.appendChild(probe);
    const adv16 = probe.offsetWidth / 20;
    probe.remove();
    let fs = 16 * cellW / adv16;
    if (fs > cellH) fs = cellH; // never taller than the cell
    root.style.setProperty('--pp-ch', cellH + 'px');
    root.style.setProperty('--pp-fs', fs.toFixed(2) + 'px');
  }
  function layout() {
    const avail = Math.max(50, wrapEl.clientWidth - 24);
    // The planet is cropped to its own extent (P.sidebarCrop), so the
    // cells size from the crop's width — the planet fills the sidebar
    // instead of sitting small in a big black grid. Before the first
    // state arrives there is no crop yet, so fall back to the full grid.
    const cropCols = lastCrop ? lastCrop.cols : P.CONFIG.W;
    const cropRows = lastCrop ? lastCrop.rows : P.CONFIG.H;
    // Height fit (Devon, Nov 12 — round 2): the collapsed sidebar
    // showed a scrollbar — the grid + text were taller than the view.
    // The grid shrinks to fit the view height, and the grown-from
    // line hides first when space is tight; in compact mode the stage
    // line hides too (round 3) — the XP bar and XP numbers always
    // stay. Compact margins under 200px.
    // Coarse fallback: if the fitted cells would drop below ~4px the
    // glyphs are dots, so the crop renders downsampled (half, then
    // quarter resolution) — a chunky mini planet with readable
    // characters, the "cozier version" Devon asked for. The tick
    // renders from lastDims, which layout() sets here.
    const viewH = document.documentElement.clientHeight || 0;
    let dims = { cols: cropCols, rows: cropRows };
    let newW = 0, newH = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const scale = avail / (dims.cols * P.CONFIG.CELL_W); // full scale = grid width in px
      newW = Math.max(1, +(10 * scale).toFixed(2));
      newH = Math.max(1.8, +(18 * scale).toFixed(2));
      if (viewH <= 0) break;
      document.body.classList.toggle('compact', viewH < 200);
      // Round 3: the body padding is measured (10px, 6px in compact),
      // not hardcoded — the old 24 (= 20 + 4 safety) over-reserved
      // once compact shrank the padding, stealing art height.
      const bodyCs = getComputedStyle(document.body);
      let reserve = parseFloat(bodyCs.paddingTop) + parseFloat(bodyCs.paddingBottom) + 4;
      // The dark card's own padding + border — measured, not guessed:
      // the first round-2 pass forgot it and still scrolled. The XP
      // bar + label live INSIDE the card now (round 3, Pokechi-style),
      // so their heights are already inside this term — do NOT add
      // them again below.
      const gridEl0 = wrapEl.querySelector('.pp-grid');
      reserve += wrapEl.offsetHeight - (gridEl0 ? gridEl0.offsetHeight : 0);
      // Text heights are measured with their real margins — hardcoded
      // guesses undercounted in compact mode (stageName's margin drops
      // to 2px there) and shrank the grid below its readable floor.
      const outerH = (el) => {
        if (!el) return 0;
        const cs = getComputedStyle(el);
        return el.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      };
      const sn = document.getElementById('stageName');
      const ml = document.getElementById('mutationLabel');
      const mt = document.getElementById('meta');
      // In compact mode #stageName is display:none, so outerH is 0
      // and the stage line's height goes back to the art for free.
      if (sn) reserve += outerH(sn);
      if (ml && ml.style.display !== 'none') reserve += outerH(ml);
      let metaH = (mt && mt.textContent) ? outerH(mt) : 0;
      const fitH = viewH - reserve;
      if (mt && mt.textContent && newH * dims.rows + metaH > fitH) {
        mt.style.display = 'none';
        metaH = 0;
      } else if (mt) {
        mt.style.display = '';
      }
      const maxCellH = Math.max(1.8, (fitH - metaH) / dims.rows);
      if (newH > maxCellH) {
        const k = maxCellH / newH;
        newW = Math.max(1, +(newW * k).toFixed(2));
        newH = maxCellH;
      }
      // Readable floor: below ~4px the glyphs are dots. Halve the
      // grid (bigger cells, same planet) and try again — at most twice.
      if (newH >= 4.2 || dims.cols <= 20 || dims.rows <= 10 || attempt === 2) break;
      dims = { cols: Math.ceil(dims.cols / 2), rows: Math.ceil(dims.rows / 2) };
    }
    lastDims = dims;
    if (newW === cellW && newH === cellH && root.style.getPropertyValue('--pp-fs')) return;
    applyCells(newW, newH);
    // No scrollHeight backstop here on purpose: when layout() runs,
    // the grid still holds the PREVIOUS render's row count, so a
    // scrollHeight read measures stale content and over-shrinks (the
    // first round-2 pass shrank the 150px view to 2px cells this way).
    // The fit is exact arithmetically — reserve is measured from real
    // offsetHeights and the grid is exactly dims.rows * cellH — plus a
    // 4px safety margin in the reserve for rounding.
  }
  layout();
  window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    // No planet growing (round 9 — destroyed with nothing picked
    // yet): clear back to the placeholder the webview started with.
    if (msg.type === 'empty') {
      state = null;
      lastCrop = null;
      gridEl.innerHTML = '';
      const barEl0 = document.getElementById('xpbar');
      const fillEl0 = document.getElementById('xpfill');
      const labelEl0 = document.getElementById('xplabel');
      barEl0.classList.remove('maxed');
      fillEl0.classList.remove('maxed');
      labelEl0.classList.remove('maxed');
      fillEl0.style.width = '0%';
      labelEl0.textContent = 'XP 0 / 100';
      document.getElementById('stageName').textContent = 'Your planet is hatching\u2026';
      document.getElementById('mutationLabel').style.display = 'none';
      const descEl = document.getElementById('stageDesc');
      descEl.style.display = '';
      descEl.textContent = msg.destroyed
        ? 'Nothing is growing \u2014 start a new planet from the Command Palette, or grow an old one from the Index.'
        : 'Pick a starter and start typing \u2014 every character grows it.';
      document.getElementById('meta').textContent = '';
      layout();
      return;
    }
    if (msg.type !== 'state') return;
    // No birth morph in the sidebar (Devon, Nov 12 — round 8): the
    // 3s condense read as a destroy animation when a planet was
    // recycled, and the per-tick crop changes + layout re-fits during
    // it lagged. A newborn shows settled immediately — its stage-0
    // look is already an exploded debris field, so nothing is lost.
    // The tick below still animates the living planet (orbiting
    // fragments, shimmer); only the morph is gone.
    stageStartSec = sec - 10; // settled — no birth morph
    state = msg;
    document.getElementById('stageName').textContent =
      'Stage ' + (msg.stageIdx + 1) + '/7 \\u00b7 ' + msg.stageName;
    const mutEl = document.getElementById('mutationLabel');
    if (msg.mutationLabel) { mutEl.textContent = msg.mutationLabel; mutEl.style.display = 'inline-block'; }
    else { mutEl.style.display = 'none'; }
    // Round 10 — the reveal moment: a mutation just landed (birth or
    // apply). The tag pulses gold for 2s and the card flickers once.
    // One-shot: the flag rides one push only, and the classes are
    // removed on a timer so typing never re-flashes them.
    if (msg.mutationFlash) {
      mutEl.classList.add('flash');
      wrapEl.classList.add('glitchFlash');
      setTimeout(function () { mutEl.classList.remove('flash'); wrapEl.classList.remove('glitchFlash'); }, 2000);
    }
    // No flavor text in the sidebar (Devon, Nov 11): the stage
    // description and the world details (terrain, ring, moons, seed,
    // minerals) live in the detail sheet / Index. The sidebar keeps
    // the stage line, the grown-from line, and the XP bar only. The
    // pre-hatch guidance above stays until the first state arrives.
    document.getElementById('stageDesc').style.display = 'none';
    // Maxed (Civilization+): the bar turns orange (Pokechi-style,
    // fully evolved). Past Civilization there is no next stage — the bar sits
    // full and the label says MAX instead of a threshold.
    const barEl = document.getElementById('xpbar');
    const fillEl = document.getElementById('xpfill');
    const labelEl = document.getElementById('xplabel');
    barEl.classList.toggle('maxed', !!msg.isMax);
    fillEl.classList.toggle('maxed', !!msg.isMax);
    labelEl.classList.toggle('maxed', !!msg.isMax);
    // Per-stage bar (round 6 — Devon): the bar resets at every
    // stage-up and shows progress inside the current stage plus the
    // new goal — "XP 192 / 200" in stage 1, not "XP 292 / 300". The
    // fill was already per-stage; only the numbers were cumulative.
    // Maxed (Civilization+): the bar sits full and the label says
    // MAX with the total XP, as before.
    const span = msg.nextXp === null ? 1 : Math.max(1, msg.span);
    const pct = msg.nextXp === null ? 100 : Math.max(0, Math.min(100, msg.inStage / span * 100));
    fillEl.style.width = pct.toFixed(1) + '%';
    labelEl.textContent = msg.nextXp === null
      ? 'XP ' + msg.xp + ' \\u00b7 MAX \\u2014 fully evolved'
      : 'XP ' + msg.inStage + ' / ' + span;
    // Round 14 — the meta line is the compact home of the current
    // planet's earn rate AND the Stardust balance: one short line,
    // no new panel.
    document.getElementById('meta').textContent = 'Grown from ' + msg.chars + ' characters · earns ' + msg.earnRateText + ' ✦/char · ✦' + Math.floor(msg.stardust).toLocaleString();
    // Round 17 (D) — the floating chip shows the same balance as the
    // meta line. Every keystroke pushes a fresh 'state' message, so
    // this stays live per character, like the status bar.
    document.getElementById('sdBal').textContent = Math.floor(msg.stardust || 0).toLocaleString();
    // Round 19 — the system's per-character total rides in the chip
    // next to the balance (the meta line already shows this planet's
    // own rate).
    var sdRateEl = document.getElementById('sdRate');
    if (sdRateEl) sdRateEl.textContent = '· +' + (msg.systemEarnRateText || '0') + '/char';
    layout(); // text heights changed — re-fit the grid to the view height
  });

  // Animate: ~7 fps is plenty for the flicker/drift illusion.
  setInterval(() => {
    sec += 0.15;
    if (!state) return;
    // Round 17, E — hidden guard (mirrors the system panel tick):
    // the sidebar rendered the full grid 7x/sec even while collapsed,
    // burning the shared webview thread for a panel nobody sees.
    // Note: sec still advances above so the animation resumes in
    // phase instead of jumping when the sidebar comes back.
    if (document.hidden) return;
    const t = Math.max(0, sec - stageStartSec);
    // Crop to the planet's own extent and render it star-free, so the
    // pet floats big on the VS Code gray instead of sitting small in
    // a black starfield box (Devon, Nov 12 — F5 feedback). The crop
    // only changes when the stage changes, so layout() re-runs when
    // it does — never every tick.
    const crop = P.sidebarCrop(state.planet, state.stageIdx, t);
    if (!lastCrop || crop.cols !== lastCrop.cols || crop.rows !== lastCrop.rows) {
      lastCrop = crop;
      layoutPending = true;
    }
    // Debounced layout (round 3, morph removed round 8): the crop
    // only changes on a stage change now, but each layout() still
    // forces a synchronous layout (getComputedStyle + offsetHeight
    // reads) on top of the render. Re-fit at most every 0.5s — t is
    // always >= 3 with no morph, so a pending re-fit also lands on
    // the next tick and the size is exact right away. The grid keeps
    // rendering from the last fitted dims in between — it only ever
    // gets coarser, never overflows. The first tick runs layout()
    // immediately (lastLayoutAt starts at -1e9), so the first paint is
    // at the correct measured size.
    if (layoutPending && (sec - lastLayoutAt >= 0.5 || t >= 3)) {
      layoutPending = false;
      lastLayoutAt = sec;
      layout();
    }
    const full = P.render(state.planet, state.stageIdx, t, sec, 1.0, undefined, 1, true);
    // Coarse mode (see layout()): at short heights the crop renders
    // downsampled so the cells stay readable — same planet, fewer,
    // bigger characters. The tick re-renders every 150ms, so a resize
    // picks the new resolution up on the next tick.
    const cropped = P.cropGrid(full, lastCrop);
    const shown = (lastDims && (lastDims.cols !== lastCrop.cols || lastDims.rows !== lastCrop.rows))
      ? P.downsampleGrid(cropped, lastDims.cols, lastDims.rows)
      : cropped;
    gridEl.innerHTML = P.gridToHtml(shown, cellW, cellH);
  }, 150);

  vscodeApi.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
  // -- step 4: the Solar System panel HTML -----------------------------------
  // Instrument direction (Devon, Nov 12): the orrery goes full-bleed
  // (tilted view: the orbit rings are ellipses seen at an angle, the
  // planet discs stay upright facing you — Stellaris-style, not a
  // top-down tabletop and not a side view that squashes the orbits
  // into a line), the Index is its own full-screen mode, and the
  // detail sheet only appears when you zoom into a planet. Same
  // fixed-cell rendering rule as the sidebar (gridToHtml + explicit
  // cell sizes, 10:18 ratio, never a bare <pre>). The panel never
  // pops anything up — it only posts place / remove messages, and
  // the extension decides.
  getSystemHtml(webview) {
    const nonce = getNonce();
    const planetJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'planet.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>
  /* The panel toggles sections with .hidden — but #slotsRow and
  #confirmBar set their own display, which beats the browser's
  built-in [hidden] rule. This line makes hidden actually hide. */
  [hidden] { display: none !important; }
  html, body { -webkit-text-size-adjust: none; text-size-adjust: none; }
  body { margin: 0; background: #050505; color: var(--vscode-editor-foreground);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    overflow: hidden; }
  /* Fixed-size cells — same rule as the sidebar (see getWebviewHtml). */
  /* Round 17 (F) — planet art is never selectable: dragging over the
     orrery discs, the sun, the detail art or an Index tile must not
     highlight characters. user-select is inherited, so this one rule
     covers every .pp-grid in this panel; the containers below get it
     too, so a drag starting on padding can't select either. */
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
    user-select: none; -webkit-user-select: none;
    -webkit-text-size-adjust: none; text-size-adjust: none; }
  .pp-run { display: inline-block; height: var(--pp-ch, 18px);
    line-height: var(--pp-ch, 18px); vertical-align: top; overflow: hidden;
    white-space: pre; font-kerning: none; }
  button { background: transparent; color: #d4d4d4;
    border: 1px solid #333; padding: 5px 11px; cursor: pointer; font-size: 12px;
    font-family: inherit; }
  button:hover { border-color: #e8b64c; color: #ffd75f; }
  button:disabled { opacity: .45; cursor: default; }
  button.ghost { background: transparent; border: 1px solid #333; color: #d4d4d4; }
  /* Starfield layer (Devon, Nov 12): the stars are a layer of the
     FRAME, not part of the planet. .pp-frame is the rectangle;
     .pp-stars fills it with sky; .pp-planet is the star-free planet
     render, centered, transparent where there is no planet — so the
     stars show through around it and never stop at the planet's
     edge. */
  .pp-frame { position: relative; }
  .pp-stars { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
  .pp-planet { position: relative; z-index: 1; width: fit-content; margin: 0 auto; }
  /* One thin top line: the title on the left, the mode tabs on the
     right. No eyebrow microcopy, no dashboard chrome (Devon, Nov 12). */
  #topbar { display: flex; align-items: center; gap: 16px;
    height: 36px; padding: 0 14px; border-bottom: 1px solid #1e1e1e;
    background: #050505; }
  #topTitle { font-size: 12px; white-space: nowrap; }
  #topTitle .dim { opacity: .55; }
  #modeTabs { display: flex; gap: 2px; margin-left: auto; }
  .tab { background: transparent; border: none; border-bottom: 1px solid transparent;
    color: #888; font-size: 12px; padding: 9px 10px 8px; cursor: pointer; }
  .tab:hover { color: #d4d4d4; }
  .tab.active { color: #e8b64c; border-bottom-color: #e8b64c; }
  /* Round 14 — the Stardust balance, top-right: a small pill with a
     star + the number, like other games' currency display. Amber on
     near-black so it reads against the orrery. Display-only (round
     15 revision, Devon Nov 14 — the separate Stardust tab is gone,
     so the chip is just the balance; the breakdown lives on each
     planet's detail sheet). */
  #stardustChip { display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border: 1px solid #e8b64c; border-radius: 999px;
    color: #e8b64c; font-size: 12px; white-space: nowrap;
    background: transparent; }
  /* Round 19 — the per-character rate rides dimmed inside both
     Stardust chips (system top bar + sidebar), so the balance stays
     the hero and the rate reads as the gain it is. */
  #stardustChip .rate, #sdChip .rate { opacity: .75; }
  #sdChip .rate { margin-left: 6px; }
  /* The orrery takes up the whole screen below the top line — the
     panel never scrolls to a second section anymore. The Index is
     its own mode, reached from the tabs above. */
  #orreryWrap { position: relative; height: calc(100vh - 37px);
    overflow: hidden; background: #050505; }
  #orrery { position: absolute; inset: 0; overflow: hidden; cursor: grab;
    user-select: none; -webkit-user-select: none; }
  #orrery.panning { cursor: grabbing; }
  #world { position: absolute; width: 1400px; height: 900px; left: 50%; top: 50%;
    margin-left: -700px; margin-top: -450px; transform-origin: 50% 50%; }
  .ring { position: absolute; border-radius: 50%; pointer-events: none; }
  .ring.open { border: 1px solid rgba(255, 255, 255, 0.10); }
  .ring.empty { border: 1px solid rgba(255, 255, 255, 0.16); }
  .ring.locked { border: 1px dashed rgba(255, 255, 255, 0.28); }
  /* Empty-ring hit area: a transparent ellipse over the ring line,
     clickable to open the Index picker. No persistent glyph, and
     NO gold outline on hover (Devon, Nov 12 — the gold ring sat on
     top of the ring and read as a second ring doubling it). Hover
     highlights the ring itself instead: the .ring gets .hot, which
     brightens and thickens its own border. */
  .ringHit { position: absolute; border-radius: 50%; cursor: pointer;
    border: 1px solid transparent; background: transparent; }
  .ring.hot { border-color: rgba(232, 182, 76, 0.95); border-width: 2px; }
  .lockLabel { position: absolute; transform: translate(-50%, -50%); font-size: 11px;
    color: rgba(255, 255, 255, 0.6); background: rgba(0, 0, 0, 0.65); padding: 3px 9px;
    border: 1px dashed rgba(255, 255, 255, 0.3); white-space: nowrap; }
  /* Counter-scale (Devon, Nov 12 — continuous zoom detail): the
     world scales by the camera zoom, but the planet discs and the sun
     must keep their glyphs at the final on-screen size, rasterized
     crisply — so each sprite scales back by 1/zoom (the --inv-zoom
     var, set by applyTransform). Their grid resolution grows with the
     zoom instead (discDetail / sunDetail), so zooming adds characters,
     never bigger letters. Rings, hit areas and lock labels are world
     geometry and do NOT counter-scale. */
  .disc { position: absolute; transform: translate(-50%, -50%) scale(var(--inv-zoom, 1)); cursor: pointer; }
  .disc:hover { outline: 1px solid rgba(232, 182, 76, 0.7); outline-offset: 2px; border-radius: 4px; }
  .disc.sel { outline: 1px solid #e8b64c; outline-offset: 2px; border-radius: 4px; }
  .star { position: absolute; transform: translate(-50%, -50%) scale(var(--inv-zoom, 1)); text-align: center; }
  /* Bottom-centre strip: zoom controls + the one-line hint. Overlay
     chrome only — it never takes space from the orrery. */
  #bottomStrip { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
    display: flex; gap: 10px; align-items: center; z-index: 4;
    font-size: 11px; color: rgba(255, 255, 255, 0.55); white-space: nowrap; }
  #bottomStrip button { padding: 2px 9px; }
  /* Detail sheet: a floating card beside the zoomed planet, not a
     modal over the system (Devon, Nov 12 — the old panel covered
     the orrery). It lives at body level so it works in both modes. */
  #detail { position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
    width: 340px; max-height: calc(100vh - 90px); overflow-y: auto; z-index: 20;
    background: #080808; border: 1px solid #2a2a2a; padding: 14px;
    transition: opacity 200ms ease; }
  #detail h2 { font-size: 16px; margin: 0 0 2px; }
  #detail .sub { font-size: 12px; opacity: .75; margin: 0 0 10px; line-height: 1.5; }
  #detailArt { background: #050505; border: 1px solid #222; padding: 4px; overflow-x: auto; margin-bottom: 10px;
    user-select: none; -webkit-user-select: none; }
  #detail .mut { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: #ffd75f; background: transparent;
    border: 1px solid rgba(255, 215, 95, 0.55); padding: 2px 7px; margin: 0 0 8px; }
  /* Round 17 (fix C) — detail sheet cleanup (Devon, Nov 15): way less
     text, organized. Name + inline chips, one meta line, name-only
     mutation chips, a 3-number vitals row, the earnings breakdown as
     a gold-bordered block, latest 3 journal entries. The old table,
     mutation title cards and set cards are gone. No Gen label
     anywhere in this sheet (Devon, Nov 15 — display-only). */
  #detail .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 6px; }
  #detail .chip { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: #ffd75f; background: transparent;
    border: 1px solid rgba(255, 215, 95, 0.55); padding: 2px 7px; }
  #detail .mutchips { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 10px; }
  #detail .mutchip { display: inline-block; font-size: 11px; font-weight: 700; color: #ffd75f;
    background: transparent; border: 1px solid rgba(255, 215, 95, 0.55); padding: 2px 7px; cursor: default; }
  /* Vitals row: three numbers, no table. */
  #detail .vitals { display: flex; border-top: 1px solid #222; border-bottom: 1px solid #222; margin: 0 0 10px; }
  #detail .vital { flex: 1; padding: 8px 6px; text-align: center; }
  #detail .vital + .vital { border-left: 1px solid #222; }
  #detail .vlabel { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; opacity: .55; margin-bottom: 2px; }
  #detail .vnum { font-size: 15px; font-weight: 700; }
  #detail .vnum.gold { color: #ffd75f; }
  #detail .vsub { font-size: 11px; opacity: .6; margin-top: 2px; }
  /* Earnings breakdown: the earnBreakdown lines, exact as computed —
     stage base / mutations / journal events / family combos — as a
     gold-left-border block, no header. Only lines that apply show. */
  #detail .earnblock { border-left: 2px solid #e8b64c; padding: 2px 0 2px 10px; margin: 0 0 10px; font-size: 12px; }
  #detail .ebline { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
  #detail .ebline .ebval { color: #ffd75f; white-space: nowrap; }
  #detail .benched { font-size: 12px; color: #e8b64c; margin: 0 0 10px; }
  #detail .prestigeline { font-size: 12px; color: #ffd75f; margin: 0 0 10px; }
  #detail .showall { background: none; border: none; color: #ffd75f; font-size: 11px;
    padding: 4px 0 0; cursor: pointer; text-align: left; }
  #detail button.primary { border: 1px solid #e8b64c; background: rgba(232, 182, 76, 0.14); color: #ffd75f; }
  #detail .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  #detail .note { font-size: 11px; opacity: .65; margin: 8px 0 0; line-height: 1.5; }
  /* Round 11 — the Discovery Journal: the planet's own history on
     its detail sheet. Plain lines, one date + one story beat each. */
  #detail h3 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
    color: #ffd75f; margin: 0 0 6px; }
  #detail .journal { font-size: 11px; line-height: 1.5; margin: 0 0 12px; }
  #detail .jentry { padding: 3px 0; border-top: 1px solid #1c1c1c; }
  #detail .jentry:first-child { border-top: none; }
  #detail .jdate { opacity: .55; margin-right: 6px; }
  #detail .jtitle { font-weight: 700; color: #ffd75f; }
  #detailClose { position: absolute; top: 8px; right: 8px; padding: 2px 8px; }
  /* Picker banner (choosing a planet for a ring). */
  #pickerBanner { background: #0a0a0a;
    border-bottom: 1px solid #e8b64c; color: #ffd75f; padding: 9px 16px; font-size: 12px;
    display: flex; gap: 12px; align-items: center; }
  /* The Index — the collection as its own full-screen mode (Devon,
     Nov 12: "Archive" renamed — they're not all archived). Big
     tiles, 2–3 per row, the planet's ASCII art as the tile, name +
     one datum, 1px hairline gaps, no card chrome. */
  #index { display: none; height: calc(100vh - 37px); overflow-y: auto;
    padding: 14px 28px 48px; background: #050505; }
  body.mode-index #index { display: block; }
  body.mode-index #orreryWrap { display: none; }
  /* The Mutations tab (round 19): Fusion hub + mineral inventory +
     Sets. The bingo card is gone (Devon, Nov 15) — a mutation lives
     on many planets, so listing carriers read like it can only be
     on one. */
  #mutations { display: none; height: calc(100vh - 37px); overflow-y: auto;
    padding: 14px 28px 48px; background: #050505; }
  body.mode-mutations #mutations { display: block; }
  body.mode-mutations #orreryWrap { display: none; }
  body.mode-mutations #index { display: none; }
  #mutCount { font-size: 11px; opacity: .55; margin: 0 0 10px; }
  .fusionHub { border: 1px solid rgba(232, 182, 76, .65); padding: 12px 14px; margin-bottom: 18px; }
  .fhubTitle { font-size: 13px; font-weight: 700; color: #ffd75f; }
  .fhubRules { font-size: 12px; opacity: .8; line-height: 1.6; margin-top: 4px; }
  .fhubRules b { color: #ffd75f; font-weight: 700; }
  .fusionSlots { display: flex; gap: 1px; background: #1e1e1e; margin-top: 10px; }
  .fusionSlot { flex: 1 1 0; background: #050505; padding: 10px 12px; display: flex; gap: 12px; align-items: center; min-width: 0; }
  .fusionSlot.empty { align-items: flex-start; }
  .fslotArt { width: 120px; flex: none; }
  .fslotBody { min-width: 0; }
  .fslotName { font-size: 13px; font-weight: 700; }
  .fslotMeta { font-size: 11px; opacity: .7; margin-top: 3px; line-height: 1.5; }
  .fslotReady { font-size: 11px; color: #ffd75f; margin-top: 6px; }
  .fslotProg { margin-top: 6px; }
  .fslotBar { height: 4px; background: #1e1e1e; }
  .fslotBar > div { height: 100%; background: #e8b64c; }
  .fslotProgText { font-size: 11px; opacity: .7; margin-top: 4px; }
  .fhubFoot { display: flex; align-items: center; gap: 14px; margin-top: 12px; flex-wrap: wrap; }
  #mutations button.primary { border: 1px solid #e8b64c; background: rgba(232, 182, 76, 0.14); color: #ffd75f; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .fhubCost { font-size: 12px; }
  .fhubCost b { color: #ffd75f; }
  .fhubState { font-size: 11px; opacity: .65; }
  .mutSectionHead { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #ffd75f; margin: 0 0 8px; }
  .mutSectionHead .mutSectionRight { float: right; letter-spacing: 0; text-transform: none; font-weight: 400; opacity: .75; color: #d4d4d4; }
  .minRow { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #1e1e1e; }
  .minBody { flex: 1; min-width: 0; }
  .minName { font-size: 13px; font-weight: 700; }
  .minDesc { font-size: 12px; opacity: .8; margin-top: 2px; }
  .minApply { font-size: 11px; opacity: .65; margin-top: 2px; line-height: 1.5; }
  /* Pokémon bag rule: the count lives in its own right-aligned column
     at a fixed x, never glued to the name — so the numbers line up
     down the list and you can scan them at a glance. The number is
     the hero (big, gold); the × is small and dim. */
  .minCount { flex: none; min-width: 64px; text-align: right; font-size: 18px; font-weight: 700; color: #ffd75f; }
  .minCount .x { font-size: 12px; font-weight: 400; opacity: .6; margin-right: 3px; }
  .minApplyBtn { flex: none; }
  .minTag { flex: none; font-size: 10px; letter-spacing: .08em; color: #888; border: 1px solid #333; padding: 4px 8px; }
  /* The action column is a fixed width too (button and tag alike) —
     otherwise the count column's x would shift with the action's
     width and the numbers would stop lining up. */
  .minApplyBtn, .minTag { width: 92px; text-align: center; box-sizing: border-box; }
  .minFooter { font-size: 11px; opacity: .55; margin-top: 8px; }
  .mutEmpty { font-size: 12px; opacity: .7; padding: 8px 0; }
  #mutSets { display: flex; gap: 1px; background: #1e1e1e; margin-bottom: 14px; flex-wrap: wrap; }
  .setCard { flex: 1 1 240px; background: #050505; padding: 12px 14px; }
  .setCard.earned { outline: 1px solid rgba(232, 182, 76, .65); outline-offset: -1px; }
  .setCard .sname { font-size: 13px; font-weight: 700; color: #ffd75f; }
  .setCard .sreq { font-size: 11px; opacity: .7; margin-top: 4px; line-height: 1.5; }
  .setCard .sdots { font-size: 11px; color: #ffd75f; margin-top: 6px; letter-spacing: 2px; }
  .setCard .sholder { font-size: 11px; color: #ffd75f; margin-top: 4px; }
  #indexCount { font-size: 11px; opacity: .55; margin: 0 0 10px; }
  #indexBar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  #search { flex: 1; min-width: 180px; background: #0a0a0a;
    color: #d4d4d4; border: 1px solid #333;
    padding: 6px 9px; font-size: 12px; font-family: inherit; }
  #sort { background: #0a0a0a; color: #d4d4d4;
    border: 1px solid #333; padding: 6px; font-size: 12px; }
  /* No gray rectangle (Devon, Nov 12 — F5 feedback): the grid's
     #1e1e1e background showed as a big gray block wherever there was
     no tile. The grid is panel black now; tiles are separated by
     1px hairlines only. */
  #tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0; background: #050505; }
  .tile { position: relative; background: #050505; padding: 14px 14px 12px; cursor: pointer; border-bottom: 1px solid #1e1e1e; border-right: 1px solid #1e1e1e; }
  .tile:hover { background: #0a0a0a; }
  /* Round 10 — legendary: a mutated planet's tile gets a gold outline
     and a ✦ in the top-right corner (✦×N when it carries several).
     Plain tiles stay plain. */
  .tile.mutated { outline: 1px solid rgba(232, 182, 76, .65); outline-offset: -1px; }
  .tile .corner { position: absolute; top: 8px; right: 10px; color: #ffd75f; font-size: 16px; font-weight: 700; z-index: 2; }
  .tile .art { display: flex; justify-content: center; background: #050505; margin-bottom: 10px; overflow: hidden;
    user-select: none; -webkit-user-select: none; }
  .tile .tname { font-size: 13px; font-weight: 600; }
  .tile .tmeta { font-size: 11px; opacity: .7; line-height: 1.5; margin-top: 2px; }
  /* Round 11 — the tile's one-line journal: the planet's latest story beat. */
  .tile .jline { font-size: 11px; opacity: .85; line-height: 1.5; margin-top: 2px; font-style: italic; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; padding: 1px 6px; margin: 4px 4px 0 0; }
  .badge.sys, .badge.cur { color: #ffd75f; border: 1px solid rgba(255, 215, 95, 0.5); }
  /* Round 17 (fix C) — mutation pills (Devon, Nov 15): violet, not
     gold, so a mutation reads at a glance against the gold status
     pills (In system / Growing now). Filled tint, where the status
     pills are outline-only, for one more glanceable difference.
     Gold stays the legendary/set color — violet is mutation-only. */
  .badge.mut { color: #c9a6ff; border: 1px solid rgba(183, 140, 255, 0.6); background: rgba(183, 140, 255, 0.12); }
  .empty { font-size: 13px; opacity: .65; padding: 18px 0; }
  /* Hide-UI (H): only the orrery stays. */
  body.hide-ui #topbar, body.hide-ui #bottomStrip { display: none !important; }
  body.hide-ui #detail { visibility: hidden; }
  /* The way back (Devon, Nov 12 — F5 feedback: he hid the UI and got
     stuck with no visible way back). A minimal pill in the
     bottom-left corner while the UI is hidden — click it, or press H
     or Esc, to show the interface again. */
  #showUiPill { display: none; position: fixed; left: 14px; bottom: 12px; z-index: 30; }
  body.hide-ui #showUiPill { display: block; }
</style>
</head>
<body>
<header id="topbar">
  <div id="topTitle">SOLAR SYSTEM <span class="dim" id="rankLine">Loading&hellip;</span></div>
  <div id="modeTabs">
    <button id="tabOrrery" class="tab active" data-mode="orrery">Orrery</button>
    <button id="tabIndex" class="tab" data-mode="index">Index</button>
    <button id="tabMutations" class="tab" data-mode="mutations">Mutations</button>
  </div>
  <div id="stardustChip" title="Stardust — earned per character typed">✦ <span id="stardustBal">0</span><span id="stardustRate" class="rate"></span></div>
  <button id="hideUiBtn" class="ghost" title="Hide the interface (H)">Hide UI</button>
</header>
<div id="orreryWrap">
  <div id="orrery"><div id="world"></div></div>
  <div id="bottomStrip">
    <button id="zoomOut" title="Zoom out">&minus;</button>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="fitBtn" title="Fit the whole system">Fit</button>
    <span>Drag to pan &middot; Scroll to zoom &middot; Click a planet to zoom in &middot; H hides the UI</span>
  </div>
</div>
<div id="detail" hidden></div>
<div id="pickerBanner" hidden></div>
<button id="showUiPill" class="ghost" title="Show the interface (H)">H &middot; show UI</button>
<section id="index">
  <p id="indexCount"></p>
  <div id="indexBar">
    <input id="search" type="text" placeholder="Search name, terrain, seed&hellip;" autocomplete="off">
    <select id="sort">
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="most">Most characters</option>
      <option value="mutated">Most mutated</option>
      <option value="earners">Highest earners</option>
      <option value="name">Name A&ndash;Z</option>
      <option value="terrain">Terrain</option>
    </select>
    <select id="mutFilter">
      <option value="">All planets</option>
      <option value="mutated">Mutated only</option>
    </select>
  </div>
  <div id="tiles"></div>
</section>
<section id="mutations">
  <p id="mutCount"></p>
  <div id="fusionHub"></div>
  <div id="mutMinerals"></div>
  <div class="mutSectionHead">Sets</div>
  <div id="mutSets"></div>
</section>
<script nonce="${nonce}" src="${planetJsUri}"></script>
<script nonce="${nonce}">
(function () {
  var vscodeApi = acquireVsCodeApi();
  var P = window.Protoplanet;
  // TILT is the ring squash (scaleY): 1.0 would be top-down, 0 a side
  // view. 0.34 is a little more tilted than the first 0.42 (Devon,
  // Nov 11 — steeper reads more realistic) but the rings are still
  // clearly ellipses, not a line.
  // The orrery spreads across the panel: innermost ring R0 = 330,
  // outermost RMAX = 640 (the world is 1400 wide, so 640 + a disc's
  // half-width fits with no clipping). Ring 0's top clears the star:
  // 330 * 0.34 = 112 > star half-height 70 + disc half-height 27.5.
  // MIN_SEP is the minimum angular separation the geometry needs
  // between any two placed planets (25 deg — measured: at 25deg two
  // worst-case ringed discs still clear each other). The slot scheme
  // below guarantees far more than that for the discs that matter,
  // and UNIFORM drift (every ring advances by the same angle per tick)
  // keeps the relative angles fixed forever — no planet ever overlaps
  // the sun or another planet. (Devon, Nov 11: the v2 overlap looked
  // like a mess — separation is geometric now, not draw order.)
  var WORLD_W = 1400, WORLD_H = 900, CX = 700, CY = 450, TILT = 0.34;
  var R0 = 330, RMAX = 640, MIN_SEP = 25 * Math.PI / 180;
  var state = null, sec = 0, zoom = 1, fitZoom = 1, panX = 0, panY = 0;
  var angles = {}; // ring index -> current angle (radians)
  var anglePlanet = {}; // ring index -> 'seed:generation' the angle belongs to
  var hoverPlanet = false, detailOpen = false, pickerRing = null;
  var selected = null; // { seed, generation } of the planet in the detail sheet
  var detailJournalAll = false; // detail sheet: journal expanded to all entries (round 17)
  var searchText = '', sortMode = 'newest';
  var lastSig = '', discs = []; // [{ el, planet, ring }]
  var mode = 'orrery'; // 'orrery' | 'index' — two full screens, not one crowded one (Devon, Nov 12)
  var zoomed = false, prevView = null; // zoom-to-planet: the view before the zoom, restored on close
  var starGridEl = null; // the star's .pp-grid — re-rendered on the tick so the sun churns + flares
  var orreryEl = document.getElementById('orrery');
  var worldEl = document.getElementById('world');
  var detailEl = document.getElementById('detail');
  var bannerEl = document.getElementById('pickerBanner');
  var tilesEl = document.getElementById('tiles');

  // Starfield layer (Devon, Nov 12): fill a .pp-frame with twinkling
  // stars sized to the frame's own box. The frame carries its planet
  // grid's cell size + atmosphere color in data attrs; the star grid
  // is sized from the frame's pixel size (scroll size, so a frame
  // wider than its box still gets sky under the scroll). Call after
  // the frame is in the DOM, and on the tick so the stars twinkle.
  function fillStars(frameEl, sec) {
    var starsEl = frameEl.querySelector('.pp-stars');
    if (!starsEl) return;
    var cw = parseFloat(frameEl.getAttribute('data-cw')) || 3.4;
    var ch = parseFloat(frameEl.getAttribute('data-ch')) || 6.12;
    var atmo = parseInt(frameEl.getAttribute('data-atmo') || '244', 10);
    var w = Math.max(frameEl.clientWidth || 0, frameEl.scrollWidth || 0);
    var h = Math.max(frameEl.clientHeight || 0, frameEl.scrollHeight || 0);
    var cols = Math.max(1, Math.ceil(w / cw));
    var rows = Math.max(1, Math.ceil(h / ch));
    starsEl.style.width = w + 'px';
    starsEl.style.height = h + 'px';
    starsEl.innerHTML = '<div class="pp-grid" style="--pp-fs:' + cellFont(cw, ch) + 'px;--pp-ch:' + ch + 'px">'
      + P.starfieldHtml(cols, rows, sec, atmo, cw, ch) + '</div>';
  }
  function refreshStarfields() {
    var frames = document.querySelectorAll('.pp-frame');
    for (var i = 0; i < frames.length; i++) fillStars(frames[i], sec);
  }
  // Glyph font size (Devon, Nov 12 — round 2): the panel used to set
  // every .pp-grid's font size from the CELL HEIGHT, but a monospace
  // glyph's advance is ~0.6x its font size — so at 2.6px-wide cells
  // with a 6.12px font the glyphs were painted 42% wider than their
  // cells, overlapping each other and clipping at the end of each
  // color run (measured in headless Chrome: a 3-char run set to 7.8px
  // wide actually needs 11px). The font is now sized from the CELL
  // WIDTH: the advance ratio is measured once from the real font, and
  // the size is the smaller of cellW / ratio (glyphs fit their cells)
  // and cellH (never taller than the cell). The sidebar already did
  // this; the panel didn't — which is why the sidebar read best.
  var _advRatio = null;
  function cellFont(cellW, cellH) {
    if (_advRatio === null) {
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;font-family:' + getComputedStyle(document.body).fontFamily + ';font-size:16px;letter-spacing:0;white-space:pre;';
      probe.textContent = 'MMMMMMMMMMMMMMMMMMMM';
      document.body.appendChild(probe);
      _advRatio = (probe.offsetWidth / 20) / 16;
      probe.remove();
    }
    return +Math.min(cellW / _advRatio, cellH).toFixed(2);
  }
  // --- modes: Orrery <-> Index <-> Mutations ------------------------------
  // Three full screens, not one crowded one (Devon, Nov 12 — the
  // research's strongest pattern): each mode gets 100% of the panel,
  // so neither the orrery nor the collection has to shrink for the
  // other. The Mutations tab (round 10) is the collection view.
  // (Round 15 revision, Devon Nov 14: a 4th Stardust tab was built
  // and rejected — the earnings breakdown belongs on each planet's
  // detail sheet, not on a separate screen.)
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    document.body.classList.toggle('mode-index', m === 'index');
    document.body.classList.toggle('mode-mutations', m === 'mutations');
    document.getElementById('tabOrrery').classList.toggle('active', m === 'orrery');
    document.getElementById('tabIndex').classList.toggle('active', m === 'index');
    document.getElementById('tabMutations').classList.toggle('active', m === 'mutations');
    if (m === 'orrery') {
      // The orrery was display:none — its size is 0 until it is back,
      // so recompute the fit and re-apply the current view.
      computeFit();
      applyTransform();
    }
    if (m === 'index') {
      // The tiles are in the DOM now, so their art width measures
      // for real instead of falling back to the estimate.
      renderIndex();
    }
    if (m === 'mutations') renderMutations();
  }
  document.getElementById('tabOrrery').addEventListener('click', function () { setMode('orrery'); });
  document.getElementById('tabIndex').addEventListener('click', function () { setMode('index'); });
  document.getElementById('tabMutations').addEventListener('click', function () { setMode('mutations'); });
  document.getElementById('hideUiBtn').addEventListener('click', function () {
    document.body.classList.toggle('hide-ui');
  });
  // The way back from a hidden UI (Devon, Nov 12 — F5 feedback).
  // H and Esc also bring it back (see the keydown handler below).
  document.getElementById('showUiPill').addEventListener('click', function () {
    document.body.classList.remove('hide-ui');
  });

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function ringRadius(i, total) {
    var spacing = Math.max(28, Math.min(160, (RMAX - R0) / Math.max(1, total - 1)));
    return R0 + i * spacing;
  }
  // Slot angles: the gap after ring i is SLOT_C / SLOT_R[i], so inner
  // rings (small radius) get wider gaps — the same angle is fewer
  // pixels of arc there, so they need more of it to keep the discs
  // clear. The gaps are scaled so all 12 sum to a full circle (42deg
  // at ring 0 down to 22deg at ring 11). The radii are the FIXED
  // 12-ring layout (the tightest spacing), so the slots never move
  // when rings unlock — and with fewer rings the spacing is wider, so
  // the same slots are even safer. A small seeded jitter (+/-2deg)
  // keeps it from looking mechanical. Measured (worst case, 12 rings,
  // max-size discs, jitter at its worst): the tightest pair still
  // clears by 6px. Uniform drift preserves these angles forever.
  // (Devon, Nov 11: no overlap. A uniform 30deg slot and a greedy
  // nudge scheme were both tried first and both failed at 12 rings —
  // the inner rings are too close together for them. The orbit is
  // always on; there is no static mode and no toggle.)
  var SLOT_R = [];
  for (var si = 0; si < 12; si++) SLOT_R.push(R0 + si * (RMAX - R0) / 11);
  var SLOT_C = 0;
  for (var si = 0; si < 12; si++) SLOT_C += 1 / SLOT_R[si];
  SLOT_C = (Math.PI * 2) / SLOT_C;
  function slotAngle(planet, ring) {
    var a = 0;
    for (var i = 0; i < ring; i++) a += SLOT_C / SLOT_R[i];
    var jitter = (P.mulberry32((planet.seed ^ 0x51ab) >>> 0)() - 0.5) * (4 * Math.PI / 180);
    return a + jitter;
  }
  function planetPos(slot, angle) {
    var R = ringRadius(slot.index, state.slots.length);
    return { x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) * TILT };
  }
  function findPlanet(seed, generation) {
    if (!state) return null;
    for (var i = 0; i < state.index.length; i++) {
      var p = state.index[i];
      if (p.seed === seed && p.generation === generation) return p;
    }
    return null;
  }
  function slotOf(seed, generation) {
    if (!state) return -1;
    for (var i = 0; i < state.slots.length; i++) {
      var pl = state.slots[i].planet;
      if (pl && pl.seed === seed && pl.generation === generation) return i;
    }
    return -1;
  }
  function firstEmptyRing() {
    if (!state) return -1;
    for (var i = 0; i < state.slots.length; i++) {
      if (state.slots[i].unlocked && !state.slots[i].planet) return i;
    }
    return -1;
  }

  // --- star (same ASCII look as the planets: a shaded mini sphere) ------
  // A hero, not a dot (Devon, Nov 11): a big bright sphere, clearly
  // THE SUN, dominating the center — granulated, warm halo, and ALIVE:
  // it was frozen while the planets orbited. Now the granulation CHURNS —
  // each granule brightens as hot plasma rises and dims as it cools
  // and sinks, on its own lifecycle, so the surface visibly turns
  // over instead of pulsing as one — plus SOLAR FLARES erupting from
  // the limb on a long deterministic cycle, and little limb flames
  // that FIZZLE — each one flickers on its own fast phase, so the
  // outline is alive too (Devon, Nov 11: the fringe was frozen in
  // every clip).
  // Rotation is deliberately NOT forced: the churn + flares are the
  // motion, and they read more like a real star than a spinning
  // painted ball. Finer grid (84x42, 3.67px cells) at the same display
  // size, so the granulation reads detailed.
  // BRIGHT, not burnt orange (Devon, Nov 11 — v2 read dark and flat):
  // lifted value floor + gamma lift, so the disc reads bright yellow
  // with white-ish yellow (229) peaks on the granules. The brightness
  // lives in the granulation highlights — NO separate bright core at
  // all (the old inner-disc branch painted a big bright disc that
  // read as a confusing white circle in the middle, Devon, Nov 11),
  // and NO stamped white-hot core either: brightest color anywhere
  // on the sun is 229, never 231.
  // THREE-DIMENSIONAL, not a flat disc (Devon, Nov 11 — v2 read like
  // three flat colors): strong radial limb darkening — bright center
  // falling off to a darker limb — plus an extra fade in the outermost
  // rim, so the disc reads as a sphere with faded edges, like the
  // planets. The shading is a graded warm ramp in small steps, not
  // bright-yellow / dark-red jumps — the old patchy camo look.
  // RARE flares (Devon, Nov 11 — three in 6s read as constant): each
  // big flare erupts for ~2.2s on a long period (47/63/89s), so the
  // sites erupt roughly once every 20s between them — a short look
  // usually catches none, a longer watch catches one.
  // Continuous sun resolution (Devon, Nov 12 — F5 feedback): the sun
  // used to render once at a fixed 84x42 and get CSS-scaled, so
  // zoomed in it was a giant pixel blob and zoomed out a tiny one.
  // Now it takes its resolution (cols/rows/cell size) from
  // P.sunDetail(zoom) — fewer chars zoomed out, more zoomed in,
  // glyph size constant. Defaults are the old 84x42, so the existing
  // sun clips and tests still work unchanged.
  function starHtml(sec, cols, rows, cellW, cellH) {
    if (sec === undefined) sec = 0;
    if (cols === undefined) cols = 84;
    if (rows === undefined) rows = 42;
    if (cellW === undefined) cellW = 3.67;
    if (cellH === undefined) cellH = 6.6;
    var W = cols, H = rows, mx = cols / 2, my = rows / 2, mr = rows / 2;
    var grid = [];
    for (var y = 0; y < H; y++) { var row = []; for (var x = 0; x < W; x++) row.push([' ', null]); grid.push(row); }
    // Smooth granule field: bilinear interpolation of the sin-hash
    // noise, so granules have soft edges instead of hard 2-cell
    // blocks (part of the old camo look).
    function smoothGn(u, v) {
      var ix = Math.floor(u), iy = Math.floor(v);
      var fx = u - ix, fy = v - iy;
      var sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      var a = P.noise2(ix, iy, 7), b = P.noise2(ix + 1, iy, 7);
      var c = P.noise2(ix, iy + 1, 7), d = P.noise2(ix + 1, iy + 1, 7);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
    // FLAME TONGUES on the disc edge itself (Devon, Nov 11 — batch
    // #7): the disc's silhouette bumps were frozen — the old edge was
    // a slow +/-1-cell sin wobble (invisible at this scale) and the
    // bright rim pattern is pinned to the static granulation field,
    // so the same bumps (left, top-left, bottom-left, bottom-right)
    // sat in the same spots in every clip. Now the edge carries a
    // population of little flames: each flame is a tongue of the disc
    // edge that grows out and dies back on its own few-second
    // lifecycle, at an angle that DRIFTS while it lives — so new
    // flames pop out at different places around the rim, like the
    // ball is on fire. Every flame is DIFFERENT (Devon, Nov 11
    // refinement — not one bump shape stamped around the rim): each
    // has its own height (taller/shorter), width (wider/narrower),
    // tip profile (needle vs broad) and lifecycle, so the silhouette
    // shows varied teardrop tongues, not identical copies. All
    // shading below is measured against the LOCAL edge (d2rel), so
    // the rim fade and the halo fringe hug the moving flames. Same
    // style/colors/granulation as before — only the silhouette
    // changes. Big flares are untouched (still rare).
    // a0: base angle (screen space, y down — same as the flares).
    // drift: rad/s the flame travels around the rim while it lives.
    // period/phase: its grow-die lifecycle. h: max height in rho
    // (0.26 ≈ 5 cells out sideways). w: half-width in radians.
    // p: tip profile exponent (1.0 = straight triangle, 2.0 = needle).
    // CALMED DOWN (Devon, Nov 11 — batch #8): v7 was "a little too
    // violent — too many flames happening at once and too quick".
    // 7 flames -> 4, lifecycles roughly doubled (5.4-9.8s), drift
    // halved, so fewer flames are up at once and each one grows,
    // peaks and dies slowly. They still vary in shape and still pop
    // out at different places — just calmer. Phases are staggered
    // so the peaks don't bunch up.
    var FLAMES = [
      { a0: 0.4, drift: 0.05, period: 6.2, phase: 0.18, h: 0.24, w: 0.20, p: 1.0 },
      { a0: 1.9, drift: -0.04, period: 8.6, phase: 0.12, h: 0.14, w: 0.12, p: 2.0 },
      { a0: 3.6, drift: 0.06, period: 5.4, phase: 0.94, h: 0.32, w: 0.24, p: 1.3 },
      { a0: 5.3, drift: -0.03, period: 9.8, phase: 0.34, h: 0.38, w: 0.30, p: 1.8 },
    ];
    function edgeRadius(th) {
      var r = 1;
      for (var k = 0; k < FLAMES.length; k++) {
        var fl = FLAMES[k];
        var u = ((sec / fl.period + fl.phase) % 1 + 1) % 1;
        var env = Math.pow(Math.sin(Math.PI * u), 1.5); // grow -> peak -> die
        if (env < 0.02) continue;
        var fa = fl.a0 + fl.drift * sec;
        var dth = th - fa;
        while (dth > Math.PI) dth -= 2 * Math.PI;
        while (dth < -Math.PI) dth += 2 * Math.PI;
        var ad = Math.abs(dth);
        if (ad >= fl.w) continue;
        var shape = 1 - ad / fl.w; // triangular: pointed tip, wide base
        var tongue = fl.h * env * Math.pow(shape, fl.p);
        if (1 + tongue > r) r = 1 + tongue;
      }
      return r;
    }
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var sx = (x - mx) / mr, sy = (y - my) / mr;
        var d2 = sx * sx + (2 * sy) * (2 * sy);
        var d2rel = d2 / Math.pow(edgeRadius(Math.atan2(2 * sy, sx)), 2);
        if (d2rel <= 1) {
          // Granulation: one treatment across the whole disc, no
          // separate core. Churn: each granule's lifecycle phase
          // comes from its own noise value, so neighbours are out of
          // phase — the surface turns over granule by granule (~7s
          // cycle). A fine detail layer keeps granules from reading
          // as flat blocks.
          var gn = smoothGn(x / 2.5, y / 2.5);
          var dn = smoothGn(x / 1.15 + 47, y / 1.15 + 31);
          // Lifecycle phase from its OWN noise field — NOT from gn:
          // coupling life to gn made the brightest granules
          // systematically dim (measured: zero 229 cells at sec=6,
          // 18% at sec=3). Decoupled, the bright peaks are reliably
          // present at every moment.
          var ph = smoothGn(x / 2.5 + 31, y / 2.5 + 17);
          var life = 0.5 + 0.5 * Math.sin(sec * 0.9 + ph * 6.283);
          var sz = Math.sqrt(Math.max(0, 1 - d2rel));
          // Bright + dimensional (Devon, Nov 11 — v2 was too dark and
          // too flat): lifted granule floor (g) and gamma lift keep
          // the disc bright yellow with 229 peaks; strong radial limb
          // darkening (r) plus an extra fade in the outermost rim
          // (edge) make it read as a sphere with faded edges, not a
          // flat disc. The brightest peaks are white-ish yellow
          // (229) — but the brightness lives in the granulation,
          // never a stamped core.
          var g = 0.30 + 0.70 * gn;
          var l = 0.60 + 0.40 * life;
          var r = 0.50 + 0.50 * sz;
          var edge = d2rel > 0.8 ? 1 - (d2rel - 0.8) * 2.5 : 1;
          var v = Math.pow(g * l * r * edge * (0.94 + 0.12 * dn), 0.7);
          // Graded warm ramp, small steps — neighbours blend instead
          // of jumping. Bright bands use DENSE glyphs ('#', '@') so
          // the sun reads solid and blazing, not a field of dots;
          // dark lanes bottom out at 208 (not 202) except in the
          // darkest rim lanes, and 229 '@' crowns the brightest
          // granule peaks.
          grid[y][x] = v < 0.18 ? ['.', 202]
            : v < 0.32 ? [':', 208]
            : v < 0.46 ? ['+', 214]
            : v < 0.60 ? ['*', 220]
            : v < 0.74 ? ['#', 226]
            : v < 0.84 ? ['#', 229]
            : ['@', 229];
        } else if (d2rel <= 1.3) {
          // LIMB FLAMES — tongues of flame that TRAVEL around the
          // rim (Devon, Nov 11 — batch #6): flickering in place
          // (batch #4) and a +/-1-cell wobble (batch #5) both left
          // the same bumps sitting in the same spots — left,
          // bottom-left, top-left, bottom-right — in every clip.
          // The flame sites were a fixed spatial noise field, so
          // the bumps could only blink, never move: measured
          // before the fix, the top bump angles (165deg, 205deg,
          // 335deg) were identical at sec=0/2/6/12/14 and the
          // lit-angle sets overlapped 0.60-0.75 (Jaccard). Now the
          // tongue field is sampled on a circle in noise space
          // that drifts with time, so new tongues pop out at
          // different angles while old ones die away — like the
          // ball is on fire. Same look as before — small warm
          // specks just outside the limb, one cell, '.'-dominant
          // — only the positions travel. The big flares are
          // untouched (still rare), as is the granulation churn.
          var ang = Math.atan2(2 * sy, sx);
          var tu = Math.cos(ang) * 11.5 + sec * 0.55;
          var tv = Math.sin(ang) * 11.5 + sec * 0.35;
          var fn = smoothGn(tu, tv);
          if (fn > 0.60) {
            var fph = smoothGn(tu + 31, tv + 17);
            // Round 2: the flicker ran at 3.1 rad/s — at a 300ms
            // frame that was a ~1 rad jump per frame, a strobe on
            // the rim. 1.5 rad/s keeps the flames alive without it.
            var ff = 0.5 + 0.5 * Math.sin(sec * 1.5 + fph * 6.283);
            var fd = 1 - (d2rel - 1) / 0.3 * 0.35; // outer fringe slightly dimmer — stays tight to the limb
            var fv = ff * fd;
            if (fv > 0.95) grid[y][x] = ['*', 226];
            else if (fv > 0.85) grid[y][x] = ['+', 220];
            else if (fv > 0.45) grid[y][x] = ['.', 214];
            else if (fv > 0.25) grid[y][x] = ['.', 202];
          }
        }
      }
    }
    // Solar flares: three fixed limb sites, each erupting on its own
    // LONG deterministic cycle (angle in screen space, y down). A big
    // flare is a RARE event (Devon, Nov 11): each eruption lasts
    // ~2.2s and each site erupts only once per 47/63/89s, so across
    // the three sites a flare shows up roughly once every 20s — a
    // short look usually catches none. Timed so a 15s clip catches
    // the left-limb flare ~9s in.
    var FLARES = [
      { a: 3.5, period: 47, start: 9 },
      { a: -1.1, period: 63, start: 35 },
      { a: 2.2, period: 89, start: 63 }
    ];
    var FLARE_DUR = 2.2;
    for (var f = 0; f < FLARES.length; f++) {
      var fl = FLARES[f];
      var ft = (sec - fl.start) % fl.period;
      if (ft < 0) ft += fl.period;
      if (ft > FLARE_DUR) continue;
      var fe = Math.sin(Math.PI * ft / FLARE_DUR); // 0 -> 1 -> 0 across the eruption
      if (fe < 0.08) continue;
      var fh = 0.38 * fe; // arch height in rho units (~4 grid cells at the tip — tall enough to read as a loop, not a bump)
      var fw = 0.26; // arch half-width in radians
      var ca = Math.cos(fl.a), sa = Math.sin(fl.a);
      // Footpoint sits on the WOBBLING edge (same edgeRadius), so a
      // flare never detaches from the moving outline.
      var fR = edgeRadius(fl.a);
      var fx = Math.round(mx + mr * fR * ca), fy = Math.round(my + (mr / 2) * fR * sa);
      if (grid[fy] && grid[fy][fx]) grid[fy][fx] = ['*', 229];
      for (var d = -fw; d <= fw; d += 0.03) {
        var rho = fR * (1.02 + fh * (1 - (d / fw) * (d / fw)));
        var ax = Math.round(mx + mr * rho * Math.cos(fl.a + d));
        var ay = Math.round(my + (mr / 2) * rho * Math.sin(fl.a + d));
        if (ay < 0 || ay >= H || ax < 0 || ax >= W) continue;
        // Cooler at the base, hottest at the tip. Two cells thick so
        // the loop reads at the panel's fitted scale.
        var fch = rho < 1.08 ? ['#', 220] : (rho < 1.16 ? ['*', 226] : ['@', 229]);
        grid[ay][ax] = fch;
        var rho2 = rho - 0.05;
        var ax2 = Math.round(mx + mr * rho2 * Math.cos(fl.a + d));
        var ay2 = Math.round(my + (mr / 2) * rho2 * Math.sin(fl.a + d));
        if (ay2 >= 0 && ay2 < H && ax2 >= 0 && ax2 < W) grid[ay2][ax2] = fch;
      }
    }
    // No fixed star specks around the sun (Devon, Nov 12): six
    // stamped cells used to sit at fixed grid spots and never move —
    // standing-still stars. The limb flames + halo already give the
    // sun its edge life; nothing static is stamped here anymore.
    return P.gridToHtml(grid, cellW, cellH);
  }

  // --- orrery ------------------------------------------------------------
  function renderOrrery() {
    if (!state) return;
    // Round 17, E — stuck-frozen fix: this rebuild destroys every disc
    // node (worldEl.innerHTML = '' below), so a pointer hovering a disc
    // never gets a mouseout and hoverPlanet stays true forever — the
    // drift stays paused until he re-hovers. Reset it here; the next
    // mousemove/mouseover corrects it if he is still hovering.
    hoverPlanet = false;
    worldEl.innerHTML = '';
    discs = [];
    var total = state.slots.length;
    // Star at the center, at the bottom of the stack. Planets never
    // overlap it or each other: ring 0 clears the star (see the R0
    // note above) and every ring has a fixed 30deg slot with uniform
    // drift (Devon, Nov 11 — the v2 overlap was a mess).
    var star = document.createElement('div');
    star.className = 'star';
    star.style.left = CX + 'px';
    star.style.top = CY + 'px';
    star.style.zIndex = '1';
    var sd0 = P.sunDetail(zoom);
    star.innerHTML = '<div class="pp-grid" style="--pp-fs:' + cellFont(sd0.cellW, sd0.cellH) + 'px;--pp-ch:' + sd0.cellH + 'px">' + starHtml(sec, sd0.cols, sd0.rows, sd0.cellW, sd0.cellH) + '</div>';
    starGridEl = star.querySelector('.pp-grid');
    worldEl.appendChild(star);
    // Rings + planets.
    // lockSeen counts the locked-ring labels drawn so far (at most two):
    // adjacent ring tops are only (spacing * TILT) apart — under one
    // label height when many rings exist — so each later label sits
    // 26px higher and the two can never collide.
    var lockSeen = 0;
    for (var i = 0; i < total; i++) {
      var slot = state.slots[i];
      var R = ringRadius(i, total);
      var ring = document.createElement('div');
      ring.className = 'ring ' + (slot.unlocked ? (slot.planet ? 'open' : 'empty') : 'locked');
      ring.setAttribute('data-ring', String(i)); // hover highlight finds its ring by this
      ring.style.left = (CX - R) + 'px';
      ring.style.top = (CY - R) + 'px';
      ring.style.width = (2 * R) + 'px';
      ring.style.height = (2 * R) + 'px';
      ring.style.transform = 'scaleY(' + TILT + ')';
      ring.style.zIndex = '2';
      worldEl.appendChild(ring);
      if (!slot.unlocked) {
        var lab = document.createElement('div');
        lab.className = 'lockLabel';
        lab.style.left = CX + 'px';
        lab.style.top = (CY - R * TILT - 16 - lockSeen * 26) + 'px';
        lab.style.zIndex = '3';
        lab.textContent = slot.unlockLabel || ('Ring ' + (i + 1) + ' — locked');
        worldEl.appendChild(lab);
        lockSeen++;
        continue;
      }
      if (slot.planet) {
        // (Re)assign this ring's angle when the planet on it is new or
        // changed — one fixed slot per ring (see slotAngle), so the
        // separation holds for any subset of rings.
        var pkey = slot.planet.seed + ':' + slot.planet.generation;
        if (angles[i] === undefined || anglePlanet[i] !== pkey) {
          angles[i] = slotAngle(slot.planet, i);
          anglePlanet[i] = pkey;
        }
        var disc = document.createElement('div');
        disc.className = 'disc' + (selected && selected.seed === slot.planet.seed && selected.generation === slot.planet.generation ? ' sel' : '');
        disc.setAttribute('data-ring', String(i));
        disc.setAttribute('data-seed', String(slot.planet.seed));
        disc.setAttribute('data-gen', String(slot.planet.generation));
        // No name label on the orrery itself (Devon, Nov 11 — they
        // made it messy). Names live in the detail sheet and the
        // Index tiles.
        var d0 = discDetailNow();
        disc.innerHTML = '<div class="pp-grid" style="--pp-fs:' + cellFont(d0.cellW, d0.cellH) + 'px;--pp-ch:' + d0.cellH + 'px"></div>';
        worldEl.appendChild(disc);
        discs.push({ el: disc, planet: slot.planet, ring: i });
      } else {
        // The planet left this ring — drop its angle so it stops
        // blocking that part of the circle for the next planet.
        delete angles[i]; delete anglePlanet[i];
        // No "+" circle on empty rings (Devon, Nov 11 — messy). The
        // ring itself is the click target: a transparent hit area over
        // the ring ellipse, with a faint gold outline on hover only.
        var hit = document.createElement('div');
        hit.className = 'ringHit';
        hit.setAttribute('data-ring', String(i));
        hit.title = 'Place a planet on Ring ' + (i + 1);
        hit.style.left = (CX - R) + 'px';
        hit.style.top = (CY - R) + 'px';
        hit.style.width = (2 * R) + 'px';
        hit.style.height = (2 * R) + 'px';
        hit.style.transform = 'scaleY(' + TILT + ')';
        hit.style.zIndex = String(20 - i);
        worldEl.appendChild(hit);
      }
    }
    layoutPlanets();
    renderDiscs();
  }

  // Re-render just the star's art (the orrery itself only rebuilds on
  // state changes). Called on the tick so the sun stays alive — at a
  // resolution matching its current on-screen size (P.sunDetail), so
  // it is never a pixel blob at any zoom.
  function renderStar() {
    if (!starGridEl) return;
    var sd = P.sunDetail(zoom);
    starGridEl.style.setProperty('--pp-fs', cellFont(sd.cellW, sd.cellH) + 'px');
    starGridEl.style.setProperty('--pp-ch', sd.cellH + 'px');
    starGridEl.innerHTML = starHtml(sec, sd.cols, sd.rows, sd.cellW, sd.cellH);
  }

  function layoutPlanets() {
    for (var k = 0; k < discs.length; k++) {
      var d = discs[k];
      var pos = planetPos({ index: d.ring }, angles[d.ring]);
      d.el.style.left = pos.x + 'px';
      d.el.style.top = pos.y + 'px';
      // All discs share one z-index above the rings and the star.
      // There is no depth sorting anymore: the geometry keeps discs
      // clear of each other and of the star, so draw order is not
      // doing separation work. (Devon, Nov 11.)
      d.el.style.zIndex = '100';
    }
  }

  function renderDiscs() {
    // Continuous zoom detail (Devon, Nov 12 — F5 feedback): the disc
    // re-renders at a grid resolution computed from its current
    // on-screen size divided by a fixed cell size — glyph size never
    // changes, only the character count does (more detail in, cozier
    // out). The disc is counter-scaled (see --inv-zoom), so the
    // glyphs are rasterized at their final size. The disc zoom itself
    // (stage scale + ring fit) is computed at the CURRENT grid size,
    // so the whole ring system still fits.
    // Small discs again (Devon, Nov 11 — the bigger ones made the
    // orrery crowded and messy). 23x16 at 5.2px cells at fit zoom
    // (round 2 — was 46x24 at 2.6px): the detail goes into the sun
    // instead, and the detail panel still shows the full large render.
    // Stage-driven scale + full rings (Devon, Nov 12): the planet
    // grows with its stage, and the disc zoom shrinks just enough
    // that the whole ring system fits — no clipped rings in the
    // orrery. No per-planet starfield here either (the panel stays
    // plain black).
    var detail = discDetailNow();
    discCols = detail.cols; discRows = detail.rows; discZoomSeen = zoom;
    for (var k = 0; k < discs.length; k++) {
      var d = discs[k];
      var gridEl = d.el.querySelector('.pp-grid');
      if (gridEl) {
        var discZoom = Math.min(P.stageScale(d.planet.stageIdx),
          P.ringFitZoom(d.planet.planet, d.planet.stageIdx, detail.cols, detail.rows));
        // The zoomed-in disc (Devon, Nov 12 — round 2, generalized
        // round 3, blended round 4): the full-grid disc keeps the
        // planet small even at 3x — stage 0's body is 18% of the
        // grid, ~66px in a 359px box. A disc at high zoom renders
        // CROPPED to the planet + its whole ring system and 1.4x
        // bigger than its world footprint, so the zoomed planet fills
        // the view with readable glyphs instead of sitting small in
        // a big empty box — the same full planet the detail sheet
        // shows. Round 2 this was selected-disc-only; round 3 it
        // applied to ANY disc at 2x+, because a wheel-zoomed disc had
        // the same half-detail gap vs its sheet. Round 4: the 2x
        // switch itself was a cliff (43 -> 288 chars, +40% width in
        // one step), so the crop now blends in over z=2..4 via
        // P.discBlend — at blend 0 the output is exactly the cozy
        // render, at blend 1 exactly the old cropped render, and
        // neither the size nor the character count jumps in between.
        // A selected disc jumps straight to blend 1 (its sheet is
        // open). Same cost as the cozy path: both render the full
        // grid once per disc per tick; the crop skips the downsample
        // instead of adding work.
        var isSel = zoomed && selected && selected.seed === d.planet.seed && selected.generation === d.planet.generation;
        var zcrop = P.sidebarCrop(d.planet.planet, d.planet.stageIdx, 10, 2.5);
        var bl = P.discBlend(zoom, zcrop, detail, isSel);
        var full = P.render(d.planet.planet, d.planet.stageIdx, 10, sec, discZoom, undefined, 0.5, true);
        var cropped = P.cropGrid(full, bl.box);
        var grid = (bl.outCols < bl.box.cols || bl.outRows < bl.box.rows)
          ? P.downsampleGrid(cropped, bl.outCols, bl.outRows) : cropped;
        gridEl.style.setProperty('--pp-fs', cellFont(bl.cellW, bl.cellH) + 'px');
        gridEl.style.setProperty('--pp-ch', bl.cellH.toFixed(2) + 'px');
        gridEl.innerHTML = P.gridToHtml(grid, bl.cellW, bl.cellH);
      }
    }
  }

  // The disc's detail follows the camera zoom directly (continuous,
  // not stepped): the on-screen size is the world size times the
  // zoom, so the resolution is discDetail(zoom). refreshDiscDetail
  // re-renders only when the computed grid size actually changed by
  // >= 1 cell — the tick re-renders the discs every 450ms anyway, so
  // this is just the prompt path after a zoom gesture.
  var discCols = 0, discRows = 0, discZoomSeen = 0;
  function discDetailNow() {
    return P.discDetail(zoom);
  }
  function refreshDiscDetail() {
    var d = discDetailNow();
    // Round 4: the blended disc changes with zoom even when the cozy
    // grid size doesn't (the blend itself moves), so a zoom change
    // alone must re-render — otherwise the disc would lag a small
    // scroll until the 450ms tick caught up. Round 18: not while a
    // pointer is pressed — same click-killer as the tick (a re-render
    // mid-press means Chrome never generates the click). The disc art
    // just lags the zoom by one frame until the press ends.
    if ((d.cols !== discCols || d.rows !== discRows || zoom !== discZoomSeen) && !pressingNow()) renderDiscs();
  }

  // --- detail sheet + zoom-to-planet -----------------------------------------
  // Click a planet and the camera zooms into it — the details show
  // beside the zoomed planet, not in a modal over the system (Devon,
  // Nov 12 — the old panel covered the orrery). X / Esc zooms back
  // out to the view you had. In Index mode there is no camera to
  // move, so the sheet just appears.
  function openDetail(planet) {
    selected = { seed: planet.seed, generation: planet.generation };
    detailJournalAll = false; // a new planet starts at latest-3
    detailOpen = true;
    renderDetail();
    renderOrrerySel();
    if (mode === 'orrery') zoomToPlanet(planet);
  }
  function closeDetail() {
    if (zoomed) unzoom();
    selected = null;
    detailJournalAll = false;
    detailOpen = false;
    detailEl.hidden = true;
    renderOrrerySel();
  }
  function zoomToPlanet(planet) {
    var disc = null;
    for (var k = 0; k < discs.length; k++) {
      if (discs[k].planet.seed === planet.seed && discs[k].planet.generation === planet.generation) { disc = discs[k]; break; }
    }
    if (!disc) return; // not on a ring (shouldn't happen in orrery mode)
    if (!zoomed) prevView = { zoom: zoom, panX: panX, panY: panY };
    var pos = planetPos({ index: disc.ring }, angles[disc.ring]);
    var ow = orreryEl.clientWidth, oh = orreryEl.clientHeight;
    // Round 3 (Devon, Nov 12): land near full detail — the detail
    // sheet shows the full 136-col planet, but the disc capped at 3x
    // only reached 69 cols, so the zoomed planet looked half as
    // detailed as its own sheet. fitZoom x 5 (capped at 6x) lands at
    // ~136 cols, and the 6x cap lets the wheel reach it too.
    var zoomT = Math.min(6, Math.max(1.6, fitZoom * 5));
    // Land the planet left of centre (the sheet takes the right side).
    var tx = ow * 0.34, ty = oh * 0.5;
    var panTX = tx - ow / 2 - (pos.x - CX) * zoomT;
    var panTY = ty - oh / 2 - (pos.y - CY) * zoomT;
    zoom = zoomT; panX = panTX; panY = panTY;
    worldEl.style.transition = 'transform 450ms cubic-bezier(.22,.61,.36,1)';
    applyTransform();
    scheduleZoomRefresh();
    setTimeout(function () { worldEl.style.transition = ''; }, 500);
    zoomed = true;
  }
  function unzoom() {
    if (!zoomed) return;
    zoomed = false;
    if (prevView) {
      zoom = prevView.zoom; panX = prevView.panX; panY = prevView.panY;
      prevView = null;
    } else {
      fitView();
      return;
    }
    worldEl.style.transition = 'transform 450ms cubic-bezier(.22,.61,.36,1)';
    applyTransform();
    scheduleZoomRefresh();
    setTimeout(function () { worldEl.style.transition = ''; }, 500);
  }
  function renderOrrerySel() {
    var ds = worldEl.querySelectorAll('.disc');
    for (var i = 0; i < ds.length; i++) {
      var on = selected && ds[i].getAttribute('data-seed') === String(selected.seed)
        && ds[i].getAttribute('data-gen') === String(selected.generation);
      ds[i].classList.toggle('sel', !!on);
    }
  }
  function renderDetail() {
    if (!selected) { closeDetail(); return; }
    var planet = findPlanet(selected.seed, selected.generation);
    if (!planet) { closeDetail(); return; }
    detailEl.hidden = false;
    var ring = slotOf(planet.seed, planet.generation);
    var emptyRing = firstEmptyRing();
    // The art is filled by fillDetailArt() below (cropped render,
    // cells sized to the sheet) — the grid element starts empty.
    // Round 17 (fix C) — detail sheet cleanup (Devon, Nov 15): name +
    // inline chips, one meta line, name-only mutation chips, a
    // 3-number vitals row, the earnings breakdown as a gold-bordered
    // block, latest 3 journal entries. No Gen label anywhere in this
    // sheet (Devon, Nov 15 — display-only; the generation counter
    // itself is untouched).
    var inSystem = planet.kind === 'current' || ring >= 0;
    // Header chips: stage + one per completed set. The set's flavor
    // sentence is dropped — the set is visible from the mutation
    // chips below it.
    var chips = '<span class="chip">' + esc(planet.stageName) + '</span>';
    (planet.sets || []).forEach(function (s) {
      chips += '<span class="chip">✦ ' + esc(s.name) + '</span>';
    });
    // Mutation chips: name only — the flavor moves to the title
    // tooltip. (esc() skips quotes, so the tooltip quotes are
    // escaped here.)
    var mutChips = '';
    (planet.mutations || []).forEach(function (id) {
      var def = P.mutationDef(id);
      mutChips += '<span class="mutchip"' + (def && def.desc ? ' title="' + esc(def.desc).replace(/"/g, '&quot;') + '"' : '') + '>✦ ' + esc(def ? def.name : id) + '</span>';
    });
    // Round 11 — the Discovery Journal: the planet's own history.
    // Latest 3 entries, newest first; "Show all N" expands in place.
    // Events show their title (✦ Meteor Impact); everything else is
    // one line of story.
    var journalHtml = '';
    var journal = planet.journal || [];
    if (journal.length > 0) {
      var shown = detailJournalAll ? journal.slice().reverse() : journal.slice(-3).reverse();
      journalHtml = '<h3>Latest</h3><div class="journal">';
      for (var ji = 0; ji < shown.length; ji++) {
        var je = shown[ji];
        var d = je.t ? new Date(je.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
        journalHtml += '<div class="jentry"><span class="jdate">' + esc(d) + '</span> '
          + (je.kind === 'event' && je.title ? '<span class="jtitle">✦ ' + esc(je.title) + '</span> — ' : '')
          + esc(je.text) + '</div>';
      }
      journalHtml += '</div>';
      if (journal.length > 3) {
        journalHtml += '<button class="showall" data-action="showJournal">' + (detailJournalAll ? 'Show less' : 'Show all ' + journal.length + ' entries') + ' &rsaquo;</button>';
      }
    }
    // Round 15 revision (Devon, Nov 14 — the separate Stardust tab
    // is gone): the full earnings breakdown lives HERE, as a
    // gold-bordered block under the vitals — one line per factor that
    // applies (stage base, mutations, journal events, family combos),
    // straight from earnBreakdown in petLogic.js. The lines multiply
    // to the total, exact to 3 decimals. A plain planet shows just
    // its stage base; nothing shows an empty line.
    var earnBlock = '';
    var bd = planet.earnBreakdown;
    if (bd && bd.lines && bd.lines.length > 0) {
      earnBlock = '<div class="earnblock">';
      for (var ei = 0; ei < bd.lines.length; ei++) {
        earnBlock += '<div class="ebline"><span>' + esc(bd.lines[ei].label) + '</span><span class="ebval">' + esc(bd.lines[ei].value) + '</span></div>';
      }
      earnBlock += '</div>';
    }
    // Vitals math (display only): Civilization is 2200 XP — mirrors
    // Logic.CONFIG.PRESTIGE_MIN_CHARS / XP_THRESHOLDS[6]; the next
    // stage's XP mirrors XP_THRESHOLDS. The webview has no Logic
    // handle, so the ladder is repeated here for the subline only —
    // earn math never uses it.
    var CIV_XP = 2200;
    var XP_NEXT = [100, 300, 600, 1000, 1500, 2200];
    var maxed = planet.stageIdx >= 6;
    var stageSub = maxed ? 'MAX · ' + planet.chars.toLocaleString() + ' XP'
      : 'NEXT · ' + (XP_NEXT[planet.stageIdx] || 0).toLocaleString() + ' XP';
    if (planet.kind === 'current') stageSub += ' · Growing now';
    // Benched fix (round 17): a benched planet must never read as
    // earning — the amber line below wins, and the Earns subline
    // says "Benched", never "in your system".
    var benchedHtml = inSystem ? '' : '<p class="benched">Benched — place it in the system to earn.</p>';
    // Prestige shows ONLY when actionable: this planet reached
    // Civilization and hasn't been a parent, AND another
    // Civilization planet exists to pair with. Otherwise nothing.
    var prestigeLine = '';
    if ((planet.chars || 0) >= CIV_XP && !planet.usedAsParent && state && state.index) {
      for (var pi = 0; pi < state.index.length; pi++) {
        var op = state.index[pi];
        if ((op.seed !== planet.seed || op.generation !== planet.generation)
          && (op.chars || 0) >= CIV_XP && !op.usedAsParent) {
          prestigeLine = '<p class="prestigeline">Ready to prestige — pair with another Civilization planet</p>';
          break;
        }
      }
    }
    var html = '<button id="detailClose" class="ghost" data-action="close" title="Close">&times;</button>'
      + '<h2>' + esc(planet.name) + '</h2>'
      + '<div class="chips">' + chips + '</div>'
      + '<p class="sub">' + esc(planet.terrainLabel || 'Protoplanet') + ' &middot; Seed ' + planet.seed + '</p>'
      + '<div id="detailArt" class="pp-frame" data-cw="4" data-ch="7.2" data-atmo="' + planet.planet.atmosphere + '"><div class="pp-stars"></div><div class="pp-planet"><div class="pp-grid"></div></div></div>'
      + (mutChips ? '<div class="mutchips">' + mutChips + '</div>' : '')
      + '<div class="vitals">'
      + '<div class="vital"><div class="vlabel">Earns</div><div class="vnum gold">' + planet.earnRateText + ' ✦/char</div><div class="vsub">' + (inSystem ? 'in your system' : 'Benched') + '</div></div>'
      + '<div class="vital"><div class="vlabel">Stage</div><div class="vnum">' + esc(planet.stageName) + '</div><div class="vsub">' + stageSub + '</div></div>'
      + '<div class="vital"><div class="vlabel">Grown</div><div class="vnum">' + planet.chars.toLocaleString() + '</div><div class="vsub">characters</div></div>'
      + '</div>'
      + earnBlock
      + benchedHtml
      + prestigeLine
      + journalHtml
      + '<div class="actions">';
    // Grow this planet again (round 7 — Devon): an archived planet
    // in the Index can become the living one — typing grows it
    // again, and the planet that was growing is kept in the
    // collection. The living planet gets no button.
    if (planet.kind !== 'current') {
      html += '<button class="primary" data-action="makeCurrent">Grow this planet</button>';
    }
    if (ring >= 0) {
      html += '<button data-action="remove" data-ring="' + ring + '">Remove from system</button>'
        + '<button class="ghost" data-action="replace" data-ring="' + ring + '">Replace&hellip;</button>';
    } else if (emptyRing >= 0) {
      html += '<button data-action="place" data-ring="' + emptyRing + '">Place in system (Ring ' + (emptyRing + 1) + ')</button>';
    } else {
      html += '<button disabled>No empty rings</button>';
    }
    if (planet.kind !== 'current') {
      // Round 11 — salvaging an archived planet destroys it for
      // minerals, and it is also how a full archive frees a slot.
      html += '<button class="ghost" data-action="salvage">Salvage this planet</button>';
    }
    html += '</div>';
    if (ring < 0 && emptyRing < 0 && state.nextAt !== null) {
      html += '<p class="note">No empty rings — grow ' + state.toNext + ' more planet' + (state.toNext === 1 ? '' : 's') + ' to unlock Ring ' + (state.totalSlots + 1) + '.</p>';
    }
    // The "Removing never deletes it" note is dropped from this
    // sheet (round 17) — and there is no Remove confirm dialog to
    // move it to (remove is immediate), so it is gone, not moved.
    detailEl.innerHTML = html;
    fillDetailArt();
  }

  // Detail art (Devon, Nov 12 — round 2): the sheet used to show the
  // whole 136x76 render at 2.35px cells — a 59px stage-0 body of
  // unreadable glyphs next to the zoomed planet. Now it uses the same
  // crop approach as the sidebar and the Index tiles: the full render
  // cropped to the planet's extent (sidebarCrop), cells sized to the
  // sheet's width, so the planet fills the sheet with readable
  // characters. The render zoom is 1.0 (not 1.2) so the body matches
  // the crop geometry exactly — nothing clips at the crop edge. The
  // starfield layer's cell size follows the planet grid's (data-cw /
  // data-ch), so the stars stay aligned with the art. Called on open
  // and every tick while the sheet is open.
  function fillDetailArt() {
    if (!selected) return;
    var planet = findPlanet(selected.seed, selected.generation);
    if (!planet) return;
    var artEl = document.getElementById('detailArt');
    if (!artEl) return;
    var gridEl = artEl.querySelector('.pp-planet .pp-grid');
    if (!gridEl) return;
    var crop = P.sidebarCrop(planet.planet, planet.stageIdx, 10);
    var artW = Math.max(120, artEl.clientWidth - 10);
    var cellW = artW / crop.cols;
    var cellH = cellW * 1.8;
    artEl.setAttribute('data-cw', cellW.toFixed(2));
    artEl.setAttribute('data-ch', cellH.toFixed(2));
    gridEl.style.setProperty('--pp-fs', cellFont(cellW, cellH) + 'px');
    gridEl.style.setProperty('--pp-ch', cellH.toFixed(2) + 'px');
    gridEl.innerHTML = P.gridToHtml(
      P.cropGrid(P.render(planet.planet, planet.stageIdx, 10, sec, 1.0, undefined, 0.5, true), crop), cellW, cellH);
    fillStars(artEl, sec);
  }

  // --- index -------------------------------------------------------------------
  // The collection as its own full-screen mode (Devon, Nov 12 — the old
  // Archive sat below the orrery in the same scroll, which is what
  // squeezed both). Big tiles, 2–3 per row, the planet's ASCII art as
  // the tile, name + one datum, 1px hairline gaps, no card chrome.
  function indexSignature() {
    if (!state) return '';
    var cur = null;
    for (var i = 0; i < state.index.length; i++) {
      if (state.index[i].kind === 'current') cur = state.index[i].seed + ':' + state.index[i].stageIdx;
    }
    return JSON.stringify([
      // A planet's mutations change without its seed:generation
      // changing (round 10: a mineral apply adds one in place) — the
      // signature must include them, or the Index won't re-render
      // after an apply.
      state.index.map(function (p) { return p.seed + ':' + p.generation + ':' + (p.mutations || []).join(','); }),
      state.slots.map(function (s) { return s.planet ? s.planet.seed + ':' + s.planet.generation : ''; }),
      cur,
      state.mutationIndex ? state.mutationIndex.foundCount : 0,
      // Round 19: the Mutations tab lists the mineral inventory now —
      // spending or buying a mineral must re-render it. Stardust is
      // deliberately NOT here: it changes on every keystroke and would
      // rebuild the orrery discs with it.
      state.minerals ? state.minerals.groups.map(function (g) { return g.kind + ':' + (g.mutation || '') + 'x' + g.count; }).join(',') : '',
    ]);
  }
  var mutFilter = ''; // '' = all, 'mutated' = mutated only, else a mutation id
  // The filter's mutation options come from the engine's own list —
  // the panel never hardcodes the 13 ids.
  (function () {
    var sel = document.getElementById('mutFilter');
    P.CONFIG.MUTATIONS.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    });
  })();
  function filteredIndex() {
    var q = searchText.trim().toLowerCase();
    var list = state.index.filter(function (p) {
      if (q) {
        var hay = (p.name + ' ' + p.terrainLabel + ' ' + p.seed + ' ' + (p.mutationLabel || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (mutFilter === 'mutated') return (p.mutations || []).length > 0;
      if (mutFilter) return (p.mutations || []).includes(mutFilter);
      return true;
    });
    list.sort(function (a, b) {
      if (sortMode === 'newest') return (b.archivedAt || Infinity) - (a.archivedAt || Infinity);
      if (sortMode === 'oldest') return (a.archivedAt || 0) - (b.archivedAt || 0);
      if (sortMode === 'most') return b.chars - a.chars;
      if (sortMode === 'mutated') return (b.mutations || []).length - (a.mutations || []).length || b.chars - a.chars;
      // Round 17 (fix M) — Highest earners: Stardust per character,
      // highest first, from the same earnRate the tiles and detail
      // sheet display (petLogic earnRate — never a separate copy of
      // the math). Applied at render time from the current rates on
      // every state push, so a stage-up, a new mutation, a journal
      // event or a placement change re-sorts the Index live.
      if (sortMode === 'earners') return (b.earnRate || 0) - (a.earnRate || 0) || b.chars - a.chars;
      if (sortMode === 'name') return a.name.localeCompare(b.name);
      if (sortMode === 'terrain') return (a.terrainLabel + a.name).localeCompare(b.terrainLabel + b.name);
      return 0;
    });
    return list;
  }
  // The tile art width: when the Index is visible, measure a tile;
  // when hidden (state arrived while the orrery shows), estimate from
  // the panel width and the grid's minmax(340px, 1fr) columns.
  function tileArtWidth() {
    var art = tilesEl.querySelector('.tile .art');
    if (art && art.clientWidth > 0) return art.clientWidth;
    var w = window.innerWidth - 56; // #index padding 28px each side
    var cols = Math.max(1, Math.floor(w / 340));
    return Math.max(200, w / cols - 28); // tile padding 14px each side
  }
  // Round 11 — the Index tile's one-line journal: the latest entry.
  // An event shows its title; anything else shows its text, cut
  // short so the tile stays a tile.
  function journalLine(journal) {
    if (!journal || journal.length === 0) return '';
    var last = journal[journal.length - 1];
    var text = (last.kind === 'event' && last.title) ? '✦ ' + last.title : last.text;
    return text.length > 64 ? text.slice(0, 63) + '…' : text;
  }
  function renderIndex() {
    if (!state) return;
    var list = filteredIndex();
    if (pickerRing !== null) list = list.filter(function (p) { return slotOf(p.seed, p.generation) < 0; });
    document.getElementById('indexCount').textContent =
      state.totalPlanets + ' planet' + (state.totalPlanets === 1 ? '' : 's') + ' — ' + state.ringsUsed + ' on rings'
      + ' · Archive ' + (state.archiveCount || 0) + '/' + (state.archiveLimit || 200)
      + ' · ✦' + (state.systemEarnRateText || '0') + '/char';
    if (list.length === 0) {
      tilesEl.innerHTML = '<div class="empty">' + (state.totalPlanets === 0
        ? 'No planets yet — type to grow your first one, and it will show up here when you start a new planet.'
        : (pickerRing !== null ? 'Every planet is already in your system.' : 'Nothing matches that search.')) + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var inSys = slotOf(p.seed, p.generation) >= 0;
      var mutCount = (p.mutations || []).length;
      var jline = journalLine(p.journal);
      html += '<div class="tile' + (inSys ? ' inSystem' : '') + (pickerRing !== null ? ' picking' : '') + (mutCount > 0 ? ' mutated' : '') + '"'
        + ' data-seed="' + p.seed + '" data-gen="' + p.generation + '">'
        + (mutCount > 0 ? '<div class="corner">✦' + (mutCount > 1 ? '×' + mutCount : '') + '</div>' : '')
        + '<div class="art"><div class="pp-grid"></div></div>'
        + '<div class="tname">' + esc(p.name) + '</div>'
        + '<div class="tmeta">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName) + ' &middot; ' + p.chars + ' chars &middot; ✦' + p.earnRateText + '/char</div>'
        + (jline ? '<div class="jline">' + esc(jline) + '</div>' : '')
        + (inSys ? '<span class="badge sys">In system</span>' : '')
        + (p.kind === 'current' ? '<span class="badge cur">Growing now</span>' : '')
        // Round 17 (fix C) — mutation pills (Devon, Nov 15): one
        // violet pill per mutation, name only — no "MUTATION" word.
        // The color (not the text) is what marks a mutation at a
        // glance; the status pills (In system / Growing now) stay
        // gold. Reverses the Nov 11 call that kept the full
        // "MUTATION · Glitch" label on the tile.
        + (p.mutations || []).map(function (id) {
          var def = P.mutationDef(id);
          return '<span class="badge mut">' + esc(def ? def.name : id) + '</span>';
        }).join('')
        + '</div>';
    }
    tilesEl.innerHTML = html;
    fillTileArt(list);
  }
  // Tile art (Devon, Nov 12 — round 2): the tiles used to show a
  // 68x38 cozy downsample at 4.4px cells — a 55px stage-0 body, dark
  // and blobby, because the downsample averages the bright core with
  // the dim smoke into a smudge, and the dark-space backgrounds in
  // gridToHtml painted literal color blocks. Now the tiles use the
  // same approach as the sidebar (full render, cropped to the
  // planet's extent with sidebarCrop, cells sized to the tile's art
  // width) — so the tile looks like a bigger sidebar, like Devon
  // asked. Stage-driven scale stays: the render zoom is still
  // stageScale, so a newborn reads smaller than a mature planet
  // inside its tile — but both are ~2x bigger and brighter than
  // before, with real characters instead of averaged blocks.
  // Round 17 (fix C) — tighter crop margin 1.15 (was the 1.7
  // default): the disc fills the tile instead of sitting small in
  // a wide field. Same fix as the open "Index shattered-burst
  // planet unreadable" call (stage 0 was the worst: disc ~42% of
  // tile width).
  function fillTileArt(list) {
    var artW = tileArtWidth();
    var arts = tilesEl.querySelectorAll('.tile .art');
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var artEl = arts[i];
      if (!artEl) continue;
      var gridEl = artEl.querySelector('.pp-grid');
      if (!gridEl) continue;
      var crop = P.sidebarCrop(p.planet, p.stageIdx, 10, 1.15);
      var cellW = artW / crop.cols;
      var cellH = cellW * 1.8;
      gridEl.style.setProperty('--pp-fs', cellFont(cellW, cellH) + 'px');
      gridEl.style.setProperty('--pp-ch', cellH.toFixed(2) + 'px');
      gridEl.innerHTML = P.gridToHtml(
        P.cropGrid(P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), undefined, 0.5, true), crop), cellW, cellH);
    }
  }

  // --- mutations tab (round 19) -------------------------------------------
  // The tab is a Fusion hub + mineral inventory + Sets now (Devon, Nov 15):
  // the bingo card is gone — a mutation lives on many planets, so listing
  // carriers read like it can only be on one. No Gen lines anywhere.
  function renderMutations() {
    if (!state || !state.mutationIndex) return;
    var mi = state.mutationIndex;
    document.getElementById('mutCount').textContent =
      mi.foundCount + ' / ' + mi.total + ' mutations found — ' + (mi.anyOddsText || ('each ' + mi.oddsText + ' when a planet is born'));
    // 1. Fusion hub — the two parent slots, the rules, the cost, and
    // the button. The button stays primary in both states (the fusion
    // panel itself is where parents are picked); the state line names
    // the blocker when fewer than 2 parents are ready.
    var hubHtml = '';
    var f = state.fusion;
    if (f) {
      var nextName = null;
      for (var n = 0; n < f.slots.length; n++) {
        if (f.slots[n] && !f.slots[n].ready) { nextName = f.slots[n].planet.name; break; }
      }
      var slotsHtml = '';
      for (var i = 0; i < 2; i++) {
        var s = f.slots[i];
        if (!s) {
          slotsHtml += '<div class="fusionSlot empty"><div class="fslotBody"><div class="fslotName">No planet yet</div>'
            + '<div class="fslotMeta">Grow a planet to fuse.</div></div></div>';
          continue;
        }
        var p = s.planet;
        var setNames = (p.sets || []).map(function (x) { return x.name; }).join(' · ');
        var meta = esc(p.stageName) + ' · ' + p.mutations.length + ' mutation' + (p.mutations.length === 1 ? '' : 's')
          + (setNames ? ' · ' + esc(setNames) : '');
        slotsHtml += '<div class="fusionSlot"><div class="fslotArt"><div class="pp-grid"></div></div>'
          + '<div class="fslotBody"><div class="fslotName">' + esc(p.name) + '</div>'
          + '<div class="fslotMeta">' + meta + '</div>'
          + (s.ready
            ? '<div class="fslotReady">✓ Ready to fuse</div>'
            : '<div class="fslotProg"><div class="fslotBar"><div style="width:' + Math.round(100 * s.chars / f.minChars) + '%"></div></div>'
            + '<div class="fslotProgText">' + s.chars.toLocaleString() + ' / ' + f.minChars.toLocaleString() + ' chars — ' + s.toCiv.toLocaleString() + ' to Civilization</div></div>')
          + '</div></div>';
      }
      var stateLine = f.readyCount >= 2
        ? '2 of 2 parents ready'
        : (f.readyCount + ' of 2 parents ready' + (nextName ? ' — grow ' + nextName + ' to Civilization to fuse.' : '.'));
      hubHtml = '<div class="fusionHub"><div class="fhubTitle">✦ Fusion</div>'
        + '<div class="fhubRules">Fuse two Civilization planets into a child. The child inherits each parent\u2019s mutations — <b>50% from one parent, 75% if both carry it</b>. Parents stay in your collection — each pair fuses once.</div>'
        + '<div class="fusionSlots">' + slotsHtml + '</div>'
        + '<div class="fhubFoot"><button class="primary" id="openFusionBtn">Open fusion</button>'
        + '<span class="fhubCost">Costs <b>1 Birth mineral</b> — you have <b>' + f.birthCount + '</b></span>'
        + '<span class="fhubState">' + esc(stateLine) + '</span></div></div>';
    }
    document.getElementById('fusionHub').innerHTML = hubHtml;
    var openBtn = document.getElementById('openFusionBtn');
    if (openBtn) openBtn.addEventListener('click', function () { vscodeApi.postMessage({ type: 'openPrestige' }); });
    fillFusionArt();
    // 2. Your minerals — the inventory, grouped exactly the way
    // mineralInventory() groups it: Mutation minerals first
    // (alphabetical), then Birth. Apply runs the existing apply flow
    // pre-filled with that mineral; Birth can never apply.
    var minHtml = '';
    var inv = state.minerals;
    if (inv) {
      minHtml = '<div class="mutSectionHead">Your minerals<span class="mutSectionRight">' + inv.total + ' total · ✦ ' + Math.floor(inv.stardust || 0).toLocaleString() + ' Stardust</span></div>';
      if (inv.groups.length === 0) {
        minHtml += '<div class="mutEmpty">No minerals yet — salvage a planet to get one, or buy one in the Protoplanet shop.</div>';
      } else {
        for (var k = 0; k < inv.groups.length; k++) {
          var g = inv.groups[k];
          minHtml += '<div class="minRow"><div class="minBody">'
            + '<div class="minName">' + esc(g.label) + '</div>'
            + (g.desc ? '<div class="minDesc">' + esc(g.desc) + '</div>' : '')
            + '<div class="minApply">' + esc(g.applyText) + '</div></div>'
            + '<div class="minCount"><span class="x">×</span>' + g.count.toLocaleString() + '</div>'
            + (g.mutation
              ? '<button class="ghost minApplyBtn" data-mutation="' + esc(g.mutation) + '">Apply ›</button>'
              : '<span class="minTag">BIRTH COST</span>')
            + '</div>';
        }
        minHtml += '<div class="minFooter">Buy more in the shop — Birth ' + inv.shopPrices.birth.toLocaleString() + ' ✦ · Random Mutation ' + inv.shopPrices.random.toLocaleString() + ' ✦ · Family Mutation ' + inv.shopPrices.family.toLocaleString() + ' ✦</div>';
      }
    }
    document.getElementById('mutMinerals').innerHTML = minHtml;
    var applyBtns = document.querySelectorAll('#mutMinerals .minApplyBtn');
    for (var b = 0; b < applyBtns.length; b++) {
      applyBtns[b].addEventListener('click', function (e) {
        vscodeApi.postMessage({ type: 'applyMineral', mutation: e.currentTarget.getAttribute('data-mutation') });
      });
    }
    // 3. Sets — kept, with progress dots and the carrier of the first
    // found mutation when incomplete. (The "Sets" header lives in the
    // static HTML above #mutSets, not in the flex row — a header div
    // inside the flex container lays out as a flex item.)
    var setsHtml = '';
    for (var j = 0; j < mi.sets.length; j++) {
      var st = mi.sets[j];
      var found = st.required.filter(function (r) { return r.found; });
      var dots = st.required.map(function (r) { return r.found ? '●' : '○'; }).join(' ');
      var line;
      if (st.holder) {
        line = 'Held by ' + st.holder + ' — ' + st.required.length + ' / ' + st.required.length;
      } else if (found.length > 0) {
        var first = found[0];
        line = found.length + ' / ' + st.required.length + ' — ' + first.name + ' on ' + (first.carrier || 'a planet') + ', ' + (st.required.length - found.length) + ' more to earn';
      } else {
        line = '0 / ' + st.required.length + ' — earn ' + st.required.map(function (r) { return r.name; }).join(' + ') + ' on one planet';
      }
      setsHtml += '<div class="setCard' + (st.holder ? ' earned' : '') + '">'
        + '<div class="sname">✦ ' + esc(st.name) + '</div>'
        + '<div class="sreq">' + st.required.map(function (r) { return esc(r.name); }).join(' + ') + ' on one planet</div>'
        + '<div class="sdots">' + dots + '</div>'
        + '<div class="sholder">' + esc(line) + '</div></div>';
    }
    document.getElementById('mutSets').innerHTML = setsHtml;
  }

  // Static planet art for the fusion slots — same render path as the
  // Index tiles (sidebarCrop + gridToHtml), one still frame per slot.
  function fillFusionArt() {
    if (!state || !state.fusion) return;
    var arts = document.querySelectorAll('#fusionHub .fusionSlot .fslotArt .pp-grid');
    for (var i = 0; i < arts.length; i++) {
      var s = state.fusion.slots[i];
      if (!s || !s.planet) continue;
      var gridEl = arts[i];
      var artEl = gridEl.parentElement;
      var artW = Math.max(80, artEl.clientWidth || 120);
      var crop = P.sidebarCrop(s.planet.planet, s.planet.stageIdx, 10, 1.15);
      var cellW = artW / crop.cols;
      var cellH = cellW * 1.8;
      gridEl.style.setProperty('--pp-fs', cellFont(cellW, cellH) + 'px');
      gridEl.style.setProperty('--pp-ch', cellH.toFixed(2) + 'px');
      gridEl.innerHTML = P.gridToHtml(
        P.cropGrid(P.render(s.planet.planet, s.planet.stageIdx, 10, 5, P.stageScale(s.planet.stageIdx), undefined, 0.5, true), crop), cellW, cellH);
    }
  }

  // --- picker mode (choosing a planet for a ring) ---------------------------
  // Picking happens in the Index: the banner says which ring you are
  // filling, and tapping a tile places it. Cancel takes you back to
  // the orrery.
  function startPicker(ring) {
    pickerRing = ring;
    bannerEl.hidden = false;
    bannerEl.innerHTML = '<span>Choose a planet for <b>Ring ' + (ring + 1) + '</b> — tap a tile in the Index to place it.</span>'
      + '<button id="pickerCancel" class="ghost">Cancel</button>';
    document.getElementById('pickerCancel').addEventListener('click', cancelPicker);
    renderIndex();
    setMode('index');
  }
  function cancelPicker() {
    pickerRing = null;
    bannerEl.hidden = true;
    renderIndex();
    setMode('orrery');
  }

  // --- rank line -------------------------------------------------------------
  // One slim line (Devon, Nov 12 — the old one packed rank, finished
  // planets, rings used and the next unlock into one sentence). The
  // finished count lives in the Index count line; the lock labels on
  // the orrery already say how many more planets the next ring needs.
  function updateRankLine() {
    if (!state) return;
    var line = 'Rank ' + state.rank + ' &middot; ' + state.ringsUsed + '/' + state.totalSlots + ' rings';
    if (state.nextAt !== null) line += ' &middot; ' + state.toNext + ' to next ring';
    else line += ' &middot; max rings';
    document.getElementById('rankLine').innerHTML = line;
  }

  // Round 14 — the Stardust balance chip, top-right. Called on every
  // state push (same place as updateRankLine), so the number ticks up
  // live as Stardust is earned per character.
  function updateStardustChip() {
    if (!state) return;
    var el = document.getElementById('stardustBal');
    if (el) el.textContent = Math.floor(state.stardust || 0).toLocaleString();
    // Round 19 — the system's per-character total rides in the chip
    // next to the balance, dimmed so the balance stays the hero.
    var rateEl = document.getElementById('stardustRate');
    if (rateEl) rateEl.textContent = '· +' + (state.systemEarnRateText || '0') + '/char';
  }

  // --- pan / zoom --------------------------------------------------------------
  // Zoom re-renders ride the animation frame (Devon, Nov 12 —
  // round 2): the old wheel handler re-rendered the discs
  // synchronously on every wheel event, and the sun only on the
  // 300ms tick — so the camera moved instantly while the characters
  // lagged behind it and then popped. Now a zoom change applies the
  // transform immediately and schedules ONE re-render on the next
  // frame, coalescing a whole pinch/wheel burst into a single
  // re-render that lands within ~16ms of the gesture.
  var zoomRaf = null;
  function scheduleZoomRefresh() {
    if (zoomRaf !== null) return;
    zoomRaf = requestAnimationFrame(function () {
      zoomRaf = null;
      renderStar();
      refreshDiscDetail();
    });
  }
  function applyTransform() {
    worldEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    // Counter-scale the sprites (see the .disc / .star CSS): the
    // world scales by zoom, but the planet/sun glyphs must stay at
    // their final on-screen size.
    worldEl.style.setProperty('--inv-zoom', (1 / zoom).toFixed(4));
  }
  function computeFit() {
    fitZoom = Math.min(orreryEl.clientWidth / WORLD_W, orreryEl.clientHeight / WORLD_H) * 0.98;
    if (!isFinite(fitZoom) || fitZoom <= 0) fitZoom = 1;
  }
  function fitView() {
    computeFit();
    zoom = fitZoom;
    panX = 0; panY = 0;
    applyTransform();
    scheduleZoomRefresh();
  }
  // --- shared hit tests (round 17, B) --------------------------------------
  // Hover and click MUST agree: the gold outline is the hit area, so
  // both paths call these functions with the same pointer position
  // instead of trusting whichever element happens to be on top.
  // DISC_PAD_PX: a few px of invisible padding around the disc box,
  // so a click on the 2px outline band — or a near-miss on the
  // highlighted planet — still counts as clicking the planet.
  var DISC_PAD_PX = 4;
  function discAtPoint(clientX, clientY) {
    for (var k = 0; k < discs.length; k++) {
      var r = discs[k].el.getBoundingClientRect();
      if (clientX >= r.left - DISC_PAD_PX && clientX <= r.right + DISC_PAD_PX
        && clientY >= r.top - DISC_PAD_PX && clientY <= r.bottom + DISC_PAD_PX) return discs[k];
    }
    return null;
  }
  // RING_BAND_PX: a ring only counts when the pointer is within this
  // many screen px of its line. The old .ringHit divs were filled
  // ellipses — ~100k px^2 of clickable empty black space each — so
  // any click inside an outer ring opened the picker. The band is
  // measured along the ellipse's major axis; near the top/bottom of
  // the ring (where it runs nearly horizontal) the same band reads
  // as ~4px vertically, which is the right feel for a thin line.
  // Only unlocked EMPTY rings are clickable, and the nearest line
  // wins when bands overlap at low zoom.
  var RING_BAND_PX = 12;
  function ringAtPoint(clientX, clientY) {
    if (!state) return -1;
    var rect = orreryEl.getBoundingClientRect();
    var wx = CX + (clientX - rect.left - rect.width / 2 - panX) / zoom;
    var wy = CY + (clientY - rect.top - rect.height / 2 - panY) / zoom;
    var total = state.slots.length;
    var best = -1, bestD = Infinity;
    for (var i = 0; i < total; i++) {
      var slot = state.slots[i];
      if (!slot.unlocked || slot.planet) continue;
      var R = ringRadius(i, total);
      var dx = (wx - CX) / R, dy = (wy - CY) / (R * TILT);
      var rho = Math.sqrt(dx * dx + dy * dy);
      var d = Math.abs(rho - 1);
      if (d * R * zoom <= RING_BAND_PX && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }
  var panning = null, dragged = false, suppressClick = false, downPos = null;
  // Round 18 — the click-killer (Devon, Nov 15, live F5 + CDP repro):
  // the 150ms tick re-renders every disc grid (innerHTML), which destroys
  // the nodes under the cursor. If that happens between pointerdown and
  // pointerup, Chrome never generates the click event at all — the press
  // silently does nothing. A normal press lasts ~80-150ms, so it straddled
  // the tick most of the time: clicks only worked when the press happened
  // to fall between ticks (the 2nd/7th/19th-try pattern Devon filmed).
  // While ANY pointer is pressed in this panel, the tick skips the
  // node-destroying re-renders (discs, star, detail art). A press lasts
  // ~100ms, so at most one 150ms frame is skipped — invisible. The flag
  // self-heals: a press that never gets its pointerup (released outside
  // the window) stops blocking re-renders after 1s.
  var pressing = false, pressStarted = 0;
  document.addEventListener('pointerdown', function () {
    pressing = true; pressStarted = Date.now();
  });
  // Shared by the tick and the zoom refresh: true while a press is
  // active (and fresh). Both skip node-destroying re-renders then.
  function pressingNow() {
    return pressing && (Date.now() - pressStarted < 1000);
  }
  orreryEl.addEventListener('pointerdown', function (e) {
    panning = { x: e.clientX, y: e.clientY, panX: panX, panY: panY };
    downPos = { x: e.clientX, y: e.clientY };
    dragged = false;
    orreryEl.classList.add('panning');
  });
  // Pan tracking lives on window (not pointer capture on the orrery):
  // capturing the pointer would retarget the click event to the
  // orrery and break planet clicks. Window listeners still see the
  // pointerup even if the drag ends outside the orrery.
  window.addEventListener('pointermove', function (e) {
    if (!panning) return;
    var dx = e.clientX - panning.x, dy = e.clientY - panning.y;
    // Round 17, B: 4px Manhattan was tiny — normal click jitter or
    // trackpad movement exceeded it, so the click was silently
    // swallowed. 8px still catches every real pan (and the click
    // handler below re-checks the end position against downPos).
    if (Math.abs(dx) + Math.abs(dy) > 8) dragged = true;
    if (dragged) {
      panX = panning.panX + dx;
      panY = panning.panY + dy;
      applyTransform();
    }
  });
  window.addEventListener('pointerup', function () {
    pressing = false;
    orreryEl.classList.remove('panning');
    if (panning && dragged) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
    }
    panning = null;
  });
  // A cancelled press (browser takes over, pointer leaves) must also
  // release the flag, or the re-renders stay paused (see pressing).
  window.addEventListener('pointercancel', function () {
    pressing = false;
    panning = null;
    orreryEl.classList.remove('panning');
  });
  window.addEventListener('blur', function () { pressing = false; });
  orreryEl.addEventListener('wheel', function (e) {
    // Scroll zooms, no Ctrl needed (Devon, Nov 13 — the Index is its
    // own screen now, so there is no page to scroll on this panel).
    e.preventDefault();
    // Round 3: cap 6x (was 3x) — discDetail needs 5.91x for the full
    // 136 cols, and 3x only ever reached 69. Round 4: halved the
    // per-event step (was 0.001) — one mouse scroll fires a burst of
    // wheel events, and at 0.001 a 3-event burst moved zoom x1.35,
    // nearly doubling the sun's character count (chars scale as z^2)
    // in a single scroll. At 0.0005 a 3-event burst is x1.16, sun
    // chars x1.35 — the density changes, but it no longer jumps.
    zoom = Math.max(0.3, Math.min(6, zoom * Math.exp(-e.deltaY * 0.0005)));
    applyTransform();
    scheduleZoomRefresh();
  }, { passive: false });

  // --- clicks (delegated; suppressed right after a drag-pan) ----------------
  worldEl.addEventListener('click', function (e) {
    // Round 17, B — a press that ends where it started is a click,
    // even if the pointer wobbled past the drag threshold mid-press
    // and set suppressClick. Only a press that actually moved away
    // from its start is a pan. (No downPos recorded means the press
    // began outside the orrery — trust suppressClick then.)
    var moved = downPos ? (Math.abs(e.clientX - downPos.x) + Math.abs(e.clientY - downPos.y)) : 0;
    var isPan = suppressClick && (!downPos || moved > 8);
    // Same hit test as hover (discAtPoint): anywhere inside the gold
    // outline — plus the padding — zooms to the planet.
    var disc = discAtPoint(e.clientX, e.clientY);
    if (disc && !isPan) {
      // Clicking the planet you are already zoomed into zooms back
      // out to the orrery — it never jumps to the Index.
      if (zoomed && selected && selected.seed === disc.planet.seed && selected.generation === disc.planet.generation) {
        closeDetail();
        return;
      }
      var planet = findPlanet(disc.planet.seed, disc.planet.generation);
      if (planet) openDetail(planet);
      return;
    }
    if (isPan) return;
    // While zoomed into a planet the ring picker is out of reach:
    // at 5x zoom the ring ellipses cover the whole viewport, so a
    // click that missed the disc used to open the picker and jump to
    // the Index. Ring clicks are ignored until you zoom back out.
    if (zoomed) return;
    // Same hit test as hover (ringAtPoint): only a click within the
    // band around an empty ring's line opens the picker — clicks on
    // the empty black space inside a ring do nothing now.
    var ring = ringAtPoint(e.clientX, e.clientY);
    if (ring >= 0) {
      // Clicks on the star itself do not place a planet — the star
      // sits inside the innermost ring's band, so guard it: the
      // star's visible sphere is the middle half of its element box.
      var starEl = worldEl.querySelector('.star');
      if (starEl) {
        var sr = starEl.getBoundingClientRect();
        var scx = sr.left + sr.width / 2, scy = sr.top + sr.height / 2;
        var srx = sr.width / 4, sry = sr.height / 4;
        var dx = (e.clientX - scx) / srx, dy = (e.clientY - scy) / sry;
        if (dx * dx + dy * dy < 1) return;
      }
      startPicker(ring);
    }
  });
  // Ring hover highlight (Devon, Nov 12): hovering an empty ring
  // highlights the ring ITSELF — the .ring gets .hot, which brightens
  // and thickens its own border. The old gold outline on the hit
  // element sat on top of the ring and read as a second ring.
  function setRingHot(idx, on) {
    var r = worldEl.querySelector('.ring[data-ring="' + idx + '"]');
    if (r) r.classList.toggle('hot', !!on);
  }
  // Round 17, B — one hot ring at a time, driven by the SAME band
  // test as the click handler (ringAtPoint): hovering the empty
  // black space inside a ring no longer lights it up, and the ring
  // that lights up is always the ring a click would open.
  var hotRing = -1;
  function setHotRing(idx) {
    if (idx === hotRing) return;
    if (hotRing >= 0) setRingHot(hotRing, false);
    hotRing = idx;
    if (hotRing >= 0) setRingHot(hotRing, true);
  }
  worldEl.addEventListener('mouseover', function (e) {
    if (e.target.closest && e.target.closest('.disc')) hoverPlanet = true;
    setHotRing(ringAtPoint(e.clientX, e.clientY));
  });
  worldEl.addEventListener('mouseout', function (e) {
    if (e.target.closest && e.target.closest('.disc')) hoverPlanet = false;
    setHotRing(ringAtPoint(e.clientX, e.clientY));
  });
  // mousemove keeps the hot ring fresh while the pointer travels
  // inside one hit area — mouseover only fires on element entry, so
  // moving toward a ring line from inside its own ellipse would
  // otherwise never light it up (and a lit ring would stick after
  // the pointer drifted off its line). One rect read + a <=12-ring
  // loop per move is trivial.
  worldEl.addEventListener('mousemove', function (e) {
    setHotRing(ringAtPoint(e.clientX, e.clientY));
  });
  detailEl.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!t || !selected) return;
    var action = t.getAttribute('data-action');
    if (action === 'close') { closeDetail(); return; }
    if (action === 'showJournal') { detailJournalAll = !detailJournalAll; renderDetail(); return; }
    if (action === 'makeCurrent') {
      vscodeApi.postMessage({ type: 'makeCurrent', seed: selected.seed, generation: selected.generation });
      closeDetail();
    } else if (action === 'salvage') {
      vscodeApi.postMessage({ type: 'salvage', seed: selected.seed, generation: selected.generation });
      closeDetail();
    } else if (action === 'remove') {
      vscodeApi.postMessage({ type: 'remove', ring: +t.getAttribute('data-ring') });
      closeDetail();
    } else if (action === 'place') {
      vscodeApi.postMessage({ type: 'place', ring: +t.getAttribute('data-ring'), seed: selected.seed, generation: selected.generation });
      closeDetail();
    } else if (action === 'replace') {
      startPicker(+t.getAttribute('data-ring'));
      closeDetail();
    }
  });
  tilesEl.addEventListener('click', function (e) {
    if (suppressClick) return;
    var tile = e.target.closest ? e.target.closest('.tile') : null;
    if (!tile) return;
    var seed = +tile.getAttribute('data-seed'), gen = +tile.getAttribute('data-gen');
    if (pickerRing !== null) {
      vscodeApi.postMessage({ type: 'place', ring: pickerRing, seed: seed, generation: gen });
      cancelPicker();
      var planet = findPlanet(seed, gen);
      if (planet) setTimeout(function () { openDetail(planet); }, 350);
      return;
    }
    var planet2 = findPlanet(seed, gen);
    if (planet2) openDetail(planet2);
  });

  // --- top bar -----------------------------------------------------------------
  document.getElementById('zoomIn').addEventListener('click', function () {
    zoom = Math.min(6, zoom * 1.25); applyTransform(); scheduleZoomRefresh();
  });
  document.getElementById('zoomOut').addEventListener('click', function () {
    zoom = Math.max(0.3, zoom / 1.25); applyTransform(); scheduleZoomRefresh();
  });
  document.getElementById('fitBtn').addEventListener('click', fitView);
  document.getElementById('search').addEventListener('input', function (e) {
    searchText = e.target.value; renderIndex();
  });
  document.getElementById('sort').addEventListener('change', function (e) {
    sortMode = e.target.value; renderIndex();
  });
  document.getElementById('mutFilter').addEventListener('change', function (e) {
    mutFilter = e.target.value; renderIndex();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (pickerRing !== null) cancelPicker();
      else if (detailOpen) closeDetail();
      else if (document.body.classList.contains('hide-ui')) document.body.classList.remove('hide-ui');
      return;
    }
    // H hides the interface (only the orrery stays) — not while
    // typing in the search box.
    if ((e.key === 'h' || e.key === 'H') && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) {
      document.body.classList.toggle('hide-ui');
    }
  });
  // A resize changes the tile widths, so the tile art re-renders
  // when the Index is showing (rAF-gated — a drag fires many resizes).
  var indexRaf = null;
  window.addEventListener('resize', function () {
    computeFit();
    if (mode === 'index' && indexRaf === null) {
      indexRaf = requestAnimationFrame(function () { indexRaf = null; renderIndex(); });
    }
  });

  // --- animation loop (150ms tick; early-returns while hidden) ------------------
  var tick = 0;
  setInterval(function () {
    sec += 0.15;
    tick++;
    if (document.hidden) return; // never animate while hidden
    // The planets always drift — no static mode, no toggle (Devon,
    // Nov 11). The drift pauses while hovering a planet or with the
    // detail panel open, so a moving planet can still be clicked.
    // UNIFORM drift: every ring advances by the same angle per tick,
    // so the slot angles — and the separation they guarantee — never
    // change. Planets can never drift into each other or the star.
    // The drift pauses while you hover a planet or while the detail
    // sheet is open — which includes while you are zoomed into one
    // (zoomed always implies detailOpen: openDetail sets it first).
    if (!hoverPlanet && !detailOpen) {
      for (var i in angles) {
        angles[i] += 0.0078;
      }
      layoutPlanets();
    }
    // Round 2 (Devon, Nov 12): the old cadence was discs every 3rd
    // tick (2.2fps) and the sun every 2nd (3.3fps) — the frames were
    // visibly low and the moon jumped 5-12 cells a frame. Discs and
    // sun now re-render every 150ms tick (~7fps, the same cadence as
    // the sidebar pet, which Devon said looks good). A disc render is
    // ~3-6ms, so even a full 12-ring system stays inside the budget.
    // Round 18: skip these while a pointer is pressed (see pressing
    // above) — re-rendering destroys the nodes under the cursor and
    // Chrome then never generates the click. A press lasts ~100ms, so
    // at most one frame is skipped. The sun still churns while hovering
    // (hover is not a press), per the Round 2 note.
    var pressActive = pressingNow();
    if (!pressActive) {
      renderDiscs();
      renderStar(); // the sun churns + flares ~7x/sec now — never frozen while the planets orbit. Outside the hover/detail guard on purpose: hovering a planet shouldn't freeze the sun.
    }
    // The sheet's art re-renders every tick while it is open, so the
    // zoomed planet keeps shimmering — the drift itself is paused.
    if (detailOpen && selected && !pressActive) fillDetailArt();
  }, 150);

  // --- state from the extension --------------------------------------------------
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'system') return;
    state = msg;
    updateRankLine();
    updateStardustChip();
    var sig = indexSignature();
    if (sig !== lastSig) {
      lastSig = sig;
      renderOrrery();
      renderIndex();
      renderMutations();
      if (detailOpen) renderDetail();
    } else if (detailOpen) {
      renderDetail(); // live XP/stage for the current planet
    }
  });

  fitView();
  vscodeApi.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }

  // -- step 4b: the Prestige / fusion panel HTML ------------------------------
  // Full-screen panel, same visual language as the Solar System panel
  // (fixed-cell ASCII renders, amber accents, VS Code theme vars).
  // Top: the two parent slots with the fusion between them. Below: the
  // parent picker (the whole collection, with eligibility). When a
  // fusion is confirmed, the slots give way to the collision stage —
  // a violent ASCII smash (planet.js collisionFrame), with phase
  // captions — and only when the mess has coalesced does the offspring
  // show, with its lineage. The panel never pops anything up; it only
  // posts fuse / dismiss / openSystem messages, and the extension
  // decides.
  getPrestigeHtml(webview) {
    const nonce = getNonce();
    const planetJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'planet.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>
  /* The panel toggles sections with .hidden — but #slotsRow and
  #confirmBar set their own display, which beats the browser's
  built-in [hidden] rule. This line makes hidden actually hide. */
  [hidden] { display: none !important; }
  html, body { -webkit-text-size-adjust: none; text-size-adjust: none; }
  body { margin: 0; background: #050505; color: var(--vscode-editor-foreground);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
  /* Round 17 (F) — planet art is never selectable (see the system
     panel .pp-grid note). */
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
    user-select: none; -webkit-user-select: none;
    -webkit-text-size-adjust: none; text-size-adjust: none; }
  .pp-run { display: inline-block; height: var(--pp-ch, 18px);
    line-height: var(--pp-ch, 18px); vertical-align: top; overflow: hidden;
    white-space: pre; font-kerning: none; }
  /* Buttons: hairline outline, square corners, amber on hover. No VS
     Code blue, no border-radius (Devon, Nov 12 — Instrument). */
  button { background: transparent; color: #d4d4d4;
    border: 1px solid #333; padding: 5px 11px; cursor: pointer; font-size: 12px;
    font-family: inherit; }
  button:hover { border-color: #e8b64c; color: #ffd75f; }
  button:disabled { opacity: .45; cursor: default; }
  button.ghost { background: transparent; border: 1px solid #333; color: #d4d4d4; }
  button.big { font-size: 14px; padding: 9px 20px; font-weight: 600; }
  /* Starfield layer (Devon, Nov 12): the stars are a layer of the
     FRAME, not part of the planet. .pp-frame is the rectangle;
     .pp-stars fills it with sky; .pp-planet is the star-free planet
     render, centered, transparent where there is no planet — so the
     stars show through around it and never stop at the planet's
     edge. */
  .pp-frame { position: relative; }
  .pp-stars { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
  .pp-planet { position: relative; z-index: 1; width: fit-content; margin: 0 auto; }
  /* One thin top line, like the solar system panel: title left,
     counts right. No sub-line — the banner explains the locked state. */
  #topbar { display: flex; align-items: center; gap: 16px;
    height: 36px; padding: 0 14px; border-bottom: 1px solid #1e1e1e;
    background: #050505; position: sticky; top: 0; z-index: 10; }
  #topTitle { font-size: 12px; white-space: nowrap; }
  #counts { font-size: 12px; opacity: .55; white-space: nowrap; margin-left: auto; }
  #banner { background: #0a0a0a; border-bottom: 1px solid #e8b64c; color: #ffd75f;
    padding: 9px 16px; font-size: 12px; line-height: 1.5; }
  /* Full-bleed, no centered column — the panel is the page. */
  main { padding: 18px 28px 48px; background: #050505; }
  /* The fusion stage: two parent slots with the collision between them,
     separated by 1px hairlines, not cards. */
  #slotsRow { display: flex; gap: 1px; align-items: stretch; flex-wrap: wrap; background: #1e1e1e; }
  .parentSlot { flex: 1 1 300px; min-width: 280px; background: #050505; padding: 14px; }
  .parentSlot.picked { outline: 1px solid #e8b64c; outline-offset: -1px; }
  .parentSlot.empty { border: 1px dashed #333; display: flex; flex-direction: column;
    align-items: center; justify-content: center; min-height: 320px; color: rgba(255,255,255,.55);
    font-size: 13px; text-align: center; line-height: 1.6; }
  .parentSlot h3 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  .parentSlot .sub { font-size: 12px; opacity: .75; margin: 0 0 8px; line-height: 1.5; }
  .slotArt { background: #050505; border: 1px solid #1e1e1e; padding: 4px; overflow-x: auto; margin-bottom: 8px;
    user-select: none; -webkit-user-select: none; }
  .slotTag { font-size: 11px; color: #e8b64c; margin-bottom: 4px; }
  .mut { display: inline-block; font-size: 11px; font-weight: 700;
    color: #ffd75f; background: transparent;
    border: 1px solid rgba(255, 215, 95, 0.55); padding: 2px 7px; margin: 0 0 8px; }
  #fusionMid { flex: 0 0 170px; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 8px; text-align: center; background: #050505; }
  #fusionGlyph { font-size: 44px; color: #e8b64c; line-height: 1; }
  #fusionMid .hint { font-size: 12px; opacity: .65; line-height: 1.5; }
  /* The collision stage: the smash itself, full width. */
  #collisionWrap { background: #050505; border: 1px solid #1e1e1e;
    padding: 14px; text-align: center; }
  #collisionCaption { font-size: 14px; font-weight: 600; color: #ffd75f; margin: 0 0 10px; }
  #collisionArt { background: #050505; overflow-x: auto; display: inline-block;
    user-select: none; -webkit-user-select: none; }
  #collisionWrap .skipRow { margin-top: 10px; }
  /* Inheritance preview + confirm. */
  #inheritBar { margin: 14px 0 0; font-size: 12px; line-height: 1.7; }
  #inheritBar .row { margin: 2px 0; }
  #inheritBar .boost { color: #ffd75f; font-weight: 700; }
  #inheritBar .fed { opacity: .75; }
  #confirmBar { margin: 16px 0 0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  #confirmBar .warn { font-size: 12px; opacity: .8; line-height: 1.5; }
  #errorNote { margin: 12px 0 0; font-size: 12px; color: #ff9d9d; line-height: 1.5; }
  /* The result: the offspring, hatched — an amber hairline frame, flat. */
  #result { background: #050505; border: 1px solid #e8b64c; padding: 16px; }
  #result h2 { font-size: 16px; margin: 0 0 2px; }
  #result .sub { font-size: 12px; opacity: .75; margin: 0 0 10px; line-height: 1.5; }
  #resultArt { background: #050505; border: 1px solid #1e1e1e; padding: 4px; overflow-x: auto;
    user-select: none; -webkit-user-select: none;
    margin-bottom: 12px; display: inline-block; }
  #result .lineage { font-size: 13px; margin: 0 0 8px; line-height: 1.6; }
  #result .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  /* The parent picker — a hairline above it, then flat tiles. */
  #parents { margin-top: 26px; border-top: 1px solid #1e1e1e; padding-top: 14px; }
  #parents h2 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
  #parentsCount { font-size: 12px; opacity: .75; margin: 0 0 12px; }
  #cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 1px; background: #1e1e1e; }
  .card { background: #050505; padding: 10px; cursor: pointer; }
  .card:hover { background: #0a0a0a; }
  .card.dim { opacity: .55; cursor: default; }
  .card.dim:hover { background: #050505; }
  .card.pickedA, .card.pickedB { outline: 1px solid #e8b64c; outline-offset: -1px; }
  .card .thumb { background: #050505; border: 1px solid #1e1e1e; margin-bottom: 8px; overflow: hidden;
    user-select: none; -webkit-user-select: none; }
  .card .cname { font-size: 13px; font-weight: 600; }
  .card .cmeta { font-size: 11px; opacity: .7; line-height: 1.5; margin-top: 2px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700;
    padding: 1px 6px; margin: 4px 4px 0 0; }
  .badge.ok { color: #ffd75f; border: 1px solid rgba(255, 215, 95, 0.5); }
  .badge.pick { color: #ffd75f; border: 1px solid rgba(255, 215, 95, 0.5); }
  .badge.mut { color: #ffd75f; border: 1px solid rgba(255, 215, 95, 0.55); }
  .badge.off { color: rgba(255,255,255,.6); border: 1px solid rgba(255,255,255,.25); }
  .empty { font-size: 13px; opacity: .65; padding: 18px 0; }
</style>
</head>
<body>
<header id="topbar">
  <div id="topTitle">PRESTIGE</div>
  <div id="counts"></div>
</header>
<div id="banner" hidden></div>
<main>
  <section id="fusion">
    <div id="slotsRow">
      <div class="parentSlot empty" id="slotA"></div>
      <div id="fusionMid">
        <div id="fusionGlyph">✦</div>
        <div class="hint" id="fusionHint">Pick two parents below —<br>then fuse them.</div>
      </div>
      <div class="parentSlot empty" id="slotB"></div>
    </div>
    <div id="collisionWrap" hidden>
      <p id="collisionCaption"></p>
      <div id="collisionArt"><div class="pp-grid" style="--pp-fs:8.46px;--pp-ch:8.46px"></div></div>
      <div class="skipRow"><button id="skipBtn" class="ghost">Skip the collision</button></div>
    </div>
    <div id="inheritBar"></div>
    <div id="confirmBar" hidden></div>
    <div id="errorNote" hidden></div>
    <div id="result" hidden></div>
  </section>
  <section id="parents">
    <h2>Choose your parents</h2>
    <p id="parentsCount"></p>
    <div id="cards"></div>
  </section>
</main>
<script nonce="${nonce}" src="${planetJsUri}"></script>
<script nonce="${nonce}">
(function () {
  var vscodeApi = acquireVsCodeApi();
  var P = window.Protoplanet;
  var state = null, sec = 0, tick = 0;
  var pickA = null, pickB = null; // planet entries from state.planets
  var confirmOpen = false, fusing = false, fusionT0 = 0, lastError = '';
  var fuseA = null, fuseB = null; // the parents mid-collision (kept
  // separate from the picks: the picks clear when the result lands,
  // but the animation still needs the two planets until it ends)
  var slotAEl = document.getElementById('slotA');
  var slotBEl = document.getElementById('slotB');
  var slotsRowEl = document.getElementById('slotsRow');
  var collisionWrapEl = document.getElementById('collisionWrap');
  var collisionCaptionEl = document.getElementById('collisionCaption');
  var collisionArtEl = document.getElementById('collisionArt');
  var inheritBarEl = document.getElementById('inheritBar');
  var confirmBarEl = document.getElementById('confirmBar');
  var errorNoteEl = document.getElementById('errorNote');
  var resultEl = document.getElementById('result');
  var bannerEl = document.getElementById('banner');
  var countsEl = document.getElementById('counts');
  var parentsCountEl = document.getElementById('parentsCount');
  var cardsEl = document.getElementById('cards');

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Starfield layer (Devon, Nov 12): fill a .pp-frame with twinkling
  // stars sized to the frame's own box. The frame carries its planet
  // grid's cell size + atmosphere color in data attrs; the star grid
  // is sized from the frame's pixel size (scroll size, so a frame
  // wider than its box still gets sky under the scroll). Call after
  // the frame is in the DOM, and on the tick so the stars twinkle.
  function fillStars(frameEl, sec) {
    var starsEl = frameEl.querySelector('.pp-stars');
    if (!starsEl) return;
    var cw = parseFloat(frameEl.getAttribute('data-cw')) || 3.4;
    var ch = parseFloat(frameEl.getAttribute('data-ch')) || 6.12;
    var atmo = parseInt(frameEl.getAttribute('data-atmo') || '244', 10);
    var w = Math.max(frameEl.clientWidth || 0, frameEl.scrollWidth || 0);
    var h = Math.max(frameEl.clientHeight || 0, frameEl.scrollHeight || 0);
    var cols = Math.max(1, Math.ceil(w / cw));
    var rows = Math.max(1, Math.ceil(h / ch));
    starsEl.style.width = w + 'px';
    starsEl.style.height = h + 'px';
    starsEl.innerHTML = '<div class="pp-grid" style="--pp-fs:' + ch + 'px;--pp-ch:' + ch + 'px">'
      + P.starfieldHtml(cols, rows, sec, atmo, cw, ch) + '</div>';
  }
  function refreshStarfields() {
    var frames = document.querySelectorAll('.pp-frame');
    for (var i = 0; i < frames.length; i++) fillStars(frames[i], sec);
  }
  function pickKey(p) { return p.kind + ':' + p.index; }
  function findPlanet(seed, generation) {
    if (!state) return null;
    for (var i = 0; i < state.planets.length; i++) {
      var p = state.planets[i];
      if (p.seed === seed && p.generation === generation) return p;
    }
    return null;
  }
  function isPicked(p) {
    var k = pickKey(p);
    return (pickA && pickKey(pickA) === k) || (pickB && pickKey(pickB) === k);
  }
  function slotHtml(p, tag) {
    var art = P.gridToHtml(P.render(p.planet, p.stageIdx, 10, sec, 1.0, undefined, 1, true), 2.2, 3.96);
    // Round 17 (I) CORRECTED Nov 15 — Devon meant the picker tiles,
    // not the slots: the stars STAY in the Parent A/B windows (the
    // slot keeps its pp-frame), and come OUT of the "Choose your
    // parents" picker tiles below. The slot is a starfield frame
    // with star-free art, like the detail sheet.
    return '<div class="slotTag">' + esc(tag) + '</div>'
      + '<h3>' + esc(p.name) + '</h3>'
      + '<p class="sub">' + esc(p.summary) + ' &middot; Seed ' + p.seed + '</p>'
      + (p.mutationLabel ? '<div class="mut">' + esc(p.mutationLabel) + '</div>' : '')
      + '<div class="slotArt pp-frame" data-cw="2.2" data-ch="3.96" data-atmo="' + p.planet.atmosphere + '"><div class="pp-stars"></div><div class="pp-planet"><div class="pp-grid" style="--pp-fs:3.96px;--pp-ch:3.96px">' + art + '</div></div></div>'
      + '<div class="sub">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName)
      + ' &middot; ' + p.chars + ' characters</div>';
  }
  // Round 17 (H): each slot renders on its own, so a pick change
  // re-renders only the slot whose planet actually changed — never
  // the whole picker. renderSlots() still renders both (first paint
  // / full refresh); renderPickChange() calls just the changed one.
  function renderSlotA() {
    if (pickA) {
      slotAEl.className = 'parentSlot picked';
      slotAEl.innerHTML = slotHtml(pickA, 'Parent A');
    } else {
      slotAEl.className = 'parentSlot empty';
      slotAEl.innerHTML = '<div><b>Parent A</b><br>Pick a planet below.</div>';
    }
  }
  function renderSlotB() {
    if (pickB) {
      slotBEl.className = 'parentSlot picked';
      slotBEl.innerHTML = slotHtml(pickB, 'Parent B');
    } else {
      slotBEl.className = 'parentSlot empty';
      slotBEl.innerHTML = '<div><b>Parent B</b><br>Pick a planet below.</div>';
    }
  }
  function updateFusionHint() {
    document.getElementById('fusionHint').innerHTML =
      (pickA && pickB) ? 'Two worlds, ready.<br>Both stay — retired, never parents again.'
      : 'Pick two parents below —<br>then fuse them.';
  }
  function renderSlots() {
    renderSlotA();
    renderSlotB();
    updateFusionHint();
  }
  function refreshSlotArt() {
    // Round 17 (I): the slot holds only the planet layer now (no
    // starfield), so this targets the planet grid directly. It runs
    // only on a pick change — NOT on the tick (round 17 H): the slot
    // planet is static, so re-rendering it every 450ms was pure cost.
    var gridA = slotAEl.querySelector('.pp-planet .pp-grid');
    if (pickA && gridA) gridA.innerHTML = P.gridToHtml(
      P.render(pickA.planet, pickA.stageIdx, 10, sec, 1.0, undefined, 1, true), 2.2, 3.96);
    var gridB = slotBEl.querySelector('.pp-planet .pp-grid');
    if (pickB && gridB) gridB.innerHTML = P.gridToHtml(
      P.render(pickB.planet, pickB.stageIdx, 10, sec, 1.0, undefined, 1, true), 2.2, 3.96);
  }
  function renderInherit() {
    if (!pickA || !pickB) { inheritBarEl.innerHTML = ''; return; }
    var counts = {};
    var order = [];
    [pickA, pickB].forEach(function (p) {
      (p.mutations || []).forEach(function (id) {
        if (!counts[id]) { counts[id] = 0; order.push(id); }
        counts[id]++;
      });
    });
    var html = '';
    if (order.length === 0) {
      html += '<div class="row">Neither parent carries a mutation — the offspring rolls a fresh one at the usual rare odds.</div>';
    } else {
      // Round 10 — the numbers BEFORE you commit (Brainrot shows them
      // on the fuse screen; so do we): the real chance per parent
      // mutation. inheritOne/inheritBoth ARE the chances now (50% one
      // parent, 75% both — Devon's call, Nov 12), not multipliers.
      var base = state.mutationChance || 0.007;
      var baseStr = (Math.round(base * 1000) / 10) + '%';
      order.forEach(function (id) {
        var def = P.mutationDef(id);
        var name = def ? def.name : id;
        var both = counts[id] >= 2;
        var chance = both ? state.inheritBoth : state.inheritOne;
        var pct = Math.min(100, chance * 100);
        var pctStr = (Math.round(pct * 10) / 10) + '%';
        html += '<div class="row">◆ ' + esc(name) + ' — '
          + (both ? 'both parents carry it' : 'one parent carries it')
          + ' &middot; <span class="boost">' + pctStr + '</span> (base ' + baseStr + ')</div>';
      });
      html += '<div class="row" style="opacity:.65">Anything else can still appear at its usual rare odds — ' + baseStr + ' each.</div>';
    }
    inheritBarEl.innerHTML = html;
  }
  function renderConfirm() {
    if (!pickA || !pickB || fusing || (state && state.result)) { confirmBarEl.hidden = true; return; }
    confirmBarEl.hidden = false;
    if (!confirmOpen) {
      confirmBarEl.innerHTML = '<button id="fuseBtn" class="big">Fuse ' + esc(pickA.name) + ' + ' + esc(pickB.name) + '</button>'
        + '<span class="warn">The offspring starts as dust. ' + (state.birthCost ? esc(state.birthCost) + ' ' : '') + 'The parents stay in your collection, but they can’t be parents again.</span>';
      document.getElementById('fuseBtn').addEventListener('click', function () {
        confirmOpen = true;
        renderConfirm();
      });
    } else {
      confirmBarEl.innerHTML = '<span class="warn"><b>Fuse ' + esc(pickA.name) + ' and ' + esc(pickB.name)
        + '?</b> This is permanent — the offspring hatches right away, and both parents retire from ever being parents again.</span>'
        + '<button id="confirmFuseBtn" class="big">Yes, fuse them</button>'
        + '<button id="cancelFuseBtn" class="ghost">Cancel</button>';
      document.getElementById('confirmFuseBtn').addEventListener('click', startFusion);
      document.getElementById('cancelFuseBtn').addEventListener('click', function () {
        confirmOpen = false;
        renderConfirm();
      });
    }
  }
  function startFusion() {
    if (!pickA || !pickB) return;
    confirmOpen = false;
    fuseA = pickA; fuseB = pickB;
    fusing = true;
    fusionT0 = sec;
    slotsRowEl.hidden = true;
    inheritBarEl.hidden = true;
    confirmBarEl.hidden = true;
    errorNoteEl.hidden = true;
    resultEl.hidden = true;
    collisionWrapEl.hidden = false;
    vscodeApi.postMessage({ type: 'prestige', a: { kind: pickA.kind, index: pickA.index }, b: { kind: pickB.kind, index: pickB.index } });
  }
  function collisionCaption(phase) {
    return {
      approach: 'Two worlds spiral in, circling closer…',
      impact: 'IMPACT — the crusts shatter.',
      explosion: 'Material sprays into space — rock, dust, and fire.',
      swirl: 'The debris falls into orbit, circling the wreck.',
      coalesce: 'Something new is gathering out of the mess…',
      done: 'The offspring hatches.',
    }[phase] || '';
  }
  function renderCollision() {
    if (!state || !state.result || !fuseA || !fuseB) return;
    var t = sec - fusionT0;
    var phase = P.collisionPhase(t);
    collisionCaptionEl.textContent = collisionCaption(phase);
    var artEl = collisionArtEl.querySelector('.pp-grid');
    if (artEl) artEl.innerHTML = P.gridToHtml(
      P.collisionFrame(fuseA.planet, fuseB.planet, state.result.offspring.planet, t, sec), 4.7, 8.46);
    if (t >= P.COLLISION_END) {
      fusing = false;
      fuseA = null; fuseB = null;
      collisionWrapEl.hidden = true;
      renderAll();
    }
  }
  function renderResult() {
    if (!state || !state.result) { resultEl.hidden = true; return; }
    var r = state.result;
    var off = r.offspring;
    var art = P.gridToHtml(P.render(off.planet, off.stageIdx, 10, sec, 1.2), 2.35, 4.23);
    var parentNames = r.parents.map(function (p) { return esc(p.name || ('Seed ' + p.seed)); }).join(' + ');
    var mutName = function (id) { var d = P.mutationDef(id); return d ? d.name : id; };
    var html = '<h2>' + esc(off.name) + ' hatches</h2>'
      + '<p class="sub">' + esc(off.summary) + ' &middot; Seed ' + off.seed + '</p>'
      + (off.mutationLabel ? '<div class="mut">' + esc(off.mutationLabel) + '</div>' : '')
      + '<div id="resultArt"><div class="pp-grid" style="--pp-fs:4.23px;--pp-ch:4.23px">' + art + '</div></div>'
      + '<p class="lineage">Born from <b>' + parentNames + '</b>.</p>';
    if (r.inherited.length > 0) {
      html += '<p class="lineage">Inherited: <b>' + r.inherited.map(mutName).map(esc).join(', ') + '</b></p>';
    } else {
      html += '<p class="lineage">It inherited no mutation — a fresh roll.</p>';
    }
    if (r.fresh.length > 0) {
      html += '<p class="lineage">New roll: <b>' + r.fresh.map(mutName).map(esc).join(', ') + '</b></p>';
    }
    html += '<p class="lineage" style="opacity:.7">The parents stay in your collection, retired — each can only be a parent once.</p>'
      + '<div class="actions"><button id="openSystemBtn">Open Solar System</button>'
      + '<button id="fuseAgainBtn" class="ghost">Fuse again</button></div>';
    resultEl.innerHTML = html;
    resultEl.hidden = false;
    document.getElementById('openSystemBtn').addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'openSystem' });
    });
    document.getElementById('fuseAgainBtn').addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'dismissResult' });
    });
  }
  function refreshResultArt() {
    if (!state || !state.result) return;
    var off = state.result.offspring;
    var gridEl = resultEl.querySelector('.pp-grid');
    if (gridEl) gridEl.innerHTML = P.gridToHtml(
      P.render(off.planet, off.stageIdx, 10, sec, 1.2), 2.35, 4.23);
  }
  function renderCards() {
    if (!state) return;
    var list = state.planets;
    parentsCountEl.textContent = state.planets.length + ' planet' + (state.planets.length === 1 ? '' : 's')
      + ' in your collection — ' + state.eligibleCount + ' eligible to be parents';
    if (list.length === 0) {
      cardsEl.innerHTML = '<div class="empty">No planets yet — type to grow your first one, and it will show up here when it reaches Civilization.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var picked = isPicked(p);
      var tag = picked ? (pickA && pickKey(pickA) === pickKey(p) ? 'Parent A' : 'Parent B') : null;
      var thumb = P.gridToHtml(P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19, undefined, 1, true), 3.4, 6.12);
      // Round 17 (I) CORRECTED Nov 15 — the picker tiles are
      // star-free (no pp-frame, no pp-stars): the animated stars
      // looked bad behind the static planet on these little tiles.
      // The Parent A/B slots above keep their starfield frame.
      html += '<div class="card' + (!p.eligible ? ' dim' : '') + (picked ? (tag === 'Parent A' ? ' pickedA' : ' pickedB') : '') + '"'
        + ' data-seed="' + p.seed + '" data-gen="' + p.generation + '">'
        + '<div class="thumb"><div class="pp-planet"><div class="pp-grid" style="--pp-fs:6.12px;--pp-ch:6.12px">' + thumb + '</div></div></div>'
        + '<div class="cname">' + esc(p.name) + '</div>'
        + '<div class="cmeta">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName) + ' &middot; ' + p.chars + ' chars</div>'
        + (p.kind === 'current' ? '<span class="badge ok">Growing now</span>' : '')
        + (tag ? '<span class="badge pick">' + esc(tag) + '</span>' : '')
        + (!p.eligible && p.eligibilityReason === 'already-parent' ? '<span class="badge off">Already a parent</span>' : '')
        + (p.mutationLabel ? '<span class="badge mut">' + esc(p.mutationLabel) + '</span>' : '')
        + (!p.eligible && p.eligibilityReason === 'too-young'
          ? '<div class="cmeta">' + p.chars + ' / ' + state.minChars + ' characters to Civilization</div>' : '')
        + '</div>';
    }
    cardsEl.innerHTML = html;
  }
  function renderBanner() {
    if (!state) return;
    countsEl.textContent = state.eligibleCount + ' eligible · ' + state.planets.length + ' planets';
    if (state.canFuse) {
      bannerEl.hidden = true;
    } else {
      bannerEl.hidden = false;
      bannerEl.textContent = 'Prestige needs two planets that reached Civilization (' + state.minChars
        + '+ characters). You have ' + state.eligibleCount + ' eligible so far — keep typing, and the ones close to Civilization show their progress below.';
    }
  }
  function renderAll() {
    if (!state) return;
    renderBanner();
    if (state.result) {
      slotsRowEl.hidden = true;
      inheritBarEl.hidden = true;
      confirmBarEl.hidden = true;
      collisionWrapEl.hidden = true;
      renderResult();
    } else {
      slotsRowEl.hidden = false;
      inheritBarEl.hidden = false;
      resultEl.hidden = true;
      renderSlots();
      renderInherit();
      renderConfirm();
    }
    if (lastError) {
      errorNoteEl.hidden = false;
      errorNoteEl.textContent = lastError;
    } else {
      errorNoteEl.hidden = true;
    }
    renderCards();
    refreshStarfields();
  }
  // --- Round 17 (H): cheap pick + cheap state updates -------------------
  // What a click used to cost: togglePick() called renderAll(), which
  // re-rendered EVERY picker card (a full P.renderCozy + gridToHtml
  // per planet), BOTH slots (full P.render each), and then
  // refreshStarfields() regenerated a star grid for every frame —
  // and the same renderAll() ran on EVERY state message, i.e. on
  // every keystroke while the panel was open (pushState posts the
  // prestige view model per keystroke). Same class of problem as the
  // sidebar lag in scratch/lag-click-investigation.md: a full
  // re-render + full re-layout on every interaction. The fix, same
  // shape: update only what changed.
  function findCardEl(p) {
    if (!p) return null;
    return cardsEl.querySelector('.card[data-seed="' + p.seed + '"][data-gen="' + p.generation + '"]');
  }
  function updateCardPick(cardEl, tag) {
    if (!cardEl) return;
    cardEl.classList.remove('pickedA', 'pickedB');
    var old = cardEl.querySelector('.badge.pick');
    if (old) old.remove();
    if (!tag) return;
    cardEl.classList.add(tag === 'Parent A' ? 'pickedA' : 'pickedB');
    var badge = document.createElement('span');
    badge.className = 'badge pick';
    badge.textContent = tag;
    var anchor = cardEl.querySelector('.badge.mut') || cardEl.querySelector('.badge.off');
    if (anchor) cardEl.insertBefore(badge, anchor);
    else cardEl.appendChild(badge);
  }
  // A pick change touches at most 3 cards (old A/B + new pick) and
  // the slot(s) whose planet changed — no card art is re-rendered,
  // no starfield is regenerated (twinkle stays on the tick).
  function renderPickChange(oldA, oldB) {
    var touched = {};
    [oldA, oldB, pickA, pickB].forEach(function (p) {
      if (!p) return;
      var k = pickKey(p);
      if (touched[k]) return;
      touched[k] = true;
      var tag = null;
      if (pickA && pickKey(pickA) === k) tag = 'Parent A';
      else if (pickB && pickKey(pickB) === k) tag = 'Parent B';
      updateCardPick(findCardEl(p), tag);
    });
    if ((oldA ? pickKey(oldA) : null) !== (pickA ? pickKey(pickA) : null)) renderSlotA();
    if ((oldB ? pickKey(oldB) : null) !== (pickB ? pickKey(pickB) : null)) renderSlotB();
    updateFusionHint();
    renderInherit();
    renderConfirm();
    if (lastError) {
      errorNoteEl.hidden = false;
      errorNoteEl.textContent = lastError;
    } else {
      errorNoteEl.hidden = true;
    }
  }
  // Signature of everything a full renderAll() can change, EXCLUDING
  // the per-keystroke character counts: if only the counts moved,
  // the art, eligibility and badges are all still right, so the
  // state message gets a text-only update instead of a full rebuild.
  var lastPrestigeSig = null;
  function prestigeSig(s) {
    if (!s) return '';
    var parts = [s.eligibleCount, s.canFuse, s.minChars, s.result ? 'result' : ''];
    for (var i = 0; i < s.planets.length; i++) {
      var p = s.planets[i];
      parts.push(p.kind + ':' + p.seed + ':' + p.generation + ':' + p.stageIdx + ':'
        + (p.eligible ? 'e' : 'x') + ':' + (p.eligibilityReason || '') + ':'
        + (p.mutationLabel || '') + ':' + p.name);
    }
    return parts.join('|');
  }
  function updatePrestigeTextOnly() {
    if (!state) return;
    renderBanner();
    parentsCountEl.textContent = state.planets.length + ' planet' + (state.planets.length === 1 ? '' : 's')
      + ' in your collection — ' + state.eligibleCount + ' eligible to be parents';
    // Rebind the picks to the fresh state objects (same planets, new
    // char counts) so the slot lines below read current numbers.
    if (pickA) pickA = findPlanet(pickA.seed, pickA.generation) || pickA;
    if (pickB) pickB = findPlanet(pickB.seed, pickB.generation) || pickB;
    for (var i = 0; i < state.planets.length; i++) {
      var p = state.planets[i];
      var cardEl = findCardEl(p);
      if (!cardEl) continue;
      var metas = cardEl.querySelectorAll('.cmeta');
      if (metas[0]) metas[0].textContent = p.terrainLabel + ' · ' + p.stageName + ' · ' + p.chars + ' chars';
      if (metas[1]) metas[1].textContent = p.chars + ' / ' + state.minChars + ' characters to Civilization';
    }
    [[slotAEl, pickA], [slotBEl, pickB]].forEach(function (pair) {
      var slotEl = pair[0], pick = pair[1];
      if (!slotEl || !pick) return;
      var subs = slotEl.querySelectorAll('.sub');
      var line = subs[subs.length - 1];
      if (line) line.textContent = pick.terrainLabel + ' · ' + pick.stageName + ' · ' + pick.chars + ' characters';
    });
  }
  function togglePick(p) {
    if (!p.eligible) return;
    var oldA = pickA, oldB = pickB;
    var k = pickKey(p);
    if (pickA && pickKey(pickA) === k) pickA = null;
    else if (pickB && pickKey(pickB) === k) pickB = null;
    else if (!pickA) pickA = p;
    else if (!pickB) pickB = p;
    else pickB = p; // both full: replace B
    confirmOpen = false;
    lastError = '';
    renderPickChange(oldA, oldB);
  }

  cardsEl.addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    var p = findPlanet(+card.getAttribute('data-seed'), +card.getAttribute('data-gen'));
    if (p) togglePick(p);
  });
  document.getElementById('skipBtn').addEventListener('click', function () {
    if (!fusing) return;
    fusing = false;
    fuseA = null; fuseB = null;
    collisionWrapEl.hidden = true;
    renderAll();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (confirmOpen) { confirmOpen = false; renderConfirm(); }
  });

  // --- animation loop (150ms tick) -------------------------------------------
  setInterval(function () {
    sec += 0.15;
    tick++;
    if (document.hidden) return;
    if (fusing) { renderCollision(); return; }
    if (tick % 3 === 0) {
      // Round 17 (H): no refreshSlotArt() here — the slot planets
      // are static (Devon: the planet isn't animated in the tiny
      // picker windows), so re-rendering both slots every 450ms was
      // pure cost on top of the card starfields. Slots re-render
      // only when the pick changes (renderPickChange). The result
      // art still animates, and the picker tiles keep twinkling.
      refreshResultArt();
      refreshStarfields();
    }
  }, 150);

  // --- state from the extension --------------------------------------------------
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'prestige') return;
    // Round 17 (H): the host posts this view model on every
    // keystroke, and the old handler ran a full renderAll() on each
    // one. If nothing a full render can change moved (same planets,
    // stages, eligibility, mutations, no result change), update only
    // the character-count text — no card art, no slot art, no
    // starfields. Same signature-guard shape as the system panel.
    var sig = prestigeSig(msg);
    if (sig === lastPrestigeSig && !msg.result && !fusing) {
      state = msg;
      updatePrestigeTextOnly();
      return;
    }
    lastPrestigeSig = sig;
    var hadResult = !!(state && state.result);
    state = msg;
    if (state.result && !hadResult) {
      // A fusion just landed: the parents retire, so the picks clear.
      // The collision plays first (fusing stays on until it ends);
      // if the fusion came from somewhere else, the result shows now.
      pickA = null; pickB = null; confirmOpen = false;
      if (!fusing) renderAll();
    } else if (fusing && !state.result) {
      // The fusion didn't go through (a parent changed mid-flight).
      fusing = false;
      collisionWrapEl.hidden = true;
      lastError = 'That fusion didn’t go through — a parent may have changed. Pick again.';
      renderAll();
    } else {
      renderAll();
    }
  });

  vscodeApi.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }

  // -- share card panel HTML ---------------------------------------------------
  // The card: the live ASCII render (same fixed-cell rule as the
  // sidebar — gridToHtml + explicit cell sizes, 10:18 ratio), the
  // planet name, the mutation tag, the stage/generation/grown-from
  // line, the seed with a copy button, the three actions, and the
  // README markdown block. The PNG is drawn on a hidden canvas from
  // the same planet grid (cozy 68x38, chunky 16px cells, caption with
  // name + seed), so the downloaded file is the planet art itself —
  // postable to X/Reddit or a README as-is.
  getShareHtml(webview) {
    const nonce = getNonce();
    const planetJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'planet.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>
  html, body { -webkit-text-size-adjust: none; text-size-adjust: none; }
  body { margin: 0; padding: 20px; background: #050505;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family); }
  #card { max-width: 760px; margin: 0 auto; }
  #wrap { background: #050505; border: 1px solid var(--vscode-widget-border, #222);
    padding: 6px; overflow-x: auto; }
  /* Round 17 (F) — the share-card art is never selectable. */
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
    user-select: none; -webkit-user-select: none;
    -webkit-text-size-adjust: none; text-size-adjust: none; }
  .pp-run { display: inline-block; height: var(--pp-ch, 18px);
    line-height: var(--pp-ch, 18px); vertical-align: top; overflow: hidden;
    white-space: pre; font-kerning: none; }
  /* Starfield layer (Devon, Nov 12): the stars are a layer of the
     FRAME, not part of the planet. .pp-frame is the rectangle;
     .pp-stars fills it with sky; .pp-planet is the star-free planet
     render, centered, transparent where there is no planet — so the
     stars show through around it and never stop at the planet's
     edge. */
  .pp-frame { position: relative; }
  .pp-stars { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
  .pp-planet { position: relative; z-index: 1; width: fit-content; margin: 0 auto; }
  h1 { font-size: 20px; margin: 14px 0 4px; }
  #mutationLabel { display: inline-block; font-size: 11px; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase; color: #ffd75f;
    background: rgba(255, 215, 95, .12); border: 1px solid rgba(255, 215, 95, .55);
    border-radius: 3px; padding: 2px 7px; margin: 0 0 8px; }
  #meta { font-size: 13px; opacity: .8; margin: 0 0 4px; line-height: 1.5; }
  #seedLine { font-size: 13px; margin: 0 0 14px; }
  #seedLine code { font-family: ${FONT_STACK}; background: #1a1a1a;
    border: 1px solid #333; border-radius: 3px; padding: 1px 6px; }
  button { font-family: var(--vscode-font-family); font-size: 13px;
    border-radius: 6px; border: 1px solid var(--vscode-widget-border, #333);
    background: var(--vscode-button-secondaryBackground, #2a2a2a);
    color: var(--vscode-button-secondaryForeground, #ddd);
    padding: 7px 14px; margin: 0 8px 8px 0; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #3a3a3a); }
  #downloadPngBtn { background: #e8b64c; border-color: #e8b64c; color: #111; font-weight: 600; }
  #downloadPngBtn:hover { background: #ffd75f; }
  h2 { font-size: 14px; margin: 18px 0 6px; }
  #markdownBlock { background: #0b0b0b; border: 1px solid #262626; border-radius: 6px;
    padding: 10px 12px; font-size: 12px; line-height: 1.6; white-space: pre-wrap;
    word-break: break-all; font-family: ${FONT_STACK}; margin: 0 0 10px; }
  #hint { font-size: 12px; opacity: .6; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
<div id="card">
  <div id="wrap" class="pp-frame"><div class="pp-stars"></div><div class="pp-planet"><pre class="pp-grid" id="grid"></pre></div></div>
  <h1 id="planetName">Your planet</h1>
  <div id="mutationLabel" style="display:none"></div>
  <p id="meta"></p>
  <p id="seedLine">Seed <code id="seedText"></code></p>
  <div>
    <button type="button" id="downloadPngBtn">Download PNG</button>
    <button type="button" id="copySeedBtn">Copy seed</button>
    <button type="button" id="copyMarkdownBtn">Copy Markdown</button>
  </div>
  <h2>GitHub README</h2>
  <pre id="markdownBlock"></pre>
  <p id="hint">The seed hatches the same base planet &mdash; a friend can paste it into their own Protoplanet and grow the same world. The PNG is the planet art, ready to post.</p>
</div>
<canvas id="pngCanvas" style="display:none"></canvas>
<script nonce="${nonce}" src="${planetJsUri}"></script>
<script nonce="${nonce}">
(function () {
  var vscodeApi = acquireVsCodeApi();
  var P = window.Protoplanet;
  var gridEl = document.getElementById('grid');
  var wrapEl = document.getElementById('wrap');
  var root = document.documentElement;
  var FONT_STACK = ${JSON.stringify(FONT_STACK)};
  var cellW = 3, cellH = 5.4, state = null, sec = 0, stageStartSec = 0, lastStage = -1;

  // --- Fixed-cell layout (same approach as the sidebar) ----------------------
  // Cells scale to fit the card width — the 10:18 ratio never changes.
  // The font size is measured from the real monospace font at runtime,
  // so one glyph advance == one cell width.
  function layout() {
    var avail = Math.max(50, wrapEl.clientWidth - 12);
    var scale = avail / (P.CONFIG.W * P.CONFIG.CELL_W);
    var newW = Math.max(1, +(10 * scale).toFixed(2));
    var newH = Math.max(1.8, +(18 * scale).toFixed(2));
    if (newW === cellW && newH === cellH && root.style.getPropertyValue('--pp-fs')) return;
    cellW = newW; cellH = newH;
    wrapEl.setAttribute('data-cw', cellW);
    wrapEl.setAttribute('data-ch', cellH);
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-family:' + FONT_STACK +
      ';font-size:16px;letter-spacing:0;white-space:pre;';
    probe.textContent = 'MMMMMMMMMMMMMMMMMMMM'; // 20 chars
    document.body.appendChild(probe);
    var adv16 = probe.offsetWidth / 20;
    probe.remove();
    var fs = 16 * cellW / adv16;
    if (fs > cellH) fs = cellH; // never taller than the cell
    root.style.setProperty('--pp-ch', cellH + 'px');
    root.style.setProperty('--pp-fs', fs.toFixed(2) + 'px');
  }
  layout();
  window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

  // Starfield layer (Devon, Nov 12): fill a .pp-frame with twinkling
  // stars sized to the frame's own box. The frame carries its planet
  // grid's cell size + atmosphere color in data attrs; the star grid
  // is sized from the frame's pixel size (scroll size, so a frame
  // wider than its box still gets sky under the scroll). Call after
  // the frame is in the DOM, and on the tick so the stars twinkle.
  function fillStars(frameEl, sec) {
    var starsEl = frameEl.querySelector('.pp-stars');
    if (!starsEl) return;
    var cw = parseFloat(frameEl.getAttribute('data-cw')) || 3.4;
    var ch = parseFloat(frameEl.getAttribute('data-ch')) || 6.12;
    var atmo = parseInt(frameEl.getAttribute('data-atmo') || '244', 10);
    var w = Math.max(frameEl.clientWidth || 0, frameEl.scrollWidth || 0);
    var h = Math.max(frameEl.clientHeight || 0, frameEl.scrollHeight || 0);
    var cols = Math.max(1, Math.ceil(w / cw));
    var rows = Math.max(1, Math.ceil(h / ch));
    starsEl.style.width = w + 'px';
    starsEl.style.height = h + 'px';
    starsEl.innerHTML = '<div class="pp-grid" style="--pp-fs:' + ch + 'px;--pp-ch:' + ch + 'px">'
      + P.starfieldHtml(cols, rows, sec, atmo, cw, ch) + '</div>';
  }
  function refreshStarfields() {
    var frames = document.querySelectorAll('.pp-frame');
    for (var i = 0; i < frames.length; i++) fillStars(frames[i], sec);
  }
  function renderMeta() {
    document.getElementById('planetName').textContent = state.name;
    var mutEl = document.getElementById('mutationLabel');
    if (state.mutationLabel) { mutEl.textContent = state.mutationLabel; mutEl.style.display = 'inline-block'; }
    else { mutEl.style.display = 'none'; }
    document.getElementById('meta').textContent =
      state.stageName + ' \\u00b7 grown from ' + state.chars + ' characters';
    document.getElementById('seedText').textContent = state.shareSeed || state.seed;
    document.getElementById('markdownBlock').textContent = state.markdown;
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === 'share') {
      // Same rule as the sidebar (round 3): the birth morph replays
      // only on a real birth/level-up, never on panel load — the share
      // panel re-renders the full 136x76 grid every tick, so replaying
      // the t=0 explosion on open is its most expensive first render.
      if (!state) {
        stageStartSec = msg.chars === 0 ? sec : sec - 10; // settled unless newborn
      } else if ((msg.planet && state.planet && msg.planet.seed !== state.planet.seed) || msg.stageIdx !== lastStage) {
        stageStartSec = sec;
      }
      lastStage = msg.stageIdx;
      state = msg;
      wrapEl.setAttribute('data-atmo', state.planet.atmosphere);
      layout();
      renderMeta();
    } else if (msg.type === 'copied') {
      // The host confirms the clipboard write — flash the button so
      // the player knows it landed. No popup for a copy.
      var btn = msg.what === 'seed'
        ? document.getElementById('copySeedBtn')
        : document.getElementById('copyMarkdownBtn');
      var orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = orig; }, 1200);
    } else if (msg.type === 'saved') {
      // The host confirms the PNG hit the disk — flash the Download
      // button. No popup for a save either.
      var dl = document.getElementById('downloadPngBtn');
      var dlOrig = dl.textContent;
      dl.textContent = 'Saved!';
      setTimeout(function () { dl.textContent = dlOrig; }, 1200);
    }
  });

  // Animate: ~7 fps is plenty for the flicker/drift illusion.
  setInterval(function () {
    sec += 0.15;
    if (!state) return;
    var t = Math.max(0, sec - stageStartSec);
    gridEl.innerHTML = P.gridToHtml(P.render(state.planet, state.stageIdx, t, sec, undefined, undefined, undefined, true), cellW, cellH);
    fillStars(wrapEl, sec);
  }, 150);

  // --- PNG: the same planet, drawn cell by cell on a canvas ------------------
  // Full grid (136x76, the same grid the panel shows) at 8px cells —
  // 1088px wide, postable on X/Reddit and in a README. The cozy grid
  // (68x38) was tried first: at 16px cells the disc reads as a loose
  // scatter of letters, the night side as a hole, and the starfield
  // 'i's as big green letters everywhere. The full grid at 8px cells
  // is dense and reads as the sphere Devon knows.
  var PNG_CELL_W = 8, PNG_CELL_H = PNG_CELL_W * (P.CONFIG.CELL_H / P.CONFIG.CELL_W);
  function drawPng() {
    if (!state) return null;
    // The render takes (zoom, stage0Style, smokeScale) after sec —
    // P.CONFIG.W/H are NOT stage0Style/smokeScale. Passing them drew
    // stage 0 as a sparse non-exploded core (264 cells instead of
    // 670) with a smokeScale of 76; stage 6+ was unaffected. The
    // defaults are what the panel shows: exploded core, smoke 1,
    // stars on.
    var grid = P.render(state.planet, state.stageIdx,
      Math.max(0, sec - stageStartSec), sec, 1.0);
    var canvas = document.getElementById('pngCanvas');
    var captionH = 56;
    canvas.width = P.CONFIG.W * PNG_CELL_W;
    canvas.height = Math.round(P.CONFIG.H * PNG_CELL_H) + captionH;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '13px ' + FONT_STACK; // monospace advance ~0.6em == 8px cell
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var y = 0; y < grid.length; y++) {
      for (var x = 0; x < grid[y].length; x++) {
        var cell = grid[y][x];
        if (cell[1] === null) continue; // empty sky stays the dark background
        var rgb = P.ansi256ToRgb(cell[1]);
        ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
        ctx.fillText(cell[0], (x + 0.5) * PNG_CELL_W, (y + 0.5) * PNG_CELL_H);
      }
    }
    ctx.fillStyle = '#e8b64c';
    ctx.font = '20px ' + FONT_STACK;
    ctx.fillText(state.name + ' \\u00b7 seed ' + (state.shareSeed || state.seed),
      canvas.width / 2, Math.round(P.CONFIG.H * PNG_CELL_H) + 28);
    return canvas;
  }

  document.getElementById('downloadPngBtn').addEventListener('click', function () {
    var canvas = drawPng();
    if (!canvas) return;
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var reader = new FileReader();
      reader.onload = function () {
        vscodeApi.postMessage({ type: 'downloadPng', dataUrl: reader.result, filename: state.filename });
      };
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
  document.getElementById('copySeedBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'copySeed' });
  });
  document.getElementById('copyMarkdownBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'copyMarkdown' });
  });

  vscodeApi.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// The sidebar view provider: resolves the webview and relays state to it.
// ---------------------------------------------------------------------------
class PetViewProvider {
  constructor(app) {
    this.app = app;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.app.context.extensionUri],
    };
    webviewView.webview.html = this.app.getWebviewHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready') this.postState(this.app.viewModel());
    });
    webviewView.onDidDispose(() => { this.view = null; });
  }

  postState(viewModel) {
    if (!this.view) return;
    // No planet (first run, or destroyed with nothing growing yet):
    // tell the webview explicitly, so a sidebar that was showing a
    // planet clears back to its placeholder instead of keeping the
    // dead planet on screen (round 9 — Devon). A fresh webview
    // already shows the placeholder, so this is harmless there.
    // `destroyed` tells the placeholder which words to use: after a
    // destroy there is no starter pick anymore — the way back is the
    // New Planet command or the Index.
    this.view.webview.postMessage(viewModel || { type: 'empty', destroyed: !!this.state.starterDone });
  }
}

// The live app, so deactivate() can flush a pending save on shutdown.
let activeApp = null;

function activate(context) {
  activeApp = new ProtoplanetApp(context);
  // First run (once): ask for the starter terrain. Fire and forget —
  // the extension works fine while the pick is open.
  activeApp.maybeFirstRun();
  return activeApp;
}

function deactivate() {
  // Best effort: flush any pending save on shutdown.
  if (activeApp) activeApp.saveNow();
}

module.exports = { activate, deactivate };
