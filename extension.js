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
    // triggered on every stage change / rebirth / new planet.
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
    // Stage changes and rebirths save immediately; plain typing is
    // debounced so we don't write to disk on every keystroke.
    this.scheduleSave(res.stageChanged || res.rebirthed);
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
  // screen, and the Archive (Pokédex) lives below it in the same
  // scroll. The panel is a dumb view of the state — every decision
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
      traits = Planet.generatePlanet(record.seed);
      traits.mutations = (record.mutations || []).slice();
    }
    // Display stage: CAPPED at Civilization (never End) — archived
    // planets sit at 3600 chars = End, which renders as dispersing
    // noise, so the panels show them at their best stage instead
    // (Devon, Nov 11). The lifecycle still has End; this is only
    // what the panels show.
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
    // the orrery; the Archive header shows the full ladder instead.
    for (let i = rank.totalSlots; i < Math.min(rank.totalSlots + 2, Logic.CONFIG.SYSTEM_MAX_RINGS); i++) {
      if (rank.nextAt === null) break;
      slots.push({
        index: i,
        unlocked: false,
        unlockLabel: Logic.lockedRingLabel(this.state, i),
        planet: null,
      });
    }
    const archive = this.state.past.map((p) => renderable(p, 'past'));
    if (this.state.current) archive.push(renderable(this.state.current, 'current'));
    return {
      type: 'system',
      rank: rank.rank,
      finished: rank.finished,
      totalSlots: rank.totalSlots,
      nextAt: rank.nextAt,
      toNext: rank.toNext,
      ringsUsed,
      totalPlanets: archive.length,
      slots,
      archive,
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
      nextXp: info.nextXp,
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
      this.statusBar.text = `$(globe) ${vm.stageName} · ${vm.xp}/${vm.nextXp} XP`
        + (vm.mutationLabel ? ` · ${vm.mutationLabel}` : '')
        + (vm.minerals && vm.minerals.total > 0 ? ` · ◆${vm.minerals.total}` : '');
    } else {
      this.statusBar.text = '$(globe) Protoplanet — hatching…';
    }
    this.viewProvider.postState(vm);
    // The Solar System panel gets the same push (its own view model)
    // — typing never opens it, but a rebirth while it is open must
    // show the new planet in the Archive right away.
    this.postSystemState();
    // Same for the Prestige panel — typing can make the current
    // planet eligible, and a fusion from the palette must show up
    // there too.
    this.postPrestigeState();
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
  body { margin: 0; padding: 10px; background: transparent;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family); }
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
  #xpfill { height: 100%; background: #e8b64c; width: 0%; }
  #xplabel { font-size: 11px; color: #e8b64c; opacity: .9; margin: 4px 0 6px; }
  #meta { font-size: 11px; opacity: .7; margin-top: 6px; line-height: 1.5; }
</style>
</head>
<body>
<div id="wrap"><pre class="pp-grid" id="grid"></pre></div>
<div id="stageName">Your planet is hatching&hellip;</div>
<div id="mutationLabel" style="display:none"></div>
<p id="stageDesc">Pick a starter and start typing &mdash; every character grows it.</p>
<div id="xpbar"><div id="xpfill"></div></div>
<div id="xplabel">XP 0 / 100</div>
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
  let cellW = 3, cellH = 5.4, state = null, sec = 0, stageStartSec = 0, lastStage = -1;

  // --- Fixed-cell layout (same approach as preview.html) ------------------
  // The sidebar is narrow, so cells scale down to fit the width — the
  // 10:18 ratio never changes. The font size is measured from the real
  // monospace font at runtime, so one glyph advance == one cell width.
  // At sidebar width the glyphs are tiny, but the planet's shape,
  // colors, rings and motion still read. (A full-size view is piece 4.)
  function layout() {
    const avail = Math.max(50, wrapEl.clientWidth - 12);
    const scale = avail / (P.CONFIG.W * P.CONFIG.CELL_W); // full scale = grid width in px
    const newW = Math.max(1, +(10 * scale).toFixed(2));
    const newH = Math.max(1.8, +(18 * scale).toFixed(2));
    if (newW === cellW && newH === cellH && root.style.getPropertyValue('--pp-fs')) return;
    cellW = newW; cellH = newH;
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
  layout();
  window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'state') return;
    if (!state || msg.stageIdx !== lastStage) stageStartSec = sec; // morph replays
    lastStage = msg.stageIdx;
    state = msg;
    document.getElementById('stageName').textContent =
      'Stage ' + (msg.stageIdx + 1) + '/8 \\u00b7 ' + msg.stageName +
      (msg.generation > 1 ? ' \\u00b7 Gen ' + msg.generation : '');
    const mutEl = document.getElementById('mutationLabel');
    if (msg.mutationLabel) { mutEl.textContent = msg.mutationLabel; mutEl.style.display = 'inline-block'; }
    else { mutEl.style.display = 'none'; }
    // No flavor text in the sidebar (Devon, Nov 11): the stage
    // description and the world details (terrain, ring, moons, seed,
    // minerals) live in the detail panel / Pokedex. The sidebar keeps
    // the stage line, the grown-from line, and the XP bar only. The
    // pre-hatch guidance above stays until the first state arrives.
    document.getElementById('stageDesc').style.display = 'none';
    const span = Math.max(1, msg.nextXp - msg.stageStart);
    const pct = Math.max(0, Math.min(100, (msg.xp - msg.stageStart) / span * 100));
    document.getElementById('xpfill').style.width = pct.toFixed(1) + '%';
    document.getElementById('xplabel').textContent = 'XP ' + msg.xp + ' / ' + msg.nextXp;
    document.getElementById('meta').textContent = 'Grown from ' + msg.chars + ' characters';
  });

  // Animate: ~7 fps is plenty for the flicker/drift illusion.
  setInterval(() => {
    sec += 0.15;
    if (!state) return;
    const t = Math.max(0, sec - stageStartSec);
    gridEl.innerHTML = P.gridToHtml(P.render(state.planet, state.stageIdx, t, sec), cellW, cellH);
  }, 150);

  vscodeApi.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
  // -- step 4: the Solar System panel HTML -----------------------------------
  // Full-screen orrery on top (tilted view: the orbit rings are
  // ellipses seen at an angle, the planet discs stay upright facing
  // you — Stellaris-style, not a top-down tabletop and not a side
  // view that squashes the orbits into a line), the Archive below in
  // the same scroll. Same fixed-cell rendering rule as the sidebar
  // (gridToHtml + explicit cell sizes, 10:18 ratio, never a bare
  // <pre>). The panel never pops anything up — it only posts place /
  // remove messages, and the extension decides.
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
    font-family: var(--vscode-font-family); }
  /* Fixed-size cells — same rule as the sidebar (see getWebviewHtml). */
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
    -webkit-text-size-adjust: none; text-size-adjust: none; }
  .pp-run { display: inline-block; height: var(--pp-ch, 18px);
    line-height: var(--pp-ch, 18px); vertical-align: top; overflow: hidden;
    white-space: pre; font-kerning: none; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 5px 11px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button.ghost { background: transparent; border: 1px solid var(--vscode-widget-border, #444);
    color: var(--vscode-editor-foreground); }
  #topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--vscode-widget-border, #222);
    background: #080808; position: sticky; top: 0; z-index: 10; }
  #topbar h1 { font-size: 15px; margin: 0 0 2px; }
    background: #080808; position: sticky; top: 0; z-index: 10; }
  #topbar h1 { font-size: 15px; margin: 0 0 2px; }
  #rankLine { font-size: 12px; opacity: .75; }
  #controls { display: flex; gap: 6px; align-items: center; }
  /* The orrery takes up the screen: ~a full viewport tall, then you
     scroll down to the Archive in the same view. */
  #orreryWrap { position: relative; height: calc(100vh - 58px); min-height: 480px;
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
     clickable to open the Archive picker. No persistent glyph — only
     a faint gold outline on hover (Devon, Nov 11). */
  .ringHit { position: absolute; border-radius: 50%; cursor: pointer;
    border: 1px solid transparent; background: transparent; }
  .ringHit:hover { border-color: rgba(232, 182, 76, 0.45); }
  .lockLabel { position: absolute; transform: translate(-50%, -50%); font-size: 11px;
    color: rgba(255, 255, 255, 0.6); background: rgba(0, 0, 0, 0.65); padding: 3px 9px;
    border-radius: 10px; border: 1px dashed rgba(255, 255, 255, 0.3); white-space: nowrap; }
  .disc { position: absolute; transform: translate(-50%, -50%); cursor: pointer; }
  .disc:hover { outline: 1px solid rgba(232, 182, 76, 0.7); outline-offset: 2px; border-radius: 4px; }
  .disc.sel { outline: 1px solid #e8b64c; outline-offset: 2px; border-radius: 4px; }
  .star { position: absolute; transform: translate(-50%, -50%); text-align: center; }
  .starName { font-size: 11px; color: #ffd75f; text-shadow: 0 1px 3px #000; margin-top: 1px; }
  #orreryHint { position: absolute; left: 16px; bottom: 12px; font-size: 11px; opacity: .55;
    pointer-events: none; z-index: 4; }
  /* Detail modal on one side of the orrery. */
  #detail { position: absolute; right: 14px; top: 14px; width: 360px;
    max-height: calc(100% - 28px); overflow-y: auto; z-index: 5;
    background: rgba(8, 8, 8, 0.95); border: 1px solid #3a3a3a; border-radius: 8px; padding: 14px; }
  #detail h2 { font-size: 16px; margin: 0 0 2px; }
  #detail .sub { font-size: 12px; opacity: .75; margin: 0 0 10px; line-height: 1.5; }
  #detailArt { background: #050505; border: 1px solid #222; padding: 4px; overflow-x: auto; margin-bottom: 10px; }
  #detail .mut { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: #ffd75f; background: rgba(255, 215, 95, .12);
    border: 1px solid rgba(255, 215, 95, 0.55); border-radius: 3px; padding: 2px 7px; margin: 0 0 8px; }
  #detail table { font-size: 12px; border-collapse: collapse; margin: 0 0 12px; }
  #detail td { padding: 2px 10px 2px 0; vertical-align: top; }
  #detail td.k { opacity: .6; white-space: nowrap; }
  #detail .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  #detail .note { font-size: 11px; opacity: .65; margin: 8px 0 0; line-height: 1.5; }
  #detailClose { position: absolute; top: 8px; right: 8px; padding: 2px 8px; }
  /* Picker banner (choosing a planet for a ring). */
  #pickerBanner { position: sticky; top: 58px; z-index: 9; background: #1a1405;
    border-bottom: 1px solid #e8b64c; color: #ffd75f; padding: 9px 16px; font-size: 12px;
    display: flex; gap: 12px; align-items: center; }
  /* The Archive — the Pokédex below the orrery. */
  #archive { padding: 20px 22px 48px; background: #070707; border-top: 1px solid #222; }
  #archive h2 { font-size: 15px; margin: 0 0 4px; }
  #archiveCount { font-size: 12px; opacity: .75; margin: 0 0 12px; }
  #archiveBar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  #search { flex: 1; min-width: 180px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #333);
    border-radius: 4px; padding: 6px 9px; font-size: 12px; font-family: inherit; }
  #sort { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #333); border-radius: 4px; padding: 6px; font-size: 12px; }
  #cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 12px; }
  .card { background: #0b0b0b; border: 1px solid #262626; border-radius: 8px; padding: 10px;
    cursor: pointer; }
  .card:hover { border-color: #555; }
  .card.inSystem { border-color: #e8b64c; }
  .card.picking { border-color: #ffd75f; }
  .card .thumb { background: #050505; border: 1px solid #1c1c1c; margin-bottom: 8px; overflow: hidden; }
  .card .cname { font-size: 13px; font-weight: 600; }
  .card .cmeta { font-size: 11px; opacity: .7; line-height: 1.5; margin-top: 2px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; border-radius: 3px; padding: 1px 6px; margin: 4px 4px 0 0; }
  .badge.sys { color: #ffd75f; background: rgba(255, 215, 95, 0.14); border: 1px solid rgba(255, 215, 95, 0.5); }
  .badge.cur { color: #7ee2a8; background: rgba(126, 226, 168, 0.12); border: 1px solid rgba(126, 226, 168, 0.5); }
  .badge.mut { color: #ffd75f; background: rgba(255, 215, 95, 0.12); border: 1px solid rgba(255, 215, 95, 0.55); }
  .empty { font-size: 13px; opacity: .65; padding: 18px 0; }
</style>
</head>
<body>
<header id="topbar">
  <div>
    <h1>Solar System</h1>
    <div id="rankLine">Loading&hellip;</div>
  </div>
  <div id="controls">
    <button id="zoomOut" title="Zoom out">&minus;</button>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="fitBtn" title="Fit the whole system">Fit</button>
  </div>
</header>
<div id="orreryWrap">
  <div id="orrery"><div id="world"></div></div>
  <div id="detail" hidden></div>
  <div id="orreryHint">Click a planet for details &middot; Click an empty ring to place a planet &middot; Drag to pan &middot; Scroll to zoom &middot; Scroll down for the Archive</div>
</div>
<div id="pickerBanner" hidden></div>
<section id="archive">
  <h2>Archive</h2>
  <p id="archiveCount"></p>
  <div id="archiveBar">
    <input id="search" type="text" placeholder="Search name, terrain, seed&hellip;" autocomplete="off">
    <select id="sort">
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
      <option value="most">Most characters</option>
      <option value="name">Name A&ndash;Z</option>
      <option value="terrain">Terrain</option>
    </select>
  </div>
  <div id="cards"></div>
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
  var selected = null; // { seed, generation } of the planet in the detail panel
  var searchText = '', sortMode = 'newest';
  var lastSig = '', discs = []; // [{ el, planet, ring }]
  var starGridEl = null; // the star's .pp-grid — re-rendered on the tick so the sun churns + flares
  var orreryEl = document.getElementById('orrery');
  var worldEl = document.getElementById('world');
  var detailEl = document.getElementById('detail');
  var bannerEl = document.getElementById('pickerBanner');
  var cardsEl = document.getElementById('cards');

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
    for (var i = 0; i < state.archive.length; i++) {
      var p = state.archive[i];
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
  function starHtml(sec) {
    if (sec === undefined) sec = 0;
    var W = 84, H = 42, mx = 42, my = 21, mr = 21;
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
            var ff = 0.5 + 0.5 * Math.sin(sec * 3.1 + fph * 6.283);
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
    grid[4][12] = ['*', 255]; grid[6][73] = ['+', 226];
    grid[36][10] = ['.', 250]; grid[37][75] = ['*', 226];
    grid[3][58] = ['.', 255]; grid[39][30] = ['+', 250];
    return P.gridToHtml(grid, 3.67, 6.6);
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
    star.innerHTML = '<div class="pp-grid" style="--pp-fs:6.6px;--pp-ch:6.6px">' + starHtml(sec) + '</div><div class="starName">Sol</div>';
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
        // made it messy). Names live in the detail panel and the
        // Pokedex cards.
        disc.innerHTML = '<div class="pp-grid" style="--pp-fs:6.12px;--pp-ch:6.12px"></div>';
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
  // state changes). Called on the tick so the sun stays alive.
  function renderStar() {
    if (starGridEl) starGridEl.innerHTML = starHtml(sec);
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
    for (var k = 0; k < discs.length; k++) {
      var d = discs[k];
      var gridEl = d.el.querySelector('.pp-grid');
      // Small discs again (Devon, Nov 11 — the bigger ones made the
      // orrery crowded and messy). 46x24 at 2.6px cells: the detail
      // goes into the sun instead, and the detail panel still shows
      // the full large render.
      if (gridEl) gridEl.innerHTML = P.gridToHtml(
        P.renderCozy(d.planet.planet, d.planet.stageIdx, 10, sec, 1.0, 46, 24), 2.6, 6.12);
    }
  }

  // --- detail panel --------------------------------------------------------
  function openDetail(planet) {
    selected = { seed: planet.seed, generation: planet.generation };
    detailOpen = true;
    renderDetail();
    renderOrrerySel();
  }
  function closeDetail() {
    selected = null;
    detailOpen = false;
    detailEl.hidden = true;
    renderOrrerySel();
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
    // Full detail: the whole 136x76 render, not the cozy downsample —
    // this is the big version of the planet (Devon, Nov 11). Zoom 1.2
    // fills more of the frame; the cells fit the 360px panel.
    var art = P.gridToHtml(P.render(planet.planet, planet.stageIdx, 10, sec, 1.2), 2.35, 4.23);
    var html = '<button id="detailClose" class="ghost" data-action="close" title="Close">&times;</button>'
      + '<h2>' + esc(planet.name) + '</h2>'
      + '<p class="sub">' + esc(planet.summary) + ' &middot; Seed ' + planet.seed + '</p>'
      + (planet.mutationLabel ? '<div class="mut">' + esc(planet.mutationLabel) + '</div>' : '')
      + '<div id="detailArt"><div class="pp-grid" style="--pp-fs:4.23px;--pp-ch:4.23px">' + art + '</div></div>'
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
      html += '<p class="note">Removing a planet from the system never deletes it — it stays in the Archive below.</p>';
    }
    detailEl.innerHTML = html;
  }

  // --- archive ---------------------------------------------------------------
  function archiveSignature() {
    if (!state) return '';
    var cur = null;
    for (var i = 0; i < state.archive.length; i++) {
      if (state.archive[i].kind === 'current') cur = state.archive[i].seed + ':' + state.archive[i].stageIdx;
    }
    return JSON.stringify([
      state.archive.map(function (p) { return p.seed + ':' + p.generation; }),
      state.slots.map(function (s) { return s.planet ? s.planet.seed + ':' + s.planet.generation : ''; }),
      cur,
    ]);
  }
  function filteredArchive() {
    var q = searchText.trim().toLowerCase();
    var list = state.archive.filter(function (p) {
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
  function renderArchive() {
    if (!state) return;
    var list = filteredArchive();
    if (pickerRing !== null) list = list.filter(function (p) { return slotOf(p.seed, p.generation) < 0; });
    document.getElementById('archiveCount').textContent =
      state.totalPlanets + ' planet' + (state.totalPlanets === 1 ? '' : 's') + ' — ' + state.ringsUsed + ' in system';
    if (list.length === 0) {
      cardsEl.innerHTML = '<div class="empty">' + (state.totalPlanets === 0
        ? 'No planets yet — type to grow your first one, and it will show up here when it rebirths.'
        : (pickerRing !== null ? 'Every planet is already in your system.' : 'Nothing matches that search.')) + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var inSys = slotOf(p.seed, p.generation) >= 0;
      var thumb = P.gridToHtml(P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19), 3.4, 6.12);
      html += '<div class="card' + (inSys ? ' inSystem' : '') + (pickerRing !== null ? ' picking' : '') + '"'
        + ' data-seed="' + p.seed + '" data-gen="' + p.generation + '">'
        + '<div class="thumb"><div class="pp-grid" style="--pp-fs:6.12px;--pp-ch:6.12px">' + thumb + '</div></div>'
        + '<div class="cname">' + esc(p.name) + '</div>'
        + '<div class="cmeta">' + esc(p.terrainLabel) + ' &middot; ' + esc(p.stageName) + ' &middot; ' + p.chars + ' chars &middot; Gen ' + p.generation + '</div>'
        + (inSys ? '<span class="badge sys">In system</span>' : '')
        + (p.kind === 'current' ? '<span class="badge cur">Growing now</span>' : '')
        // The mutation badge keeps its full label ("MUTATION · Glitch")
        // — the bare name alone read like a life indicator
        // (Devon, Nov 11). The stage in the meta line above is what
        // says whether it has life / cities.
        + (p.mutationLabel ? '<span class="badge mut">' + esc(p.mutationLabel) + '</span>' : '')
        + '</div>';
    }
    cardsEl.innerHTML = html;
  }

  // --- picker mode (choosing a planet for a ring) ---------------------------
  function startPicker(ring) {
    pickerRing = ring;
    bannerEl.hidden = false;
    bannerEl.innerHTML = '<span>Choose a planet for <b>Ring ' + (ring + 1) + '</b> — tap a card below to place it.</span>'
      + '<button id="pickerCancel" class="ghost">Cancel</button>';
    document.getElementById('pickerCancel').addEventListener('click', cancelPicker);
    renderArchive();
    document.getElementById('archive').scrollIntoView({ behavior: 'smooth' });
  }
  function cancelPicker() {
    pickerRing = null;
    bannerEl.hidden = true;
    renderArchive();
  }

  // --- rank line -------------------------------------------------------------
  function updateRankLine() {
    if (!state) return;
    var line = 'System Rank ' + state.rank + ' &middot; ' + state.finished + ' finished planet' + (state.finished === 1 ? '' : 's')
      + ' &middot; ' + state.ringsUsed + ' / ' + state.totalSlots + ' rings used';
    if (state.nextAt !== null) line += ' &middot; next ring at ' + state.nextAt + ' finished (' + state.toNext + ' to go)';
    else line += ' &middot; max rings';
    document.getElementById('rankLine').innerHTML = line;
  }

  // --- pan / zoom --------------------------------------------------------------
  function applyTransform() {
    worldEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
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
    e.preventDefault();
    zoom = Math.max(0.3, Math.min(3, zoom * Math.exp(-e.deltaY * 0.001)));
    applyTransform();
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
  worldEl.addEventListener('mouseover', function (e) {
    if (e.target.closest && e.target.closest('.disc')) hoverPlanet = true;
  });
  worldEl.addEventListener('mouseout', function (e) {
    if (e.target.closest && e.target.closest('.disc')) hoverPlanet = false;
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
  cardsEl.addEventListener('click', function (e) {
    if (suppressClick) return;
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    var seed = +card.getAttribute('data-seed'), gen = +card.getAttribute('data-gen');
    if (pickerRing !== null) {
      vscodeApi.postMessage({ type: 'place', ring: pickerRing, seed: seed, generation: gen });
      cancelPicker();
      document.getElementById('orreryWrap').scrollIntoView({ behavior: 'smooth' });
      var planet = findPlanet(seed, gen);
      if (planet) setTimeout(function () { openDetail(planet); }, 350);
      return;
    }
    var planet2 = findPlanet(seed, gen);
    if (planet2) {
      openDetail(planet2);
      document.getElementById('orreryWrap').scrollIntoView({ behavior: 'smooth' });
    }
  });

  // --- top bar -----------------------------------------------------------------
  document.getElementById('zoomIn').addEventListener('click', function () {
    zoom = Math.min(3, zoom * 1.25); applyTransform();
  });
  document.getElementById('zoomOut').addEventListener('click', function () {
    zoom = Math.max(0.3, zoom / 1.25); applyTransform();
  });
  document.getElementById('fitBtn').addEventListener('click', fitView);
  document.getElementById('search').addEventListener('input', function (e) {
    searchText = e.target.value; renderArchive();
  });
  document.getElementById('sort').addEventListener('change', function (e) {
    sortMode = e.target.value; renderArchive();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (pickerRing !== null) cancelPicker();
    else if (detailOpen) closeDetail();
  });
  window.addEventListener('resize', function () { computeFit(); });

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
    if (!hoverPlanet && !detailOpen) {
      for (var i in angles) {
        angles[i] += 0.0078;
      }
      layoutPlanets();
    }
    if (tick % 3 === 0) renderDiscs(); // discs shimmer ~2x/sec; full re-render every tick is wasteful
    if (tick % 2 === 0) renderStar(); // the sun churns + flares ~3x/sec — never frozen while the planets orbit. Outside the hover/detail guard on purpose: hovering a planet shouldn't freeze the sun.
    if (detailOpen && selected) {
      var artEl = document.getElementById('detailArt');
      if (artEl) {
        var planet = findPlanet(selected.seed, selected.generation);
        if (planet) {
          var gridEl = artEl.querySelector('.pp-grid');
          if (gridEl) gridEl.innerHTML = P.gridToHtml(
            P.render(planet.planet, planet.stageIdx, 10, sec, 1.2), 2.35, 4.23);
        }
      }
    }
  }, 150);

  // --- state from the extension --------------------------------------------------
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'system') return;
    state = msg;
    updateRankLine();
    var sig = archiveSignature();
    if (sig !== lastSig) {
      lastSig = sig;
      renderOrrery();
      renderArchive();
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
    font-family: var(--vscode-font-family); }
  .pp-grid { margin: 0;
    font-family: ${FONT_STACK};
    font-size: var(--pp-fs, 10px); line-height: var(--pp-ch, 18px);
    letter-spacing: 0; white-space: pre;
    -webkit-text-size-adjust: none; text-size-adjust: none; }
  .pp-run { display: inline-block; height: var(--pp-ch, 18px);
    line-height: var(--pp-ch, 18px); vertical-align: top; overflow: hidden;
    white-space: pre; font-kerning: none; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 5px 11px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button.ghost { background: transparent; border: 1px solid var(--vscode-widget-border, #444);
    color: var(--vscode-editor-foreground); }
  button.big { font-size: 14px; padding: 9px 20px; font-weight: 600; }
  #topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--vscode-widget-border, #222);
    background: #080808; position: sticky; top: 0; z-index: 10; }
  #topbar h1 { font-size: 15px; margin: 0 0 2px; }
  #subLine { font-size: 12px; opacity: .75; }
  #counts { font-size: 12px; opacity: .75; white-space: nowrap; }
  #banner { background: #1a1405; border-bottom: 1px solid #e8b64c; color: #ffd75f;
    padding: 9px 16px; font-size: 12px; line-height: 1.5; }
  main { padding: 18px 22px 48px; max-width: 1100px; margin: 0 auto; }
  /* The fusion stage: two parent slots with the collision between them. */
  #slotsRow { display: flex; gap: 14px; align-items: stretch; flex-wrap: wrap; }
  .parentSlot { flex: 1 1 300px; min-width: 280px; background: #0b0b0b;
    border: 1px solid #262626; border-radius: 8px; padding: 12px; }
  .parentSlot.picked { border-color: #e8b64c; }
  .parentSlot.empty { border-style: dashed; display: flex; flex-direction: column;
    align-items: center; justify-content: center; min-height: 320px; color: rgba(255,255,255,.55);
    font-size: 13px; text-align: center; line-height: 1.6; }
  .parentSlot h3 { font-size: 14px; margin: 0 0 2px; }
  .parentSlot .sub { font-size: 12px; opacity: .75; margin: 0 0 8px; line-height: 1.5; }
  .slotArt { background: #050505; border: 1px solid #1c1c1c; padding: 4px; overflow-x: auto; margin-bottom: 8px; }
  .slotTag { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
    color: #ffd75f; margin-bottom: 8px; }
  .mut { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: #ffd75f; background: rgba(255, 215, 95, .12);
    border: 1px solid rgba(255, 215, 95, 0.55); border-radius: 3px; padding: 2px 7px; margin: 0 0 8px; }
  #fusionMid { flex: 0 0 170px; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 8px; text-align: center; }
  #fusionGlyph { font-size: 44px; color: #e8b64c; line-height: 1; }
  #fusionMid .hint { font-size: 12px; opacity: .65; line-height: 1.5; }
  /* The collision stage: the smash itself, full width. */
  #collisionWrap { background: #050505; border: 1px solid #3a3a3a; border-radius: 8px;
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
  /* The result: the offspring, hatched. */
  #result { background: #0b0b0b; border: 1px solid #e8b64c; border-radius: 8px; padding: 16px; }
  #result h2 { font-size: 18px; margin: 0 0 2px; }
  #result .sub { font-size: 12px; opacity: .75; margin: 0 0 10px; line-height: 1.5; }
  #resultArt { background: #050505; border: 1px solid #222; padding: 4px; overflow-x: auto;
    margin-bottom: 12px; display: inline-block; }
  #result .lineage { font-size: 13px; margin: 0 0 8px; line-height: 1.6; }
  #result .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  /* The parent picker. */
  #parents { margin-top: 26px; }
  #parents h2 { font-size: 15px; margin: 0 0 4px; }
  #parentsCount { font-size: 12px; opacity: .75; margin: 0 0 12px; }
  #cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 12px; }
  .card { background: #0b0b0b; border: 1px solid #262626; border-radius: 8px; padding: 10px;
    cursor: pointer; }
  .card:hover { border-color: #555; }
  .card.dim { opacity: .55; cursor: default; }
  .card.dim:hover { border-color: #262626; }
  .card.pickedA, .card.pickedB { border-color: #e8b64c; }
  .card .thumb { background: #050505; border: 1px solid #1c1c1c; margin-bottom: 8px; overflow: hidden; }
  .card .cname { font-size: 13px; font-weight: 600; }
  .card .cmeta { font-size: 11px; opacity: .7; line-height: 1.5; margin-top: 2px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; border-radius: 3px; padding: 1px 6px; margin: 4px 4px 0 0; }
  .badge.ok { color: #7ee2a8; background: rgba(126, 226, 168, 0.12); border: 1px solid rgba(126, 226, 168, 0.5); }
  .badge.pick { color: #ffd75f; background: rgba(255, 215, 95, 0.14); border: 1px solid rgba(255, 215, 95, 0.5); }
  .badge.mut { color: #ffd75f; background: rgba(255, 215, 95, 0.12); border: 1px solid rgba(255, 215, 95, 0.55); }
  .badge.off { color: rgba(255,255,255,.6); background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.25); }
  .empty { font-size: 13px; opacity: .65; padding: 18px 0; }
</style>
</head>
<body>
<header id="topbar">
  <div>
    <h1>Prestige — Fusion</h1>
    <div id="subLine">Two planets that reached Civilization make an offspring. Parents stay in your collection — each can only be a parent once.</div>
  </div>
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
    var art = P.gridToHtml(P.render(p.planet, p.stageIdx, 10, sec, 1.0), 2.2, 3.96);
    return '<div class="slotTag">' + esc(tag) + '</div>'
      + '<h3>' + esc(p.name) + '</h3>'
      + '<p class="sub">' + esc(p.summary) + ' &middot; Seed ' + p.seed + '</p>'
      + (p.mutationLabel ? '<div class="mut">' + esc(p.mutationLabel) + '</div>' : '')
      + '<div class="slotArt"><div class="pp-grid" style="--pp-fs:3.96px;--pp-ch:3.96px">' + art + '</div></div>'
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
      (pickA && pickB) ? 'Two worlds, ready.<br>One of them will not survive the meeting.'
      : 'Pick two parents below —<br>then fuse them.';
  }
  function refreshSlotArt() {
    var grids = slotAEl.querySelectorAll('.pp-grid');
    if (pickA && grids.length) grids[0].innerHTML = P.gridToHtml(
      P.render(pickA.planet, pickA.stageIdx, 10, sec, 1.0), 2.2, 3.96);
    var gridsB = slotBEl.querySelectorAll('.pp-grid');
    if (pickB && gridsB.length) gridsB[0].innerHTML = P.gridToHtml(
      P.render(pickB.planet, pickB.stageIdx, 10, sec, 1.0), 2.2, 3.96);
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
      var thumb = P.gridToHtml(P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19), 3.4, 6.12);
      html += '<div class="card' + (!p.eligible ? ' dim' : '') + (picked ? (tag === 'Parent A' ? ' pickedA' : ' pickedB') : '') + '"'
        + ' data-seed="' + p.seed + '" data-gen="' + p.generation + '">'
        + '<div class="thumb"><div class="pp-grid" style="--pp-fs:6.12px;--pp-ch:6.12px">' + thumb + '</div></div>'
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
