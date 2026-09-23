// VAB DOM layer. Pure presentation + event plumbing: all editing decisions live in VABScene (src/scenes/vab.js).
import { el, fmtMass, fmtNumber, fmtDuration, fmtDeltaV } from '../../ui/dom.js';
import { PART_LIST, PART_CATEGORIES } from '../../data/parts.js';
import { RESOURCES } from '../../core/constants.js';
import { craftPartDef, stageKind, partResources, partMass } from '../../game/craft.js';
import { ICONS, STAGE_ICONS } from './icons.js';

const SIZE_LABEL = ['0.625 m', '1.25 m', '2.5 m'];
// Category rail labels must fit a 58 px column (10 px caps): short names for the long ones.
const TAB_LABEL = { command: 'Command', fuel: 'Fuel', engine: 'Engines', coupling: 'Coupling', aero: 'Aero', utility: 'Utility', structural: 'Struct' };
const icon = (name, cls = 'vab-ico') => el('span', { class: cls, html: ICONS[name] || '' });
const kbd = (t) => el('span', { class: 'tsp-kbd' }, t);

function stageIconFor(def) {
  const k = stageKind(def);
  if (k === 'engine') return def.modules.engine.type === 'solid' ? 'solid' : 'liquid';
  if (k === 'decoupler') return def.modules.decoupler.radial ? 'radial' : 'decoupler';
  return 'chute';
}

export class VabUI {
  constructor(scene, root) {
    this.scene = scene;
    this.root = el('div', { class: 'vab-root tsp-passthrough' });
    root.appendChild(this.root);
    this.category = 'command';
    this.search = '';
    this.cards = new Map();
    this.modalOpen = 0;
    this.thumbQueue = [];
    this.disposed = false;
    this._buildTopBar();
    this._buildPartsPanel();
    this._buildRightColumn();
    this._buildBottom();
    this._buildEmptyState();
    this._buildGuide();
    this.tooltip = el('div', { class: 'tsp-tooltip vab-tooltip' });
    this.tooltip.style.display = 'none';
    this.cursorLabel = el('div', { class: 'vab-cursor-label' });
    this.cursorLabel.style.display = 'none';
    this.root.append(this.tooltip, this.cursorLabel);
    this._onDocDown = (e) => { if (this.popup && !this.popup.contains(e.target)) this.hidePartPopup(); };
    document.addEventListener('pointerdown', this._onDocDown, true);
    this.renderPartGrid();
  }

  click() { this.scene.sfx('click'); }

  // ───────────────────────── top bar ─────────────────────────

  _buildTopBar() {
    const s = this.scene;
    const btn = (label, ic, fn, cls = 'tsp-btn small ghost', title = '') => el('button', { class: cls, title, on: { click: () => fn() } }, ic ? icon(ic) : null, label ? el('span', { class: 'vab-btn-label' }, label) : null);
    this.nameInput = el('input', {
      class: 'tsp-input vab-name', maxlength: 40, spellcheck: 'false', value: 'Untitled Rocket', 'aria-label': 'Craft name',
      on: {
        change: () => s.setCraftName(this.nameInput.value),
        // select the whole name when clicking into it (mouseup would otherwise collapse the selection)
        focus: () => { this._selectName = true; setTimeout(() => this.nameInput.select(), 0); },
        mouseup: (e) => { if (this._selectName) { e.preventDefault(); this.nameInput.select(); this._selectName = false; } },
        blur: () => { this._selectName = false; },
        keydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') this.nameInput.blur(); e.stopPropagation(); },
      },
    });
    this.symBtn = el('button', { class: 'tsp-btn small ghost vab-toggle', title: 'Symmetry (X / Shift+X)', on: {
      click: () => s.cycleSymmetry(1),
      contextmenu: (e) => { e.preventDefault(); s.cycleSymmetry(-1); },
    } }, icon('symmetry'), el('span', { class: 'vab-sym-label' }, '×1'));
    this.snapBtn = el('button', { class: 'tsp-btn small ghost vab-toggle', title: 'Angle snap (C)', on: { click: () => s.toggleAngleSnap() } }, icon('snap'), el('span', { class: 'vab-btn-label' }, 'Snap'));
    this.comBtn = el('button', { class: 'tsp-btn small ghost vab-toggle', title: 'Center of mass / thrust markers', on: { click: () => s.toggleCoM() } }, icon('com'), el('span', { class: 'vab-btn-label' }, 'CoM'));
    this.undoBtn = btn('', 'undo', () => s.undo(), 'tsp-btn small ghost tsp-icon-btn', 'Undo (Ctrl+Z)');
    this.redoBtn = btn('', 'redo', () => s.redo(), 'tsp-btn small ghost tsp-icon-btn', 'Redo (Ctrl+Y)');
    this.launchBtn = el('button', { class: 'tsp-btn primary vab-launch', title: 'Launch!', on: { click: () => s.launch() } }, icon('launch'), 'Launch');
    this.top = el('div', { class: 'vab-top tsp-panel' },
      el('div', { class: 'vab-brand' }, el('span', { class: 'vab-brand-badge' }, 'VAB'), el('span', { class: 'vab-brand-sub' }, 'Vehicle Assembly')),
      el('div', { class: 'vab-namewrap' }, this.nameInput),
      el('div', { class: 'vab-group' },
        btn('New', 'newCraft', () => s.newCraft(), undefined, 'Start a new craft'),
        btn('Load', 'load', () => s.openLoadDialog(), undefined, 'Load a stock or saved craft'),
        btn('Save', 'save', () => s.saveCurrent(), undefined, 'Save (Ctrl+S)')),
      el('div', { class: 'vab-sep' }),
      el('div', { class: 'vab-group' }, this.undoBtn, this.redoBtn),
      el('div', { class: 'vab-sep' }),
      el('div', { class: 'vab-group' }, this.symBtn, this.snapBtn, this.comBtn,
        btn('', 'frame', () => s.frameCraft(), 'tsp-btn small ghost tsp-icon-btn', 'Frame craft (F)')),
      el('div', { class: 'vab-spacer' }),
      btn('Exit', 'exit', () => s.exitToSpaceCenter(), 'tsp-btn small ghost', 'Back to the Space Center'),
      this.launchBtn,
    );
    this.root.appendChild(this.top);
  }

  setCraftName(name) { if (document.activeElement !== this.nameInput) this.nameInput.value = name; }
  setSymmetry(n) {
    this.symBtn.querySelector('.vab-sym-label').textContent = '×' + n;
    this.symBtn.classList.toggle('active', n > 1);
  }
  setAngleSnap(on) { this.snapBtn.classList.toggle('active', !!on); }
  setShowCoM(on) { this.comBtn.classList.toggle('active', !!on); }
  setUndoState(u, r) { this.undoBtn.disabled = !u; this.redoBtn.disabled = !r; }
  setLaunchReady(state) {
    this.launchBtn.classList.toggle('ready', state === 'ok');
    this.launchBtn.classList.toggle('blocked', state === 'error');
  }

  // ───────────────────────── parts panel ─────────────────────────

  _buildPartsPanel() {
    const s = this.scene;
    this.searchInput = el('input', { class: 'tsp-input vab-search', placeholder: 'Search parts…', spellcheck: 'false', on: {
      input: () => { this.search = this.searchInput.value.trim().toLowerCase(); this.renderPartGrid(); },
      keydown: (e) => { if (e.key === 'Escape') { this.searchInput.value = ''; this.search = ''; this.renderPartGrid(); this.searchInput.blur(); } e.stopPropagation(); },
    } });
    this.tabs = el('div', { class: 'vab-tabs' });
    for (const c of PART_CATEGORIES) {
      const count = PART_LIST.filter(p => p.category === c.id).length;
      const t = el('button', { class: 'vab-tab', title: c.name, dataset: { cat: c.id }, on: { click: () => {
        this.category = c.id; this.search = ''; this.searchInput.value = ''; this.renderPartGrid();
      } } }, icon(c.id, 'vab-tab-ico'), el('span', { class: 'vab-tab-label' }, TAB_LABEL[c.id] || c.name.split(' ')[0]), el('span', { class: 'vab-tab-count' }, String(count)));
      this.tabs.appendChild(t);
    }
    this.grid = el('div', { class: 'vab-grid' });
    this.catTitle = el('div', { class: 'vab-cat-title' });
    this.trash = el('div', { class: 'vab-trash' }, icon('trash', 'vab-trash-ico'), el('div', {}, 'Drop here to scrap'));
    this.parts = el('div', { class: 'vab-parts tsp-panel', on: {
      pointerdown: (e) => { if (s.isHolding() && !e.target.closest('.vab-card') && !e.target.closest('input')) { e.preventDefault(); s.dropHeldOnPanel(); } },
    } },
    el('div', { class: 'vab-parts-head' }, el('span', { class: 'vab-search-ico' }, icon('search')), this.searchInput),
    el('div', { class: 'vab-parts-body' }, this.tabs, el('div', { class: 'vab-grid-wrap' }, this.catTitle, this.grid)),
    this.trash);
    this.root.appendChild(this.parts);
  }

  renderPartGrid() {
    const q = this.search;
    const list = q
      ? PART_LIST.filter(p => (p.name + ' ' + p.description + ' ' + p.category + ' ' + p.id).toLowerCase().includes(q))
      : PART_LIST.filter(p => p.category === this.category);
    for (const t of this.tabs.children) {
      t.classList.toggle('active', !q && t.dataset.cat === this.category);
      t.classList.toggle('guide', t.dataset.cat === this.guideCat);
    }
    const cat = PART_CATEGORIES.find(c => c.id === this.category);
    this.catTitle.textContent = q ? `${list.length} result${list.length === 1 ? '' : 's'} for “${q}”` : cat.name;
    this.grid.replaceChildren();
    for (const def of list) {
      const card = this._card(def);
      card.classList.toggle('guide', def.id === this.guideCardId);
      this.grid.appendChild(card);
    }
    if (!list.length) this.grid.appendChild(el('div', { class: 'vab-empty-grid' }, 'No parts match. Try “tank”, “engine” or “fin”.'));
    this._queueThumbs(list);
  }

  _card(def) {
    let card = this.cards.get(def.id);
    if (card) return card;
    const img = el('img', { class: 'vab-card-img', src: this.scene.visuals.icon(def), alt: '', draggable: 'false' });
    const eng = def.modules.engine;
    const badge = eng ? `${fmtNumber(eng.thrustVac)} kN` : def.resources && Object.keys(def.resources).some(r => r !== 'ElectricCharge')
      ? fmtMass(partMass({ part: def.id }, def)) : SIZE_LABEL[def.size] || '';
    card = el('div', { class: 'vab-card', dataset: { id: def.id }, on: {
      pointerdown: (e) => { if (e.button !== 0) return; e.preventDefault(); this.hideTooltip(); this.scene.pickNewPart(def.id, e); },
      pointerenter: () => { if (!this.scene.isHolding()) this.showTooltip(def, card); },
      pointerleave: () => this.hideTooltip(),
    } },
    el('div', { class: 'vab-card-thumb' }, img),
    el('div', { class: 'vab-card-name' }, def.name),
    el('div', { class: 'vab-card-meta' }, badge));
    card.__img = img;
    this.cards.set(def.id, card);
    return card;
  }

  _queueThumbs(list) {
    if (!this.scene.visuals.mod) return;
    const pending = list.filter(d => !this.cards.get(d.id)?.__thumbDone);
    this.thumbQueue = [...pending, ...this.thumbQueue.filter(d => !pending.includes(d))];
    if (this._thumbRunning) return;
    this._thumbRunning = true;
    const next = async () => {
      if (this.disposed) return;
      const def = this.thumbQueue.shift();
      if (!def) { this._thumbRunning = false; return; }
      const card = this.cards.get(def.id);
      if (card && !card.__thumbDone) {
        card.__thumbDone = true;
        const url = await this.scene.visuals.thumbnail(def, 128);
        if (url && !this.disposed) { card.__img.src = url; card.classList.add('has-thumb'); }
      }
      setTimeout(next, 16);
    };
    setTimeout(next, 50);
  }

  showTooltip(def, anchor) {
    const t = this.tooltip;
    const rows = [];
    const row = (k, v, cls = '') => rows.push(el('div', { class: 'vab-tt-row ' + cls }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v)));
    const wet = partMass({ part: def.id }, def);
    row('Mass', def.resources && Object.keys(def.resources).length && wet !== def.mass ? `${fmtMass(wet)} (dry ${fmtMass(def.mass)})` : fmtMass(def.mass));
    row('Cost', fmtNumber(def.cost));
    if (def.nodes?.top || def.nodes?.bottom) row('Size', SIZE_LABEL[def.size] || '—');
    const m = def.modules || {};
    if (m.command) row('Crew', m.command.probe ? 'Probe core (needs power)' : `${m.command.crew} Tinynaut${m.command.crew > 1 ? 's' : ''}`);
    if (m.reactionWheel) row('Torque', `${m.reactionWheel.torque} kN·m`);
    if (m.engine) {
      const e = m.engine;
      const asl = e.thrustVac * e.ispASL / e.ispVac;
      row('Thrust', `${fmtNumber(e.thrustVac)} kN vac · ${fmtNumber(asl)} kN ASL`, 'hl');
      row('Isp', `${e.ispVac} s vac · ${e.ispASL} s ASL`, 'hl');
      if (e.gimbal) row('Gimbal', `${e.gimbal}°`);
      row('Type', e.type === 'solid' ? 'Solid — cannot be throttled' : e.type === 'nuclear' ? 'Nuclear — liquid fuel only' : 'Liquid fuel + oxidizer');
      const twr = (asl * 1000) / (wet * 1000 * 9.81);
      row('TWR alone', twr.toFixed(1));
    }
    if (m.decoupler) row('Ejection', `${m.decoupler.ejectionForce} kN${m.decoupler.radial ? ' · radial' : ''}`);
    if (m.parachute) row('Chute', `opens < ${fmtNumber(m.parachute.deployAltitude)} m · safe under ${m.parachute.safeSpeed} m/s`);
    if (m.fin) row('Fin', `${m.fin.area} m²${m.fin.control ? ` · steers ±${m.fin.maxDeflection}°` : ''}`);
    if (m.legs) row('Legs', `${m.legs.stroke} m suspension · press G`);
    if (m.heatShield) row('Heat shield', 'Ablative');
    if (m.rcs) row('RCS', `${m.rcs.nozzles.length} × ${m.rcs.thrust} kN`);
    if (m.solarPanel) row('Solar', `${m.solarPanel.chargeRate} EC/s in sunlight`);
    for (const [res, amt] of Object.entries(def.resources || {})) {
      const R = RESOURCES[res];
      rows.push(el('div', { class: 'vab-tt-row res' }, el('span', { class: 'k' }, el('i', { class: 'dot', style: `background:${R?.color || '#ccc'}` }), R?.label || res), el('span', { class: 'v' }, fmtNumber(amt))));
    }
    row('Crash tolerance', `${def.crashTolerance} m/s`);
    row('Max temp', `${fmtNumber(def.maxTemp)} K`);
    const attach = [];
    if (def.nodes?.top || def.nodes?.bottom) attach.push('stack');
    if (def.srfAttach) attach.push('surface');
    if (def.allowSrfAttach) attach.push('accepts radial parts');
    row('Attaches', attach.join(' · ') || '—');
    const cat = PART_CATEGORIES.find(c => c.id === def.category);
    t.replaceChildren(
      el('div', { class: 'vab-tt-head' }, el('span', { class: 'vab-tt-name' }, def.name), el('span', { class: 'vab-tt-cat' }, cat?.name || def.category)),
      el('div', { class: 'vab-tt-desc' }, def.description),
      ...rows,
    );
    t.style.display = 'block';
    const a = anchor.getBoundingClientRect(), p = this.parts.getBoundingClientRect();
    const h = t.offsetHeight;
    t.style.left = `${p.right + 10}px`;
    t.style.top = `${Math.max(64, Math.min(window.innerHeight - h - 10, a.top + a.height / 2 - h / 2))}px`;
  }
  hideTooltip() { this.tooltip.style.display = 'none'; }

  setHolding(on) {
    this.root.classList.toggle('holding', !!on);
    if (on) this.hideTooltip();
  }

  /** Is the point over any interactive UI (so the 3D view should ignore it)? */
  isOverUI(x, y) {
    const e = document.elementFromPoint(x, y);
    return !!(e && e !== this.scene.app.canvas && e.closest('.vab-root') && !e.classList.contains('vab-root'));
  }
  isOverParts(x, y) {
    const r = this.parts.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  setTrashHot(on) { this.parts.classList.toggle('trash-hot', !!on); }

  // ───────────────────────── staging column ─────────────────────────

  _buildRightColumn() {
    const s = this.scene;
    this.stageList = el('div', { class: 'vab-stage-list' });
    this.stageTotal = el('div', { class: 'vab-stage-total' });
    this.autoBadge = el('span', { class: 'vab-auto-badge' }, 'auto');
    this.staging = el('div', { class: 'vab-staging tsp-panel' },
      el('div', { class: 'vab-panel-head' },
        el('span', { class: 'vab-panel-title' }, 'Staging'), this.autoBadge,
        el('span', { class: 'vab-spacer' }),
        el('button', { class: 'tsp-btn small ghost', title: 'Add an empty stage on top (fires first)', on: { click: () => s.stageAdd() } }, icon('plus'), el('span', { class: 'vab-btn-label' }, 'Stage')),
        el('button', { class: 'tsp-btn small ghost', title: 'Reset to automatic staging', on: { click: () => s.autoStageNow() } }, icon('auto'), el('span', { class: 'vab-btn-label' }, 'Auto'))),
      this.stageList,
      el('div', { class: 'vab-stage-legend' }, el('i', { class: 'fire' }), 'fires in this stage', el('i', { class: 'drop' }), 'falls away'),
      this.stageTotal);
    this.engineer = el('div', { class: 'vab-engineer tsp-panel' });
    this.engineerOpen = true;
    this.rightCol = el('div', { class: 'vab-right' }, this.staging, this.engineer);
    this.root.appendChild(this.rightCol);
    this._initStageDrag();
  }

  /**
   * stages: [{ stage, groups:[{def, uids, count}], vac, asl, launch:boolean }] (highest first)
   */
  updateStaging(stages, totals, isAuto) {
    this.autoBadge.style.display = isAuto ? '' : 'none';
    this.stageList.replaceChildren();
    if (!stages.length) {
      this.stageList.appendChild(el('div', { class: 'vab-stage-empty' }, 'Engines, decouplers and parachutes appear here. Drag them between stages to change the firing order.'));
    }
    for (const st of stages) {
      const icons = st.groups.map(gp => {
        const kind = stageIconFor(gp.def);
        const chip = el('div', {
          class: `vab-sicon k-${kind}`, title: `${gp.def.name}${gp.count > 1 ? ` ×${gp.count}` : ''}`,
          dataset: { uids: gp.uids.join(',') },
        }, el('span', { class: 'vab-sicon-g', html: STAGE_ICONS[kind] }), gp.count > 1 ? el('span', { class: 'vab-sicon-n' }, '×' + gp.count) : null);
        return chip;
      });
      const hasDv = st.vac.deltaV > 0.5;
      const twr = st.asl.twr;
      const twrCls = !hasDv ? '' : (st.launch ? (twr < 1 ? 'bad' : twr < 1.3 ? 'warn' : 'good') : '');
      const body = el('div', { class: 'vab-stage-body' },
        el('div', { class: 'vab-stage-icons' }, icons.length ? icons : el('span', { class: 'vab-stage-placeholder' }, 'empty — drop parts here')),
        hasDv ? el('div', { class: 'vab-stage-stats' },
          el('span', { title: 'ΔV in vacuum' }, el('b', {}, fmtNumber(st.vac.deltaV)), ' m/s'),
          el('span', { class: 'dim', title: `ΔV at Verda sea level` }, 'ASL ', fmtNumber(st.asl.deltaV)),
          el('span', { class: 'twr ' + twrCls, title: 'Thrust-to-weight at Verda sea level' }, 'TWR ', twr.toFixed(2)),
          el('span', { class: 'dim nowrap', title: 'Burn time (vacuum)' }, fmtDuration(st.vac.burnTime, true))) : null);
      const group = el('div', { class: 'vab-stage' + (st.launch ? ' launch' : ''), dataset: { stage: String(st.stage) },
        title: 'Hover to preview: orange = fires in this stage, red = falls away' },
        el('div', { class: 'vab-stage-head' },
          el('span', { class: 'vab-stage-num' }, String(st.stage)),
          el('span', { class: 'vab-stage-label' }, st.launch ? 'Launch' : `Stage ${st.stage}`),
          el('span', { class: 'vab-spacer' }),
          hasDv ? el('span', { class: 'vab-stage-dv' }, fmtDeltaV(st.vac.deltaV)) : null,
          el('button', { class: 'vab-stage-x', title: 'Remove stage (parts move to the next stage)', on: { click: (e) => { e.stopPropagation(); this.scene.stageRemove(st.stage); } } }, icon('close'))),
        body);
      this.stageList.appendChild(group);
    }
    this.stageTotal.replaceChildren(
      el('div', { class: 'vab-total-row' }, el('span', {}, 'Total ΔV'), el('b', {}, fmtDeltaV(totals.vac)), el('span', { class: 'dim' }, 'vac')),
      el('div', { class: 'vab-total-row dim' }, el('span', {}, ''), el('span', {}, fmtDeltaV(totals.asl)), el('span', {}, 'ASL')),
    );
  }

  _initStageDrag() {
    let drag = null;
    const zoneAt = (x, y) => {
      const e = document.elementFromPoint(x, y);
      if (!e) return null;
      const nz = e.closest('.vab-stage-new');
      if (nz) return nz;
      return e.closest('.vab-stage');
    };
    const clearHot = () => this.staging.querySelectorAll('.hot').forEach(n => n.classList.remove('hot'));
    this.stageList.addEventListener('pointerdown', (e) => {
      const chip = e.target.closest('.vab-sicon');
      if (!chip || e.button !== 0) return;
      e.preventDefault();
      drag = { chip, uids: chip.dataset.uids.split(',').map(v => (/^-?\d+$/.test(v) ? Number(v) : v)), x: e.clientX, y: e.clientY, active: false, ghost: null };
    });
    this._stageMove = (e) => {
      if (!drag) {
        const chip = e.target?.closest?.('.vab-sicon');
        const key = chip ? chip.dataset.uids : null;
        if (key !== this._hoverChip) {
          this._hoverChip = key;
          this.scene.highlightParts(key ? key.split(',').map(v => (/^-?\d+$/.test(v) ? Number(v) : v)) : null);
        }
        // stage preview: hovering a stage card shows what fires (orange) and what falls away (red)
        const card = e.target?.closest?.('.vab-stage');
        const st = card && this.stageList.contains(card) ? Number(card.dataset.stage) : null;
        if (st !== this._hoverStage) {
          this._hoverStage = st;
          const pv = this.scene.previewStage(st);
          this.staging.classList.toggle('previewing', !!pv);
        }
        return;
      }
      if (!drag.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) {
        drag.active = true;
        drag.ghost = drag.chip.cloneNode(true);
        drag.ghost.classList.add('vab-sicon-ghost');
        document.body.appendChild(drag.ghost);
        drag.chip.classList.add('dragging');
        this.stageList.classList.add('dragging');
        // new-stage drop zones overlay the panel header & footer, so nothing shifts under the cursor
        const top = el('div', { class: 'vab-stage-new top', dataset: { where: 'top' } }, '+ new first stage');
        const bot = el('div', { class: 'vab-stage-new bottom', dataset: { where: 'bottom' } }, '+ new last stage');
        this.staging.append(top, bot);
      }
      if (drag.active) {
        drag.ghost.style.left = `${e.clientX - 18}px`;
        drag.ghost.style.top = `${e.clientY - 18}px`;
        clearHot();
        const z = zoneAt(e.clientX, e.clientY);
        if (z) z.classList.add('hot');
      }
    };
    this._stageUp = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.active) return;
      d.ghost.remove();
      d.chip.classList.remove('dragging');
      this.stageList.classList.remove('dragging');
      const z = zoneAt(e.clientX, e.clientY);
      clearHot();
      this.staging.querySelectorAll('.vab-stage-new').forEach(n => n.remove());
      if (!z) return;
      if (z.classList.contains('vab-stage-new')) this.scene.stageMove(d.uids, { newAt: z.dataset.where });
      else this.scene.stageMove(d.uids, Number(z.dataset.stage));
    };
    window.addEventListener('pointermove', this._stageMove);
    window.addEventListener('pointerup', this._stageUp);
  }

  /**
   * v: validateCraft result (issues carry the uids to highlight); dvInfo: the all-clear line; opts: { empty, canFix }.
   * Hovering an item lights up the parts it is about; staging items offer a one-click "Fix staging" (auto-stage).
   */
  updateEngineer(v, dvInfo, { empty = false, canFix = false } = {}) {
    // the hovered item is about to be replaced (no pointerleave will come): drop its highlight
    if (this._engHover) { this._engHover = false; this.scene.highlightParts(null); }
    const items = [];
    const issues = v.issues || [...v.errors.map(text => ({ level: 'error', text, uids: [] })), ...v.warnings.map(text => ({ level: 'warn', text, uids: [] }))];
    let fixShown = false;
    for (const is of issues) {
      const bad = is.level === 'error';
      const fix = !fixShown && canFix && is.kind === 'staging'
        ? el('button', { class: 'tsp-btn small vab-eng-fix', title: 'Reset to automatic staging', on: { click: (e) => { e.stopPropagation(); this.scene.autoStageNow(); } } }, icon('auto'), 'Fix staging')
        : null;
      if (fix) fixShown = true;
      const uids = is.uids || [];
      const item = el('div', { class: `vab-eng-item ${bad ? 'bad' : 'warn'}${uids.length ? ' has-parts' : ''}`, title: uids.length ? 'Hover to highlight the parts' : '' },
        icon(bad ? 'error' : 'warn', 'vab-eng-ico'), el('div', { class: 'vab-eng-text' }, is.text, fix));
      if (uids.length) {
        item.addEventListener('pointerenter', () => { this._engHover = true; this.scene.highlightParts(uids); });
        item.addEventListener('pointerleave', () => { this._engHover = false; this.scene.highlightParts(null); });
      }
      items.push(item);
    }
    if (!items.length) {
      items.push(empty
        ? el('div', { class: 'vab-eng-item info' }, icon('command', 'vab-eng-ico'), dvInfo || 'Add a command pod to begin.')
        : el('div', { class: 'vab-eng-item good' }, icon('ok', 'vab-eng-ico'), dvInfo || 'All systems nominal. Go for launch!'));
    }
    const nBad = v.errors.length, nWarn = v.warnings.length;
    const summary = empty ? 'Empty' : nBad ? `${nBad} problem${nBad > 1 ? 's' : ''}` : nWarn ? `${nWarn} warning${nWarn > 1 ? 's' : ''}` : 'Nominal';
    const head = el('div', { class: 'vab-panel-head vab-eng-head', on: { click: () => { this.engineerOpen = !this.engineerOpen; this.engineer.classList.toggle('closed', !this.engineerOpen); } } },
      el('span', { class: 'vab-panel-title' }, "Engineer's Report"),
      el('span', { class: 'vab-spacer' }),
      el('span', { class: `vab-eng-sum ${empty ? 'idle' : nBad ? 'bad' : nWarn ? 'warn' : 'good'}` }, summary));
    this.engineer.replaceChildren(head, el('div', { class: 'vab-eng-list' }, items));
    this.engineer.classList.toggle('closed', !this.engineerOpen);
  }

  // ───────────────────────── bottom: stats + hints ─────────────────────────

  _buildBottom() {
    this.stats = el('div', { class: 'vab-stats tsp-panel' });
    this.hints = el('div', { class: 'vab-hints' });
    this.bottom = el('div', { class: 'vab-bottom tsp-passthrough' }, this.hints, this.stats);
    this.root.appendChild(this.bottom);
  }

  updateStats(st, dv, launchTwr) {
    const pill = (ic, label, value, cls = '') => el('div', { class: 'vab-stat ' + cls }, icon(ic, 'vab-stat-ico'), el('div', {}, el('div', { class: 'vab-stat-v' }, value), el('div', { class: 'vab-stat-k' }, label)));
    const twrCls = launchTwr == null ? '' : launchTwr < 1 ? 'bad' : launchTwr < 1.3 ? 'warn' : 'good';
    this.stats.replaceChildren(
      pill('mass', 'Mass', fmtMass(st.mass)),
      pill('parts', 'Parts', String(st.partCount)),
      pill('cost', 'Cost', fmtNumber(st.cost)),
      pill('height', 'Height', `${st.height.toFixed(1)} m`),
      pill('crew', 'Crew', String(st.crew)),
      pill('dv', 'ΔV vac', fmtDeltaV(dv), 'accent'),
      pill('twr', 'Launch TWR', launchTwr == null ? '—' : launchTwr.toFixed(2), twrCls),
    );
  }

  setHints(mode, ctx = {}) {
    this.hints.style.display = this.scene.app.game?.settings?.tutorialHints === false ? 'none' : '';
    if (this._hintMode === mode + JSON.stringify(ctx)) return;
    this._hintMode = mode + JSON.stringify(ctx);
    const h = [];
    const H = (keys, text, minor = false) => h.push(el('span', { class: 'vab-hint' + (minor ? ' minor' : '') }, ...keys.map(k => kbd(k)), el('span', {}, text)));
    if (mode === 'holding') {
      H(['Click'], ctx.clipped ? 'blocked — it would clip' : ctx.canPlace ? (ctx.count > 1 ? `attach ×${ctx.count}` : 'attach') : 'aim at a node or surface');
      H(ctx.surface ? ['Q', 'E'] : ['WASDQE'], ctx.surface ? 'roll · WASD tilt' : 'rotate');
      H(['X'], ctx.inherited ? `sym from parent (×${ctx.count})` : `sym ×${ctx.sym}`);
      H(['C'], ctx.snap ? 'snap on' : 'snap off');
      H(['Del'], 'scrap');
      H(['Esc'], 'cancel');
    } else if (mode === 'empty') {
      H(['Click'], 'a part on the left to start — pods make great roots');
    } else {
      H(['Click'], 'move');
      H(['Alt+Click'], 'copy');
      H(['RMB'], 'menu · drag orbit');
      H(['Wheel'], 'zoom');
      H(['Shift+Wheel'], 'pan', true);
      H(['F'], 'frame');
      H(['Ctrl+Z'], 'undo', true);
    }
    this.hints.replaceChildren(...h);
  }

  // ───────────────────────── empty state ─────────────────────────

  _buildEmptyState() {
    this.empty = el('div', { class: 'vab-emptystate' },
      el('div', { class: 'vab-es-title' }, 'An empty hangar is full of possibility'),
      el('div', { class: 'vab-es-text' }, 'Pick a command pod from the parts list to start your rocket, or roll out one of the stock designs.'),
      el('div', { class: 'vab-es-row' },
        el('button', { class: 'tsp-btn', on: { click: () => this.scene.pickNewPart('pod_mk1', null) } }, icon('command'), 'Start with a Mk1 Capsule'),
        el('button', { class: 'tsp-btn ghost', on: { click: () => this.scene.openLoadDialog('stock') } }, icon('load'), 'Stock rockets')));
    this.root.appendChild(this.empty);
  }
  showEmptyState(on) { this.empty.classList.toggle('show', !!on); }

  // ───────────────────────── first-rocket guide ─────────────────────────

  _buildGuide() {
    this.guideList = el('div', { class: 'vab-guide-list' });
    this.guide = el('div', { class: 'vab-guide tsp-panel' },
      el('div', { class: 'vab-guide-head' },
        el('span', { class: 'vab-guide-title' }, 'Your first rocket'),
        el('span', { class: 'vab-spacer' }),
        el('button', { class: 'vab-guide-x', title: 'Hide the guide', on: { click: () => this.scene.dismissGuide() } }, icon('close'))),
      this.guideList);
    this.root.appendChild(this.guide);
  }

  /**
   * state: null (hidden) | { steps:[{ label, hint, done, current, cat, card }], complete }.
   * cardHidden: keep only the glow on the next part (the empty-hangar card already says what to do).
   */
  updateGuide(state, { cardHidden = false } = {}) {
    const on = !!state && this.scene.app.game?.settings?.tutorialHints !== false;
    this.guide.classList.toggle('show', on && !cardHidden);
    const cur = on ? state.steps.find(st => st.current) : null;
    const cat = cur?.cat || null, card = cur?.card || null;
    if (cat !== this.guideCat || card !== this.guideCardId) {
      this.guideCat = cat; this.guideCardId = card;
      for (const t of this.tabs.children) t.classList.toggle('guide', t.dataset.cat === cat);
      for (const [id, c] of this.cards) c.classList.toggle('guide', id === card);
    }
    if (!on) return;
    const key = JSON.stringify(state);
    if (key === this._guideKey) return;
    this._guideKey = key;
    this.guide.classList.toggle('complete', !!state.complete);
    this.guideList.replaceChildren(...state.steps.map((st, i) => el('div', {
      class: `vab-guide-step${st.done ? ' done' : ''}${st.current ? ' current' : ''}`,
      on: { click: () => { if (st.cat && !st.done) { this.category = st.cat; this.search = ''; this.searchInput.value = ''; this.renderPartGrid(); this.click(); } } },
    },
    el('span', { class: 'vab-guide-dot' }, st.done ? icon('ok', 'vab-guide-ico') : String(i + 1)),
    el('div', { class: 'vab-guide-txt' }, el('div', { class: 'vab-guide-label' }, st.label), st.current && st.hint ? el('div', { class: 'vab-guide-hint' }, st.hint) : null))));
  }

  // ───────────────────────── cursor label ─────────────────────────

  showCursorLabel(text, x, y, sub = '', kind = '') {
    const c = this.cursorLabel;
    if (c.__t !== text + sub + kind) {
      c.__t = text + sub + kind;
      c.className = 'vab-cursor-label' + (kind ? ' ' + kind : '');
      c.replaceChildren(...[el('b', {}, text), sub ? el('span', {}, sub) : null].filter(Boolean));   // (a null child would print "null")
    }
    c.style.display = 'block';
    c.style.transform = `translate(${x + 16}px, ${y + 14}px)`;
  }
  hideCursorLabel() { this.cursorLabel.style.display = 'none'; }

  // ───────────────────────── part action popup ─────────────────────────

  showPartPopup(part, x, y) {
    this.hidePartPopup();
    const s = this.scene;
    const def = craftPartDef(part);
    const mates = s.symmetryMates(part);
    const rows = [];
    for (const [res, r] of Object.entries(partResources(part, def))) {
      const R = RESOURCES[res];
      const val = el('span', { class: 'vab-pp-val tsp-mono' }, `${fmtNumber(r.amount, r.max < 10 ? 1 : 0)} / ${fmtNumber(r.max)}`);
      const slider = el('input', { type: 'range', min: 0, max: r.max, step: r.max <= 20 ? 0.5 : 1, value: r.amount, class: 'vab-slider', style: `--c:${R?.color || '#3fa9ff'}`, on: {
        input: () => { val.textContent = `${fmtNumber(Number(slider.value), r.max < 10 ? 1 : 0)} / ${fmtNumber(r.max)}`; s.setPartResource(part.uid, res, Number(slider.value), false); upd(); },
        change: () => s.setPartResource(part.uid, res, Number(slider.value), true),
      } });
      rows.push(el('div', { class: 'vab-pp-res' }, el('div', { class: 'vab-pp-rl' }, el('i', { class: 'dot', style: `background:${R?.color}` }), R?.label || res, val), slider));
    }
    const massEl = el('span', {});
    const upd = () => { massEl.textContent = fmtMass(partMass(part, def) * mates.length); };
    upd();
    const kind = stageKind(def);
    let stageRow = null;
    if (kind) {
      const num = el('span', { class: 'vab-pp-stage tsp-mono' }, String(part.stage));
      const step = (d) => { const ns = s.setPartStage(part.uid, part.stage + d); num.textContent = String(ns); };
      stageRow = el('div', { class: 'vab-pp-row' }, el('span', {}, 'Stage'), el('span', { class: 'vab-spacer' }),
        el('button', { class: 'tsp-btn small ghost tsp-icon-btn', title: 'Fire later', on: { click: () => step(-1) } }, '−'), num,
        el('button', { class: 'tsp-btn small ghost tsp-icon-btn', title: 'Fire earlier', on: { click: () => step(1) } }, '+'));
    }
    const pop = el('div', { class: 'vab-popup tsp-panel' },
      el('div', { class: 'vab-pp-head' }, el('div', {}, el('div', { class: 'vab-pp-name' }, def.name),
        el('div', { class: 'vab-pp-sub' }, mates.length > 1 ? `×${mates.length} in symmetry · ` : '', massEl, ' · ', fmtNumber(def.cost * mates.length))),
      el('button', { class: 'vab-pp-close', on: { click: () => this.hidePartPopup() } }, icon('close'))),
      rows.length ? el('div', { class: 'vab-pp-section' }, rows) : null,
      stageRow,
      el('div', { class: 'vab-pp-actions' },
        el('button', { class: 'tsp-btn small ghost', on: { click: () => { this.hidePartPopup(); s.pickUpPart(part.uid); } } }, 'Pick up'),
        el('button', { class: 'tsp-btn small ghost', on: { click: () => { this.hidePartPopup(); s.pickUpPart(part.uid, true); } } }, 'Duplicate'),
        el('button', { class: 'tsp-btn small danger', on: { click: () => { this.hidePartPopup(); s.deletePart(part.uid); } } }, icon('trash'), 'Delete')));
    this.root.appendChild(pop);
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.min(window.innerWidth - w - 12, x + 12)}px`;
    pop.style.top = `${Math.max(64, Math.min(window.innerHeight - h - 12, y - 20))}px`;
    this.popup = pop;
    this.popupUid = part.uid;
  }
  hidePartPopup() { this.popup?.remove(); this.popup = null; this.popupUid = null; }

  // ───────────────────────── modals ─────────────────────────

  /** Generic modal. buttons: [{label, value, kind:'primary'|'danger'|'ghost'}] → Promise<value|null> */
  modal(title, body, buttons, { wide = false, cls = '' } = {}) {
    return new Promise((resolve) => {
      this.modalOpen++;
      let done = false;
      const close = (v) => {
        if (done) return; done = true;
        this.modalOpen--;
        window.removeEventListener('keydown', onKey, true);
        back.classList.add('closing');
        setTimeout(() => back.remove(), 150);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') {
          const prim = buttons.find(b => b.kind === 'primary');
          if (prim) { e.preventDefault(); close(prim.value); }
        }
      };
      window.addEventListener('keydown', onKey, true);
      const box = el('div', { class: `tsp-modal tsp-panel vab-modal ${wide ? 'wide' : ''} ${cls}` },
        el('h2', {}, title), body,
        el('div', { class: 'tsp-row' }, buttons.map(b => el('button', { class: `tsp-btn ${b.kind || ''}`, on: { click: () => close(b.value) } }, b.label))));
      const back = el('div', { class: 'tsp-modal-backdrop vab-backdrop', on: { pointerdown: (e) => { if (e.target === back) close(null); } } }, box);
      this._lastModalClose = close;
      this.root.appendChild(back);
    });
  }

  confirm(title, text, okLabel = 'OK', kind = 'primary') {
    return this.modal(title, el('p', { class: 'vab-modal-text' }, text), [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: okLabel, value: true, kind }]).then(v => !!v);
  }

  /** Engineer's pre-launch report. Resolves true to launch. */
  launchReport(v) {
    const list = el('div', { class: 'vab-report' },
      ...v.errors.map(e => el('div', { class: 'vab-eng-item bad' }, icon('error', 'vab-eng-ico'), e)),
      ...v.warnings.map(w => el('div', { class: 'vab-eng-item warn' }, icon('warn', 'vab-eng-ico'), w)));
    if (v.errors.length) {
      return this.modal("Engineer's Report", el('div', {}, el('p', { class: 'vab-modal-text' }, 'The engineers refuse to roll this out to the pad:'), list),
        [{ label: 'Back to the VAB', value: false, kind: 'primary' }]).then(() => false);
    }
    return this.modal("Engineer's Report", el('div', {}, el('p', { class: 'vab-modal-text' }, 'A few concerns before we light this candle:'), list),
      [{ label: 'Back to the VAB', value: false, kind: 'ghost' }, { label: 'Launch anyway', value: true, kind: 'primary' }]).then(v2 => !!v2);
  }

  /**
   * Load dialog. stock: [{craft, stats, dv}], saved: [{name, updated, partCount}], callbacks: load(craft|name), remove(name)
   */
  loadDialog({ stock, saved, tab = 'stock', onLoadStock, onLoadSaved, onDelete }) {
    let current = tab;
    let savedList = saved;
    const body = el('div', { class: 'vab-load' });
    const tabs = el('div', { class: 'vab-load-tabs' });
    const content = el('div', { class: 'vab-load-content' });
    body.append(tabs, content);
    let closeFn = null;
    const render = () => {
      tabs.replaceChildren(
        el('button', { class: 'vab-load-tab' + (current === 'stock' ? ' active' : ''), on: { click: () => { current = 'stock'; render(); } } }, 'Stock rockets', el('span', { class: 'n' }, String(stock.length))),
        el('button', { class: 'vab-load-tab' + (current === 'saved' ? ' active' : ''), on: { click: () => { current = 'saved'; render(); } } }, 'My rockets', el('span', { class: 'n' }, String(savedList.length))));
      content.replaceChildren();
      if (current === 'stock') {
        for (const s of stock) {
          content.appendChild(el('div', { class: 'vab-load-card', on: { click: () => { this.click(); closeFn?.(null); onLoadStock(s.craft.id); } } },
            el('div', { class: 'vab-lc-name' }, s.craft.name),
            el('div', { class: 'vab-lc-desc' }, s.craft.description),
            el('div', { class: 'vab-lc-stats' },
              el('span', {}, icon('parts', 'vab-lc-ico'), `${s.stats.partCount} parts`),
              el('span', {}, icon('mass', 'vab-lc-ico'), fmtMass(s.stats.mass)),
              el('span', {}, icon('height', 'vab-lc-ico'), `${s.stats.height.toFixed(1)} m`),
              el('span', { class: 'accent' }, icon('dv', 'vab-lc-ico'), fmtDeltaV(s.dv)))));
        }
      } else if (!savedList.length) {
        content.appendChild(el('div', { class: 'vab-load-empty' }, 'No saved rockets yet. Build something and press Save!'));
      } else {
        for (const s of savedList) {
          const del = el('button', { class: 'tsp-btn small danger tsp-icon-btn', title: 'Delete', on: { click: async (e) => {
            e.stopPropagation();
            if (del.classList.contains('armed')) { onDelete(s.name); savedList = savedList.filter(x => x.name !== s.name); render(); }
            else { del.classList.add('armed'); del.title = 'Click again to delete'; setTimeout(() => del.classList.remove('armed'), 2500); }
          } } }, icon('trash'));
          content.appendChild(el('div', { class: 'vab-load-row', on: { click: () => { this.click(); closeFn?.(null); onLoadSaved(s.name); } } },
            el('div', {}, el('div', { class: 'vab-lc-name' }, s.name),
              el('div', { class: 'vab-lc-desc' }, s.corrupt ? 'Damaged save file — it cannot be loaded (delete it)' : `${s.partCount} parts · saved ${s.updated ? new Date(s.updated).toLocaleString() : 'some time ago'}`)),
            del));
        }
      }
    };
    render();
    const p = this.modal('Load Craft', body, [{ label: 'Close', value: null, kind: 'ghost' }], { wide: true });
    closeFn = this._lastModalClose;
    return p;
  }

  /** Brief feedback toast-like flash next to the cursor ("Can't attach here"). */
  flashAt(text, x, y, kind = 'bad') {
    const f = el('div', { class: `vab-flash ${kind}` }, text);
    f.style.left = `${x + 14}px`; f.style.top = `${y - 26}px`;
    this.root.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener('pointerdown', this._onDocDown, true);
    window.removeEventListener('pointermove', this._stageMove);
    window.removeEventListener('pointerup', this._stageUp);
    document.querySelectorAll('.vab-sicon-ghost').forEach(n => n.remove());
    this.root.remove();
  }
}

