// extension.js — Piece 2: the VS Code wiring for Protoplanet.
//
// This file only talks to VS Code (events, webview, status bar,
// globalState). All the pet logic lives in petLogic.js, which is pure
// JS and tested in plain Node (test-pet.js). Keep it that way: if you
// add a rule about how the pet behaves, it goes in petLogic.js, not here.
//
// Ambient rule: this extension NEVER interrupts coding. No popups while
// typing — evolutions show in the pet window and status bar only. The
// only popup is the one-time first-run starter pick, and the "New
// planet" confirmation (which you asked for by running the command).

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
    this.state = Logic.deserializeState(context.globalState.get(STATE_KEY, ''));
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'protoplanet.showPet';
    this.statusBar.tooltip = 'Protoplanet — click to show your planet';
    this.statusBar.show();
    this.viewProvider = new PetViewProvider(this);
    this.systemPanel = null; // the Solar System panel (step 4), or null
    this.prestigePanel = null; // the Prestige / fusion panel (step 4b), or null
    this.prestigeResult = null; // the last fusion result, shown until dismissed
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
      vscode.commands.registerCommand('protoplanet.feedMineral', () => this.feedMineral())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.salvagePlanet', () => this.salvagePlanet())
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.prestige', () => this.prestige())
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

  // -- commands --------------------------------------------------------------

  async showPet() {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  async newPlanet() {
    const answer = await vscode.window.showWarningMessage(
      'Start a fresh planet? Your current planet will be kept in your collection.',
      { modal: true },
      'Yes, new planet'
    );
    if (answer !== 'Yes, new planet') return;
    Logic.newPlanet(this.state, Logic.randomSeed);
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
      placeHolder: 'Seed number, e.g. 805839337',
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
    const answer = await vscode.window.showWarningMessage(
      `Hatch the planet from seed ${parsed.seed}? Your current planet will be kept in your collection. The hatched planet is the seed's base planet — it never carries mutations.`,
      { modal: true },
      'Yes, hatch it'
    );
    if (answer !== 'Yes, hatch it') return;
    Logic.hatchFromSeed(this.state, parsed.seed);
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
    Logic.newPlanet(this.state, Logic.randomSeed);
    this.saveNow();
    this.pushState();
  }

  // -- step 2 commands: minerals, salvage/recycle, prestige --------------
  // All three are user-invoked (Command Palette), so a QuickPick or a
  // confirmation is fine — the no-popups rule is about typing, and
  // these never fire while typing. Results surface in the pet window
  // and status bar, never as a notification.

  async feedMineral() {
    const inv = this.state.minerals || [];
    if (inv.length === 0) return; // can't happen — first run grants one
    const items = inv.map((m) => ({
      label: Logic.mineralName(m),
      description: Logic.mineralTiltsText(m),
      id: m.id,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Protoplanet: feed a mineral — it tilts your NEXT planet',
      ignoreFocusOut: true,
    });
    if (!pick) return;
    Logic.feedMineral(this.state, pick.id);
    this.saveNow();
    this.pushState();
  }

  async salvagePlanet() {
    const items = [];
    if (this.state.current) {
      const mutLabel = Planet.mutationLabel(this.state.current);
      items.push({
        label: `Recycle current planet — ${this.state.current.summary}`,
        description: 'Destroy it for minerals and hatch a fresh planet right away',
        detail: mutLabel ? `Carries: ${mutLabel}` : 'No mutation — yields one plain mineral',
        kind: 'current',
      });
    }
    this.state.past.forEach((p, i) => {
      items.push({
        label: `Salvage ${p.summary} · Gen ${p.generation}`,
        description: 'Destroy it for minerals (no new planet)',
        detail: p.mutations && p.mutations.length > 0
          ? `Carries: ${p.mutations.map((id) => (Planet.mutationDef(id) || {}).name || id).join(', ')}`
          : 'No mutation — yields one plain mineral',
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
      const answer = await vscode.window.showWarningMessage(
        'Recycle your current planet? It will be destroyed for minerals and a fresh planet hatches right away.',
        { modal: true },
        'Yes, recycle it'
      );
      if (answer !== 'Yes, recycle it') return;
      Logic.recycleCurrent(this.state, Logic.randomSeed);
    } else {
      const answer = await vscode.window.showWarningMessage(
        'Salvage this planet from your collection? It will be destroyed for minerals.',
        { modal: true },
        'Yes, salvage it'
      );
      if (answer !== 'Yes, salvage it') return;
      Logic.salvageArchived(this.state, pick.index);
    }
    this.saveNow();
    this.pushState();
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
    const answer = await vscode.window.showWarningMessage(
      `Prestige ${a.label} + ${b.label}? Their offspring starts as dust with boosted odds of inheriting their mutations. The parents stay in your collection but can't be parents again.`,
      { modal: true },
      'Yes, prestige them'
    );
    if (answer !== 'Yes, prestige them') return;
    const res = Logic.prestige(this.state,
      { kind: a.kind, index: a.index },
      { kind: b.kind, index: b.index },
      Logic.randomSeed);
    if (!res.ok) return; // state changed between picks (shouldn't happen)
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
      generation: kind === 'current' ? this.state.generation : record.generation,
      archivedAt: record.archivedAt || null,
      mutations: (record.mutations || []).slice(),
      mutationLabel: Planet.mutationLabel({ mutations: record.mutations || [] }),
      parents: record.parents || null,
      usedAsParent: !!record.usedAsParent,
      kind,
      stageIdx: dStage,
      stageName: Planet.STAGES[dStage].name,
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
    return {
      type: 'system',
      rank: rank.rank,
      finished: rank.finished,
      totalSlots: rank.totalSlots,
      nextAt: rank.nextAt,
      toNext: rank.toNext,
      ringsUsed,
      totalPlanets: index.length,
      slots,
      index,
    };
  }

  postSystemState() {
    if (this.systemPanel) this.systemPanel.webview.postMessage(this.solarSystemViewModel());
  }

  // Messages from the panel: place a planet on a ring, or take one
  // off. The panel never mutates state itself — it asks, the logic
  // decides, and the fresh state is pushed back.
  onSystemMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'place' && Number.isInteger(msg.ring)) {
      const res = Logic.placePlanet(this.state, msg.ring, msg.seed, msg.generation);
      if (res.ok) { this.saveNow(); this.pushState(); }
    } else if (msg.type === 'remove' && Number.isInteger(msg.ring)) {
      const res = Logic.removeFromSystem(this.state, msg.ring);
      if (res.ok) { this.saveNow(); this.pushState(); }
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
  // its eligibility, the fed mineral (consumed by the offspring), the
  // inheritance multipliers, and the last fusion result (if any).
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
      inheritOne: Logic.CONFIG.PRESTIGE_INHERIT_MULT_ONE,
      inheritBoth: Logic.CONFIG.PRESTIGE_INHERIT_MULT_BOTH,
      consumesParents: Logic.CONFIG.PRESTIGE_CONSUMES_PARENTS,
      fedMineral: this.state.fedMineral ? Logic.mineralName(this.state.fedMineral) : null,
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
  // filename and the README markdown from petLogic.js.
  shareViewModel() {
    const p = this.renderablePlanet(this.state.current, 'current');
    const filename = Logic.shareCardFilename(p.name, p.generation);
    return { type: 'share', ...p, filename, markdown: Logic.shareCardMarkdown(p, filename) };
  }

  postShareState() {
    if (this.sharePanel) this.sharePanel.webview.postMessage(this.shareViewModel());
  }

  // Messages from the panel: copy the seed / markdown to the
  // clipboard, or save the PNG the panel drew on its canvas. The
  // panel never touches the clipboard or the disk itself — it asks,
  // the host decides. A cancelled save dialog is silent (no popup).
  async onShareMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'copySeed' && this.state.current) {
      await vscode.env.clipboard.writeText(String(this.state.current.seed));
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
      stageStart: info.stageStart,
      xp: cur.xp,
      nextXp: info.nextXp, // null at Civilization: no next stage
      isMax: info.isMax, // fully evolved (Civilization+) — orange XP bar
      chars: cur.chars,
      generation: this.state.generation,
      summary: cur.summary,
      // Step 2: the mineral inventory for the webview's meta line.
      minerals: Logic.mineralSummary(this.state),
    };
  }

  pushState() {
    const vm = this.viewModel();
    if (vm) {
      // viewModel() already computed the stage info — reuse it.
      // The mutation tag rides along in the status bar too, so a rare
      // planet is unmissable even with the sidebar closed. The mineral
      // count rides along as well (◆N), so the inventory is visible
      // at a glance without opening the panel.
      // Maxed (Civilization+): "· MAX" instead of a next threshold —
      // past Civilization there is no next stage, and the bar is orange.
      this.statusBar.text = `$(globe) ${vm.stageName} · ${vm.xp}${vm.nextXp === null ? '' : '/' + vm.nextXp} XP${vm.isMax ? ' · MAX' : ''}`
        + (vm.mutationLabel ? ` · ${vm.mutationLabel}` : '')
        + (vm.minerals && vm.minerals.total > 0 ? ` · ◆${vm.minerals.total}` : '');
    } else {
      this.statusBar.text = '$(globe) Protoplanet — hatching…';
    }
    this.viewProvider.postState(vm);
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
  #wrap { background: #2b2b2b; border: 1px solid #3d3d3d; border-radius: 10px; padding: 8px; overflow: hidden; }
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
  const root = document.documentElement;
  const FONT_STACK = ${JSON.stringify(FONT_STACK)};
  let cellW = 3, cellH = 5.4, state = null, sec = 0, stageStartSec = 0, lastStage = -1, lastCrop = null, lastDims = null, lastLayoutAt = -1e9, layoutPending = false;

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
    if (!msg || msg.type !== 'state') return;
    // The birth morph (Devon, Nov 12 — round 3): it replays ONLY on a
    // real birth or level-up, never on webview load. The old line reset
    // stageStartSec on the first state, so every sidebar open replayed
    // the 3s birth — and at t=0 the planet renders at the previous
    // (Civilization) stage's radius 28.5 with a full ring, so the
    // double ring spans the whole 136-col grid (Devon's "huge ring",
    // like the black-hole onboarding), then condenses over 3s. A planet
    // at 79/100 XP has been in this stage for days; opening the
    // sidebar must show it settled. A brand-new planet (0 chars) still
    // gets its birth on first sight; a new planet (seed changed) or a
    // level-up while the sidebar is live replays it too.
    if (!state) {
      stageStartSec = msg.chars === 0 ? sec : sec - 10; // settled unless newborn
    } else if ((msg.planet && state.planet && msg.planet.seed !== state.planet.seed) || msg.stageIdx !== lastStage) {
      stageStartSec = sec;
    }
    lastStage = msg.stageIdx;
    state = msg;
    document.getElementById('stageName').textContent =
      'Stage ' + (msg.stageIdx + 1) + '/7 \\u00b7 ' + msg.stageName +
      (msg.generation > 1 ? ' \\u00b7 Gen ' + msg.generation : '');
    const mutEl = document.getElementById('mutationLabel');
    if (msg.mutationLabel) { mutEl.textContent = msg.mutationLabel; mutEl.style.display = 'inline-block'; }
    else { mutEl.style.display = 'none'; }
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
    const span = msg.nextXp === null ? 1 : Math.max(1, msg.nextXp - msg.stageStart);
    const pct = msg.nextXp === null ? 100 : Math.max(0, Math.min(100, (msg.xp - msg.stageStart) / span * 100));
    fillEl.style.width = pct.toFixed(1) + '%';
    labelEl.textContent = msg.nextXp === null
      ? 'XP ' + msg.xp + ' \\u00b7 MAX \\u2014 fully evolved'
      : 'XP ' + msg.xp + ' / ' + msg.nextXp;
    document.getElementById('meta').textContent = 'Grown from ' + msg.chars + ' characters';
    layout(); // text heights changed — re-fit the grid to the view height
  });

  // Animate: ~7 fps is plenty for the flicker/drift illusion.
  setInterval(() => {
    sec += 0.15;
    if (!state) return;
    const t = Math.max(0, sec - stageStartSec);
    // Crop to the planet's own extent and render it star-free, so the
    // pet floats big on the VS Code gray instead of sitting small in
    // a black starfield box (Devon, Nov 12 — F5 feedback). The crop
    // only changes when the stage (or morph) changes, so layout()
    // re-runs when it does — never every tick.
    const crop = P.sidebarCrop(state.planet, state.stageIdx, t);
    if (!lastCrop || crop.cols !== lastCrop.cols || crop.rows !== lastCrop.rows) {
      lastCrop = crop;
      layoutPending = true;
    }
    // Debounced layout (round 3): during the 3s birth morph the crop
    // changes ~every tick, and each layout() forces a synchronous
    // layout (getComputedStyle + offsetHeight reads) on top of the
    // render. Re-fit at most every 0.5s, plus once when the morph
    // settles (t >= 3) so the final size is exact. The grid keeps
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
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
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
  /* The orrery takes up the whole screen below the top line — the
     panel never scrolls to a second section anymore. The Index is
     its own mode, reached from the tabs above. */
  #orreryWrap { position: relative; height: calc(100vh - 37px);
    overflow: hidden; background: #050505; }
  #orrery { position: absolute; inset: 0; overflow: hidden; cursor: grab; }
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
  #detailArt { background: #050505; border: 1px solid #222; padding: 4px; overflow-x: auto; margin-bottom: 10px; }
  #detail .mut { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: #ffd75f; background: transparent;
    border: 1px solid rgba(255, 215, 95, 0.55); padding: 2px 7px; margin: 0 0 8px; }
  #detail table { font-size: 12px; border-collapse: collapse; margin: 0 0 12px; }
  #detail td { padding: 2px 10px 2px 0; vertical-align: top; }
  #detail td.k { opacity: .6; white-space: nowrap; }
  #detail .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  #detail .note { font-size: 11px; opacity: .65; margin: 8px 0 0; line-height: 1.5; }
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
  .tile { background: #050505; padding: 14px 14px 12px; cursor: pointer; border-bottom: 1px solid #1e1e1e; border-right: 1px solid #1e1e1e; }
  .tile:hover { background: #0a0a0a; }
  .tile .art { display: flex; justify-content: center; background: #050505; margin-bottom: 10px; overflow: hidden; }
  .tile .tname { font-size: 13px; font-weight: 600; }
  .tile .tmeta { font-size: 11px; opacity: .7; line-height: 1.5; margin-top: 2px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; padding: 1px 6px; margin: 4px 4px 0 0; }
  .badge.sys, .badge.cur { color: #ffd75f; border: 1px solid rgba(255, 215, 95, 0.5); }
  .badge.mut { color: #ffd75f; border: 1px solid rgba(255, 215, 95, 0.55); }
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
  </div>
  <button id="hideUiBtn" class="ghost" title="Hide the interface (H)">Hide UI</button>
</header>
<div id="orreryWrap">
  <div id="orrery"><div id="world"></div></div>
  <div id="bottomStrip">
    <button id="zoomOut" title="Zoom out">&minus;</button>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="fitBtn" title="Fit the whole system">Fit</button>
    <span>Drag to pan &middot; Ctrl+Scroll to zoom &middot; Click a planet to zoom in &middot; H hides the UI</span>
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
      <option value="name">Name A&ndash;Z</option>
      <option value="terrain">Terrain</option>
    </select>
  </div>
  <div id="tiles"></div>
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
  // --- modes: Orrery <-> Index ----------------------------------------------
  // Two full screens, not one crowded one (Devon, Nov 12 — the research's
  // strongest pattern): each mode gets 100% of the panel, so neither the
  // orrery nor the collection has to shrink for the other.
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    document.body.classList.toggle('mode-index', m === 'index');
    document.getElementById('tabOrrery').classList.toggle('active', m === 'orrery');
    document.getElementById('tabIndex').classList.toggle('active', m === 'index');
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
  }
  document.getElementById('tabOrrery').addEventListener('click', function () { setMode('orrery'); });
  document.getElementById('tabIndex').addEventListener('click', function () { setMode('index'); });
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
    discCols = detail.cols; discRows = detail.rows;
    for (var k = 0; k < discs.length; k++) {
      var d = discs[k];
      var gridEl = d.el.querySelector('.pp-grid');
      if (gridEl) {
        var discZoom = Math.min(P.stageScale(d.planet.stageIdx),
          P.ringFitZoom(d.planet.planet, d.planet.stageIdx, detail.cols, detail.rows));
        // The zoomed-in disc (Devon, Nov 12 — round 2, generalized
        // round 3): the full-grid disc keeps the planet small even at
        // 3x — stage 0's body is 18% of the grid, ~66px in a 359px
        // box. A disc at high zoom renders CROPPED to the planet +
        // its whole ring system and 1.4x bigger than its world
        // footprint, so the zoomed planet fills the view with readable
        // glyphs instead of sitting small in a big empty box — the
        // same full planet the detail sheet shows. Round 2 this was
        // selected-disc-only; round 3 it applies to ANY disc at 2x+,
        // because a wheel-zoomed disc had the same half-detail gap
        // vs its sheet. Same cost as the cozy path: both render the
        // full grid once per disc per tick; the crop skips the
        // downsample instead of adding work.
        var isSel = zoomed && selected && selected.seed === d.planet.seed && selected.generation === d.planet.generation;
        if (zoom >= 2 || isSel) {
          var zcrop = P.sidebarCrop(d.planet.planet, d.planet.stageIdx, 10, 2.5);
          var zCellW = (detail.cols * detail.cellW * 1.4) / zcrop.cols;
          var zCellH = zCellW * 1.8;
          gridEl.style.setProperty('--pp-fs', cellFont(zCellW, zCellH) + 'px');
          gridEl.style.setProperty('--pp-ch', zCellH.toFixed(2) + 'px');
          gridEl.innerHTML = P.gridToHtml(
            P.cropGrid(P.render(d.planet.planet, d.planet.stageIdx, 10, sec, discZoom, undefined, 0.5, true), zcrop), zCellW, zCellH);
          continue;
        }
        // The cell size is constant now (the counter-scale handles
        // the zoom), but keep the font-size vars in sync anyway.
        gridEl.style.setProperty('--pp-fs', cellFont(detail.cellW, detail.cellH) + 'px');
        gridEl.style.setProperty('--pp-ch', detail.cellH + 'px');
        gridEl.innerHTML = P.gridToHtml(
          // smokeScale 0.5 (Devon, Nov 12): stage-0 smoke stays close
          // to the core in the system view instead of filling the frame.
          P.renderCozy(d.planet.planet, d.planet.stageIdx, 10, sec, discZoom, detail.cols, detail.rows, undefined, 0.5, true), detail.cellW, detail.cellH);
      }
    }
  }

  // The disc's detail follows the camera zoom directly (continuous,
  // not stepped): the on-screen size is the world size times the
  // zoom, so the resolution is discDetail(zoom). refreshDiscDetail
  // re-renders only when the computed grid size actually changed by
  // >= 1 cell — the tick re-renders the discs every 450ms anyway, so
  // this is just the prompt path after a zoom gesture.
  var discCols = 0, discRows = 0;
  function discDetailNow() {
    return P.discDetail(zoom);
  }
  function refreshDiscDetail() {
    var d = discDetailNow();
    if (d.cols !== discCols || d.rows !== discRows) renderDiscs();
  }

  // --- detail sheet + zoom-to-planet -----------------------------------------
  // Click a planet and the camera zooms into it — the details show
  // beside the zoomed planet, not in a modal over the system (Devon,
  // Nov 12 — the old panel covered the orrery). X / Esc zooms back
  // out to the view you had. In Index mode there is no camera to
  // move, so the sheet just appears.
  function openDetail(planet) {
    selected = { seed: planet.seed, generation: planet.generation };
    detailOpen = true;
    renderDetail();
    renderOrrerySel();
    if (mode === 'orrery') zoomToPlanet(planet);
  }
  function closeDetail() {
    if (zoomed) unzoom();
    selected = null;
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
    var html = '<button id="detailClose" class="ghost" data-action="close" title="Close">&times;</button>'
      + '<h2>' + esc(planet.name) + '</h2>'
      + '<p class="sub">' + esc(planet.summary) + ' &middot; Seed ' + planet.seed + '</p>'
      + (planet.mutationLabel ? '<div class="mut">' + esc(planet.mutationLabel) + '</div>' : '')
      + '<div id="detailArt" class="pp-frame" data-cw="4" data-ch="7.2" data-atmo="' + planet.planet.atmosphere + '"><div class="pp-stars"></div><div class="pp-planet"><div class="pp-grid"></div></div></div>'
      + '<table>'
      + '<tr><td class="k">Terrain</td><td>' + esc(planet.terrainLabel) + '</td></tr>'
      + '<tr><td class="k">Stage</td><td>' + esc(planet.stageName) + (planet.kind === 'current' ? ' &middot; growing now' : '') + '</td></tr>'
      + '<tr><td class="k">Grown from</td><td>' + planet.chars + ' characters</td></tr>'
      + '<tr><td class="k">Generation</td><td>Gen ' + planet.generation + '</td></tr>'
      + (planet.parents ? '<tr><td class="k">Parents</td><td>' + esc(planet.parents.map(function (p) { return p.name || ('Seed ' + p.seed); }).join(' + ')) + '</td></tr>' : '')
      + (planet.usedAsParent ? '<tr><td class="k">Prestige</td><td>Already a parent</td></tr>' : '')
      + '</table>'
      + '<div class="actions">';
    if (ring >= 0) {
      html += '<button data-action="remove" data-ring="' + ring + '">Remove from system</button>'
        + '<button class="ghost" data-action="replace" data-ring="' + ring + '">Replace&hellip;</button>';
    } else if (emptyRing >= 0) {
      html += '<button data-action="place" data-ring="' + emptyRing + '">Place in system (Ring ' + (emptyRing + 1) + ')</button>';
    } else {
      html += '<button disabled>No empty rings</button>';
    }
    html += '</div>';
    if (ring < 0 && emptyRing < 0 && state.nextAt !== null) {
      html += '<p class="note">No empty rings — grow ' + state.toNext + ' more planet' + (state.toNext === 1 ? '' : 's') + ' to unlock Ring ' + (state.totalSlots + 1) + '.</p>';
    }
    if (ring >= 0) {
      html += '<p class="note">Removing a planet from the system never deletes it — it stays in the Index.</p>';
    }
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
      state.index.map(function (p) { return p.seed + ':' + p.generation; }),
      state.slots.map(function (s) { return s.planet ? s.planet.seed + ':' + s.planet.generation : ''; }),
      cur,
    ]);
  }
  function filteredIndex() {
    var q = searchText.trim().toLowerCase();
    var list = state.index.filter(function (p) {
      if (!q) return true;
      var hay = (p.name + ' ' + p.terrainLabel + ' ' + p.seed + ' ' + (p.mutationLabel || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      if (sortMode === 'newest') return (b.archivedAt || Infinity) - (a.archivedAt || Infinity);
      if (sortMode === 'oldest') return (a.archivedAt || 0) - (b.archivedAt || 0);
      if (sortMode === 'most') return b.chars - a.chars;
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
  function renderIndex() {
    if (!state) return;
    var list = filteredIndex();
    if (pickerRing !== null) list = list.filter(function (p) { return slotOf(p.seed, p.generation) < 0; });
    document.getElementById('indexCount').textContent =
      state.totalPlanets + ' planet' + (state.totalPlanets === 1 ? '' : 's') + ' — ' + state.ringsUsed + ' in system';
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
      html += '<div class="tile' + (inSys ? ' inSystem' : '') + (pickerRing !== null ? ' picking' : '') + '"'
        + ' data-seed="' + p.seed + '" data-gen="' + p.generation + '">'
        + '<div class="art"><div class="pp-grid"></div></div>'
        + '<div class="tname">' + esc(p.name) + '</div>'
        + '<div class="tmeta">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName) + ' &middot; ' + p.chars + ' chars &middot; Gen ' + p.generation + '</div>'
        + (inSys ? '<span class="badge sys">In system</span>' : '')
        + (p.kind === 'current' ? '<span class="badge cur">Growing now</span>' : '')
        // The mutation badge keeps its full label ("MUTATION · Glitch")
        // — the bare name alone read like a life indicator
        // (Devon, Nov 11). The stage in the meta line above is what
        // says whether it has life / cities.
        + (p.mutationLabel ? '<span class="badge mut">' + esc(p.mutationLabel) + '</span>' : '')
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
  function fillTileArt(list) {
    var artW = tileArtWidth();
    var arts = tilesEl.querySelectorAll('.tile .art');
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var artEl = arts[i];
      if (!artEl) continue;
      var gridEl = artEl.querySelector('.pp-grid');
      if (!gridEl) continue;
      var crop = P.sidebarCrop(p.planet, p.stageIdx, 10);
      var cellW = artW / crop.cols;
      var cellH = cellW * 1.8;
      gridEl.style.setProperty('--pp-fs', cellFont(cellW, cellH) + 'px');
      gridEl.style.setProperty('--pp-ch', cellH.toFixed(2) + 'px');
      gridEl.innerHTML = P.gridToHtml(
        P.cropGrid(P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), undefined, 0.5, true), crop), cellW, cellH);
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
  var panning = null, dragged = false, suppressClick = false;
  orreryEl.addEventListener('pointerdown', function (e) {
    panning = { x: e.clientX, y: e.clientY, panX: panX, panY: panY };
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
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    if (dragged) {
      panX = panning.panX + dx;
      panY = panning.panY + dy;
      applyTransform();
    }
  });
  window.addEventListener('pointerup', function () {
    orreryEl.classList.remove('panning');
    if (panning && dragged) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
    }
    panning = null;
  });
  orreryEl.addEventListener('wheel', function (e) {
    // Ctrl+scroll (Cmd+scroll on Mac) zooms. A plain scroll does
    // nothing — the panel is one viewport now (the Index is its own
    // mode, reached from the tabs), so there is no page to scroll.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Round 3: cap 6x (was 3x) — discDetail needs 5.91x for the full
    // 136 cols, and 3x only ever reached 69.
    zoom = Math.max(0.3, Math.min(6, zoom * Math.exp(-e.deltaY * 0.001)));
    applyTransform();
    scheduleZoomRefresh();
  }, { passive: false });

  // --- clicks (delegated; suppressed right after a drag-pan) ----------------
  worldEl.addEventListener('click', function (e) {
    if (suppressClick) return;
    var disc = e.target.closest ? e.target.closest('.disc') : null;
    if (disc) {
      var planet = findPlanet(+disc.getAttribute('data-seed'), +disc.getAttribute('data-gen'));
      if (planet) openDetail(planet);
      return;
    }
    var hit = e.target.closest ? e.target.closest('.ringHit') : null;
    if (hit) {
      // Clicks on the star itself do not place a planet — the star
      // sits inside the innermost ring's hit area, so guard it: the
      // star's visible sphere is the middle half of its element box.
      var starEl = worldEl.querySelector('.star');
      if (starEl) {
        var sr = starEl.getBoundingClientRect();
        var scx = sr.left + sr.width / 2, scy = sr.top + sr.height / 2;
        var srx = sr.width / 4, sry = sr.height / 4;
        var dx = (e.clientX - scx) / srx, dy = (e.clientY - scy) / sry;
        if (dx * dx + dy * dy < 1) return;
      }
      startPicker(+hit.getAttribute('data-ring'));
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
  worldEl.addEventListener('mouseover', function (e) {
    if (e.target.closest && e.target.closest('.disc')) hoverPlanet = true;
    var hit = e.target.closest ? e.target.closest('.ringHit') : null;
    if (hit) setRingHot(+hit.getAttribute('data-ring'), true);
  });
  worldEl.addEventListener('mouseout', function (e) {
    if (e.target.closest && e.target.closest('.disc')) hoverPlanet = false;
    var hit = e.target.closest ? e.target.closest('.ringHit') : null;
    if (hit && !(e.relatedTarget && hit.contains(e.relatedTarget))) setRingHot(+hit.getAttribute('data-ring'), false);
  });
  detailEl.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!t || !selected) return;
    var action = t.getAttribute('data-action');
    if (action === 'close') { closeDetail(); return; }
    if (action === 'remove') {
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
    renderDiscs();
    renderStar(); // the sun churns + flares ~7x/sec now — never frozen while the planets orbit. Outside the hover/detail guard on purpose: hovering a planet shouldn't freeze the sun.
    // The sheet's art re-renders every tick while it is open, so the
    // zoomed planet keeps shimmering — the drift itself is paused.
    if (detailOpen && selected) fillDetailArt();
  }, 150);

  // --- state from the extension --------------------------------------------------
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'system') return;
    state = msg;
    updateRankLine();
    var sig = indexSignature();
    if (sig !== lastSig) {
      lastSig = sig;
      renderOrrery();
      renderIndex();
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
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
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
  .slotArt { background: #050505; border: 1px solid #1e1e1e; padding: 4px; overflow-x: auto; margin-bottom: 8px; }
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
  #collisionArt { background: #050505; overflow-x: auto; display: inline-block; }
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
  .card .thumb { background: #050505; border: 1px solid #1e1e1e; margin-bottom: 8px; overflow: hidden; }
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
    return '<div class="slotTag">' + esc(tag) + '</div>'
      + '<h3>' + esc(p.name) + '</h3>'
      + '<p class="sub">' + esc(p.summary) + ' &middot; Seed ' + p.seed + '</p>'
      + (p.mutationLabel ? '<div class="mut">' + esc(p.mutationLabel) + '</div>' : '')
      + '<div class="slotArt pp-frame" data-cw="2.2" data-ch="3.96" data-atmo="' + p.planet.atmosphere + '"><div class="pp-stars"></div><div class="pp-planet"><div class="pp-grid" style="--pp-fs:3.96px;--pp-ch:3.96px">' + art + '</div></div></div>'
      + '<div class="sub">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName)
      + ' &middot; ' + p.chars + ' characters &middot; Gen ' + p.generation + '</div>';
  }
  function renderSlots() {
    if (pickA) {
      slotAEl.className = 'parentSlot picked';
      slotAEl.innerHTML = slotHtml(pickA, 'Parent A');
    } else {
      slotAEl.className = 'parentSlot empty';
      slotAEl.innerHTML = '<div><b>Parent A</b><br>Pick a planet below.</div>';
    }
    if (pickB) {
      slotBEl.className = 'parentSlot picked';
      slotBEl.innerHTML = slotHtml(pickB, 'Parent B');
    } else {
      slotBEl.className = 'parentSlot empty';
      slotBEl.innerHTML = '<div><b>Parent B</b><br>Pick a planet below.</div>';
    }
    document.getElementById('fusionHint').innerHTML =
      (pickA && pickB) ? 'Two worlds, ready.<br>Both stay — retired, never parents again.'
      : 'Pick two parents below —<br>then fuse them.';
  }
  function refreshSlotArt() {
    // The slot now holds TWO .pp-grid layers (the starfield + the
    // planet) — target the planet layer, never the stars.
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
      order.forEach(function (id) {
        var def = P.mutationDef(id);
        var name = def ? def.name : id;
        var both = counts[id] >= 2;
        html += '<div class="row">◆ ' + esc(name) + ' — '
          + (both ? 'both parents carry it' : 'one parent carries it')
          + ' &middot; <span class="boost">~' + (both ? state.inheritBoth : state.inheritOne) + '× odds</span></div>';
      });
      html += '<div class="row" style="opacity:.65">Anything else can still appear at its usual rare odds.</div>';
    }
    if (state.fedMineral) {
      html += '<div class="row fed">Fed: ' + esc(state.fedMineral)
        + ' — it will tilt the offspring’s birth roll too, then it’s consumed.</div>';
    }
    inheritBarEl.innerHTML = html;
  }
  function renderConfirm() {
    if (!pickA || !pickB || fusing || (state && state.result)) { confirmBarEl.hidden = true; return; }
    confirmBarEl.hidden = false;
    if (!confirmOpen) {
      confirmBarEl.innerHTML = '<button id="fuseBtn" class="big">Fuse ' + esc(pickA.name) + ' + ' + esc(pickB.name) + '</button>'
        + '<span class="warn">The offspring starts as dust. The parents stay in your collection, but they can’t be parents again.</span>';
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
      + '<p class="sub">' + esc(off.summary) + ' &middot; Seed ' + off.seed + ' &middot; Gen ' + off.generation + '</p>'
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
      html += '<div class="card' + (!p.eligible ? ' dim' : '') + (picked ? (tag === 'Parent A' ? ' pickedA' : ' pickedB') : '') + '"'
        + ' data-seed="' + p.seed + '" data-gen="' + p.generation + '">'
        + '<div class="thumb pp-frame" data-cw="3.4" data-ch="6.12" data-atmo="' + p.planet.atmosphere + '"><div class="pp-stars"></div><div class="pp-planet"><div class="pp-grid" style="--pp-fs:6.12px;--pp-ch:6.12px">' + thumb + '</div></div></div>'
        + '<div class="cname">' + esc(p.name) + '</div>'
        + '<div class="cmeta">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName) + ' &middot; ' + p.chars + ' chars &middot; Gen ' + p.generation + '</div>'
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
  function togglePick(p) {
    if (!p.eligible) return;
    var k = pickKey(p);
    if (pickA && pickKey(pickA) === k) pickA = null;
    else if (pickB && pickKey(pickB) === k) pickB = null;
    else if (!pickA) pickA = p;
    else if (!pickB) pickB = p;
    else pickB = p; // both full: replace B
    confirmOpen = false;
    lastError = '';
    renderAll();
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
      refreshSlotArt();
      refreshResultArt();
      refreshStarfields();
    }
  }, 150);

  // --- state from the extension --------------------------------------------------
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'prestige') return;
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
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
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
      state.stageName + ' \\u00b7 Gen ' + state.generation + ' \\u00b7 grown from ' + state.chars + ' characters';
    document.getElementById('seedText').textContent = state.seed;
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
    ctx.fillText(state.name + ' \\u00b7 seed ' + state.seed,
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
    // Nothing to send until the first planet hatches — the webview
    // shows its placeholder text until then.
    if (this.view && viewModel) this.view.webview.postMessage(viewModel);
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
