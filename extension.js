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
    this.saveTimer = null;
    context.subscriptions.push(this.statusBar);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.viewProvider)
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('protoplanet.showPet', () => this.showPet())
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
    this.saveNow();
    this.pushState();
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
  #xpbar { height: 6px; background: var(--vscode-progressBar-background, #333);
    border-radius: 3px; overflow: hidden; }
  #xpfill { height: 100%; background: #e8b64c; width: 0%; }
  #meta { font-size: 11px; opacity: .7; margin-top: 6px; line-height: 1.5; }
</style>
</head>
<body>
<div id="wrap"><pre class="pp-grid" id="grid"></pre></div>
<div id="stageName">Your planet is hatching&hellip;</div>
<div id="mutationLabel" style="display:none"></div>
<p id="stageDesc">Pick a starter and start typing &mdash; every character grows it.</p>
<div id="xpbar"><div id="xpfill"></div></div>
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
    const scale = avail / (Planet.CONFIG.W * Planet.CONFIG.CELL_W); // full scale = grid width in px
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
    document.getElementById('stageDesc').textContent = msg.stageDesc;
    const span = Math.max(1, msg.nextXp - msg.stageStart);
    const pct = Math.max(0, Math.min(100, (msg.xp - msg.stageStart) / span * 100));
    document.getElementById('xpfill').style.width = pct.toFixed(1) + '%';
    let meta = 'Grown from ' + msg.chars + ' characters \\u00b7 ' + msg.summary +
      ' \\u00b7 Seed ' + msg.planet.seed;
    if (msg.minerals && msg.minerals.total > 0) {
      meta += ' \\u00b7 \\u25c6 ' + msg.minerals.total + ' mineral' + (msg.minerals.total === 1 ? '' : 's');
    }
    if (msg.minerals && msg.minerals.fed) meta += ' \\u00b7 Fed: ' + msg.minerals.fed;
    document.getElementById('meta').textContent = meta;
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
