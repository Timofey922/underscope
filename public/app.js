// Underscope demo page. Calls /api/vehicle, /api/grade-photos, /api/decode-codes and /api/decide.
// Deep links: /?vin=...&title=clean&codes=P0300,P0420&clean=18000&comps=6200,6900,7400&run=1  or  /?sample=front-hit
const PARTS = ['front_bumper', 'hood', 'grille', 'left_headlight', 'right_headlight', 'windshield', 'left_front_fender', 'right_front_fender', 'left_front_door', 'right_front_door', 'left_rear_door', 'right_rear_door', 'left_mirror', 'right_mirror', 'left_rear_quarter', 'right_rear_quarter', 'tailgate_or_rear_doors', 'rear_bumper', 'left_taillight', 'right_taillight', 'wheels_and_tires', 'roof', 'interior', 'engine_bay', 'underbody'];
const GRADE_ORDER = ['fine', 'repairable', 'replace', 'unknown'];
const GRADE_LABEL = { fine: 'Fine', repairable: 'Repairable', replace: 'Replace', unknown: 'Not visible' };
const TITLE_LABEL = { clean: 'Clean', salvage: 'Salvage', rebuilt: 'Rebuilt', flood: 'Flood', non_repairable: 'Non-repairable', lemon: 'Lemon buyback', unknown: 'Title not confirmed' };
const SOURCE_LABEL = { title_document: 'title document', dealer_listing: 'dealer listing', nmvtis_report: 'NMVTIS report' };
const CODE_SOURCE = { generic_table: 'code table', gemini: 'explained by Gemini for this make', unknown: 'meaning unknown for this make', invalid: 'not a valid code' };
const FLAG_LABEL = { airbags_deployed: 'Airbags deployed', frame_suspected: 'Frame damage', fluid_leak: 'Fluid leak' };
const ASSUME = [
  ['labor_rate', 'Labor ($/hr)', 95], ['daily_cost', 'Holding ($/day)', 20], ['fix_days', 'Days to fix + resell', 30], ['as_is_days', 'Days to sell as-is', 7],
  ['fix_selling_fee', 'Resale fee ($)', 450], ['as_is_fee', 'Auction fee ($)', 350], ['transport', 'Transport ($)', 150],
];
const CODE_RE = /^[PCBU][0-3][0-9A-F]{3}$/;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const MAX_PHOTOS = 30, LONG_SIDE = 1000, MAX_BYTES = 4_000_000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const label = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); }

let state = null;      // the checked vehicle; grades and flags stay editable
let preset = null;     // grades/flags from a sample vehicle (instead of photos)
let activeTab = 'repair';
let samples = {};

// ---------- Tag fields ----------
function tagField(box, input, hint, { normalize, valid, show, hintText }) {
  let items = [];
  const api = { onChange: () => {} };
  const render = () => {
    box.querySelectorAll('.tag').forEach((t) => t.remove());
    items.forEach((it, i) => {
      const t = document.createElement('span');
      t.className = 'tag' + (valid(it) ? '' : ' invalid');
      t.innerHTML = `${esc(show(it))}<button type="button" aria-label="Remove ${esc(show(it))}">×</button>`;
      t.querySelector('button').onclick = () => { items.splice(i, 1); render(); api.onChange(); };
      box.insertBefore(t, input);
    });
    const bad = items.filter((x) => !valid(x));
    hint.classList.toggle('bad', bad.length > 0);
    hint.textContent = hintText(bad);
  };
  const add = (text) => { text.split(/[\s,;]+/).map(normalize).filter(Boolean).forEach((x) => { if (!items.includes(x)) items.push(x); }); render(); api.onChange(); };
  input.addEventListener('keydown', (e) => {
    const v = e.target.value.trim();
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && v) { e.preventDefault(); add(v); e.target.value = ''; }
    else if (e.key === 'Enter') { e.preventDefault(); $('form').requestSubmit(); }
    else if (e.key === 'Backspace' && !v && items.length) { items.pop(); render(); api.onChange(); }
  });
  input.addEventListener('paste', (e) => { e.preventDefault(); add(e.clipboardData.getData('text')); });
  input.addEventListener('blur', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });
  box.addEventListener('click', (e) => { if (e.target === box) input.focus(); });
  Object.assign(api, { get: () => items.slice(), set: (xs) => { items = xs.map(normalize).filter(Boolean); render(); }, flush: () => { if (input.value.trim()) { add(input.value); input.value = ''; } } });
  render();
  return api;
}
const codes = tagField($('codes'), $('code-input'), $('codes-hint'), {
  normalize: (s) => String(s).trim().toUpperCase(), valid: (c) => CODE_RE.test(c), show: (c) => c,
  hintText: (bad) => bad.length ? `${bad.join(', ')}: codes start with P, C, B or U plus 4 characters.` : 'Enter after each code. Leave empty if none.',
});
const comps = tagField($('comps'), $('comp-input'), $('comps-hint'), {
  normalize: (s) => { const t = String(s).trim(); const n = Math.round(Number(t.replace(/[$,\s]/g, ''))); return n > 0 ? String(n) : t; },
  valid: (x) => /^\d+$/.test(x), show: (x) => /^\d+$/.test(x) ? money(+x) : x,
  hintText: (bad) => bad.length ? `${bad.join(', ')} isn't a dollar amount.` : '5 to 10 damaged lots of the same model and year.',
});

// ---------- Assumptions ----------
$('assume').innerHTML = ASSUME.map(([k, l, v]) => `<label>${esc(l)}<input id="a-${k}" inputmode="numeric" value="${v}"></label>`).join('');
const readAssumptions = () => Object.fromEntries(ASSUME.map(([k, , v]) => { const n = Number($(`a-${k}`).value); return [k, Number.isFinite(n) && n >= 0 ? n : v]; }));
const readValues = () => ({ clean_wholesale: Number(String($('clean').value).replace(/[$,\s]/g, '')) || undefined, salvage_comps: comps.get().filter((x) => /^\d+$/.test(x)).map(Number) });

// ---------- Title ----------
const TITLE_HINT = 'Non-repairable can\'t be fixed and resold. Flood and salvage lower the value after repair.';
const getTitle = () => (document.querySelector('input[name=title]:checked') || {}).value || 'unknown';
const setTitle = (v) => { const r = document.querySelector(`input[name=title][value="${v}"]`); if (r) r.checked = true; };
$('title-hint').textContent = TITLE_HINT;

// ---------- Photos ----------
let photos = [];
async function resize(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const s = Math.min(1, LONG_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  return c.toDataURL('image/jpeg', 0.82);
}
async function addPhotos(files) {
  const failed = [];
  for (const f of [...files]) {
    if (photos.length >= MAX_PHOTOS) { failed.push(`${f.name} (limit ${MAX_PHOTOS})`); continue; }
    try { photos.push({ name: f.name, dataUrl: await resize(f) }); } catch { failed.push(`${f.name} (use JPEG or PNG)`); }
  }
  preset = null; renderPhotos();
  if (failed.length) { $('photos-hint').classList.add('bad'); $('photos-hint').textContent = `Skipped ${failed.join('; ')}.`; }
}
const photoBytes = () => photos.reduce((n, p) => n + p.dataUrl.length, 0);
function renderPhotos() {
  const list = $('thumbs'); list.innerHTML = '';
  photos.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<img src="${p.dataUrl}" alt="Photo ${i + 1}: ${esc(p.name)}"><span class="n">${i + 1}</span><button type="button" aria-label="Remove photo ${i + 1}">×</button>`;
    li.querySelector('button').onclick = () => { photos.splice(i, 1); renderPhotos(); };
    list.appendChild(li);
  });
  const b = photoBytes(), size = b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
  const hint = $('photos-hint');
  hint.classList.toggle('bad', b > MAX_BYTES);
  hint.textContent = !photos.length ? 'Optional. Without photos, set part grades by hand in the results.'
    : b > MAX_BYTES ? `${photos.length} photos, ${size}: over the 4 MB limit, remove a few.`
    : `${photos.length} photo${photos.length === 1 ? '' : 's'}, ${size}.`;
}
$('photo-input').addEventListener('change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addPhotos([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))));
renderPhotos();

// ---------- VIN + registry ----------
const CLEAN_HINT = 'Same year, model and mileage, no damage, clean title.';
let registryVin = null;
$('vin').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  e.target.value = v;
  const hint = $('vin-hint'); hint.classList.remove('bad');
  hint.textContent = v.length === 0 ? "17 characters, on the dash or the driver's door jamb." : `${v.length} of 17`;
  if (VIN_RE.test(v)) checkRegistry(v); else showRegistry(null);
});
function showRegistry(rec) {
  const th = $('title-hint'), ch = $('clean-hint');
  th.classList.toggle('verified', !!rec); ch.classList.remove('verified');
  if (!rec) { th.textContent = TITLE_HINT; ch.textContent = CLEAN_HINT; return; }
  th.textContent = `Verified ${TITLE_LABEL[rec.title_status].toLowerCase()} title${rec.title_state ? ` (${rec.title_state})` : ''} from the ${SOURCE_LABEL[rec.source] || rec.source}.`;
  if (rec.clean_wholesale) { ch.classList.add('verified'); ch.textContent = 'Filled in from this vehicle\'s record.'; }
}
async function checkRegistry(vin) {
  registryVin = vin;
  try {
    const r = await fetch(`/api/vehicle?vin=${encodeURIComponent(vin)}`).then((x) => x.json());
    if (registryVin !== vin) return null;
    if (!r.registered) { showRegistry(null); return null; }
    setTitle(r.title_status);
    if (r.clean_wholesale) $('clean').value = r.clean_wholesale;
    if (r.salvage_comps && r.salvage_comps.length) comps.set(r.salvage_comps);
    showRegistry(r);
    return r;
  } catch { showRegistry(null); return null; }
}

// ---------- Samples ----------
function loadSample(v) {
  $('vin').value = v.vin; $('vin').dispatchEvent(new Event('input'));
  setTitle(v.title_status); codes.set(v.codes);
  $('clean').value = v.values.clean_wholesale; comps.set(v.values.salvage_comps);
  photos = []; renderPhotos();
  preset = { id: v.id, grades: v.grades, flags: v.flags };
  $('form').requestSubmit();
}
const samplesReady = fetch('/demo_vehicles.json').then((r) => r.json()).then(({ vehicles }) => {
  for (const v of vehicles) {
    samples[v.id] = v;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(v.label)}</td><td class="vin-cell">${esc(v.vin)}</td><td>${esc(TITLE_LABEL[v.title_status])}</td><td><button class="btn btn-ghost btn-sm" type="button">Open</button></td>`;
    tr.querySelector('button').onclick = () => loadSample(v);
    $('samples').appendChild(tr);
  }
}).catch(() => {});

$('clear').onclick = () => {
  $('vin').value = ''; $('vin').dispatchEvent(new Event('input'));
  codes.set([]); comps.set([]); $('clean').value = ''; photos = []; renderPhotos(); setTitle('unknown');
  preset = null; state = null; $('result').hidden = true; $('empty').hidden = false;
  history.replaceState(null, '', '/'); $('vin').focus();
};

// ---------- Run ----------
async function readPhotoResult(res) {
  if (res === null) return null;
  if (res instanceof Error) return { error: `Photo upload failed: ${res.message}` };
  if (res.status === 404) return { error: "Photo grading isn't available on this deployment." };
  if (res.status === 413) return { error: 'Photos too large to upload together. Remove a few.' };
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !Array.isArray(body.parts)) return { error: (body && body.error) || `Photo grading answered ${res.status}.` };
  return { data: body };
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  codes.flush(); comps.flush();
  const vin = $('vin').value.trim();
  if (!VIN_RE.test(vin)) {
    const hint = $('vin-hint'); hint.classList.add('bad');
    hint.textContent = /[IOQ]/.test(vin) ? 'VINs never use I, O or Q. Check for a 1 or a 0.' : `${vin.length} characters; a VIN has 17.`;
    $('vin').focus(); return;
  }
  if (photoBytes() > MAX_BYTES) { $('drop').scrollIntoView({ block: 'center' }); return; }
  $('go').disabled = true; $('go').textContent = photos.length ? 'Grading photos…' : 'Running…';
  try {
    const [cRes, pRes] = await Promise.all([
      post('/api/decode-codes', { vin, codes: codes.get(), title_status: getTitle() }),
      photos.length ? post('/api/grade-photos', { vin, photos: photos.map((p) => p.dataUrl) }).catch((x) => x) : null,
    ]);
    const c = await cRes.json().catch(() => ({}));
    if (!cRes.ok) throw new Error(c.error || `The server answered ${cRes.status}.`);
    const photo = await readPhotoResult(pRes);
    const grades = new Map();
    if (photo && photo.data) photo.data.parts.forEach((p) => grades.set(p.part, { grade: p.grade, photo: p.evidence_photo, edited: false }));
    PARTS.forEach((p) => { if (!grades.has(p)) grades.set(p, { grade: preset ? (preset.grades[p] || 'fine') : 'unknown', photo: null, edited: false }); });
    const flags = photo && photo.data ? { ...photo.data.flags } : preset ? { ...preset.flags } : { airbags_deployed: 'unknown', frame_suspected: 'unknown', fluid_leak: 'unknown' };
    const gradeNote = photo && photo.data ? null
      : photo && photo.error ? `${photo.error} Set grades by hand below.`
      : preset ? 'Sample grades, standing in for graded photos.'
      : 'No photos, so every part starts as not visible. Click a grade to set it.';
    state = { vin, codes: c, photo, grades, flags, gradeNote, photoGaps: photo && photo.data ? photo.data.photo_gaps : [], sampleId: preset && preset.id };
    activeTab = 'repair';
    await recompute(true);
  } catch (err) {
    $('empty').hidden = true; $('result').hidden = false;
    $('result').innerHTML = `<div class="error-box"><h3>Couldn't check this vehicle</h3><p>${esc(err.message)} Try again or open a sample.</p></div>`;
  } finally {
    $('go').disabled = false; $('go').textContent = 'Run check';
  }
});

let pending = 0;
async function recompute(first = false) {
  if (!state) return;
  const ticket = ++pending;
  const body = {
    title_status: state.codes.title_status,
    grades: [...state.grades].map(([part, g]) => ({ part, grade: g.grade })),
    flags: state.flags,
    codes: state.codes.codes.filter((c) => c.source !== 'invalid'),
    values: readValues(),
    assumptions: readAssumptions(),
  };
  const d = await post('/api/decide', body).then((r) => r.json());
  if (ticket !== pending) return;
  render(d, first);
}
let debounce;
const recomputeSoon = () => { clearTimeout(debounce); debounce = setTimeout(() => recompute(false), 250); };
$('clean').addEventListener('input', recomputeSoon);
$('assume').addEventListener('input', recomputeSoon);
comps.onChange = recomputeSoon;

// Reviewer toggle, tabs, copy link
$('result').addEventListener('click', (e) => {
  const pb = e.target.closest('[data-part]'), fb = e.target.closest('[data-flag]'), tb = e.target.closest('[data-tab]'), cl = e.target.closest('[data-copy]');
  if (pb && state) { const g = state.grades.get(pb.dataset.part); g.grade = GRADE_ORDER[(GRADE_ORDER.indexOf(g.grade) + 1) % GRADE_ORDER.length]; g.edited = true; recompute(false); }
  else if (fb && state) { const order = [true, false, 'unknown'], k = fb.dataset.flag; state.flags[k] = order[(order.indexOf(state.flags[k]) + 1) % order.length]; recompute(false); }
  else if (tb) { activeTab = tb.dataset.tab; document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === activeTab))); document.querySelectorAll('.tabpanel').forEach((p) => p.hidden = p.id !== `tab-${activeTab}`); }
  else if (cl) { copyLink(); }
});

function shareUrl() {
  const u = new URL('/', location.origin);
  if (state.sampleId) { u.searchParams.set('sample', state.sampleId); return u.toString(); }
  u.searchParams.set('vin', state.vin);
  const reg = state.codes.title_source && state.codes.title_source.from === 'registry';
  if (!reg && state.codes.title_status !== 'unknown') u.searchParams.set('title', state.codes.title_status);
  const cs = codes.get(); if (cs.length) u.searchParams.set('codes', cs.join(','));
  const v = readValues();
  if (!reg && v.clean_wholesale) u.searchParams.set('clean', v.clean_wholesale);
  if (!reg && v.salvage_comps.length) u.searchParams.set('comps', v.salvage_comps.join(','));
  u.searchParams.set('run', '1');
  return u.toString();
}
async function copyLink() {
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
}

// ---------- Render ----------
function vehicleName() {
  const v = state.codes.vehicle;
  const make = v.make && (v.make.length <= 3 ? v.make : v.make.replace(/\B\w+/g, (m) => m.toLowerCase()));
  return [v.year, make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle';
}
function titleBadge() {
  const r = state.codes, t = r.title_status, reg = r.title_source && r.title_source.from === 'registry';
  const cls = t === 'clean' ? 'ok' : t === 'unknown' ? 'warn' : 'bad';
  const where = reg ? `, verified (${SOURCE_LABEL[r.title_source.source] || r.title_source.source})` : t !== 'unknown' ? ', seller entered' : '';
  return `<span class="badge ${cls}">${esc(TITLE_LABEL[t] || t)}${r.title_source && r.title_source.title_state ? ` (${esc(r.title_source.title_state)})` : ''}${esc(where)}</span>`;
}

function recBlock(d, first) {
  const pct = d.p_fix == null ? null : Math.round(d.p_fix * 100);
  const V = {
    fix: ['on-green', '✓', 'Fix it, then sell', pct === 100 ? 'Fixing came out ahead in all 1,000 simulated outcomes.' : `Fixing came out ahead in ${pct}% of 1,000 simulated outcomes.`],
    sell_as_is: ['on-red', '!', 'Sell it as-is', pct === 0 ? 'Selling as-is came out ahead in all 1,000 simulated outcomes.' : `Fixing came out ahead in only ${pct}% of 1,000 simulated outcomes.`],
    too_close: ['on-amber', '?', 'Too close to call', `Fixing came out ahead in ${pct}% of 1,000 simulated outcomes; the ranges overlap too much to choose.`],
    not_fixable: ['on-red', '!', 'Sell it as-is', 'A non-repairable title means it can\'t be registered again after repair.'],
  }[d.verdict] || ['', '–', 'Needs market values', `Add ${d.missing.join(' and ')} on the left.`];
  const check = d.check ? `<p class="check"><b>Check before deciding:</b> ${esc(d.check.label)}. If it comes back clean, fixing wins ${Math.round(d.check.p_fix_if_resolved * 100)}% of the time.</p>` : '';
  return `<div class="rec"><div class="lamp ${V[0]}${first ? ' ignite' : ''}" aria-hidden="true">${V[1]}</div><div><h3>${esc(V[2])}</h3><p class="why">${esc(V[3])}</p>${check}</div></div>`;
}

function rangesBlock(d) {
  if (!d.as_is_net) return '';
  const rows = [d.fix_net && ['Fix and resell', 'fix', d.fix_net, d.days.fix], ['Sell as-is', 'sell', d.as_is_net, d.days.as_is]].filter(Boolean);
  const min = Math.min(...rows.map((r) => r[2].low)), max = Math.max(...rows.map((r) => r[2].high));
  const pad = (max - min) * 0.04 || 1, lo = min - pad, hi = max + pad, x = (v) => ((v - lo) / (hi - lo)) * 100;
  const fixWins = d.verdict === 'fix', sellWins = d.verdict === 'sell_as_is' || d.verdict === 'not_fixable';
  return `<div class="ranges">${rows.map(([name, cls, n, days]) => `
    <div class="rrow${(cls === 'fix' && fixWins) || (cls === 'sell' && sellWins) ? ' win' : ''}">
      <span class="name">${name}</span>
      <div class="track" aria-hidden="true">
        ${lo < 0 && hi > 0 ? `<span class="zero" style="left:${x(0)}%"></span>` : ''}
        <span class="whisker" style="left:${x(n.low)}%;width:${x(n.high) - x(n.low)}%"></span>
        <span class="bar ${cls}" style="left:${x(n.p10)}%;width:${Math.max(0.8, x(n.p90) - x(n.p10))}%"></span>
        <span class="mid" style="left:calc(${x(n.p50)}% - 1px)"></span>
      </div>
      <span class="nums"><b>${money(n.p10)} to ${money(n.p90)}</b>net, typically ${money(n.p50)}, ~${days} days</span>
    </div>`).join('')}
    <p class="scale-note">Bar: middle 80% of outcomes. Line: full range. Tick: typical.</p></div>`;
}

function repairTab(d) {
  const r = d.repair, a = d.assumptions, t = state.codes.title_status, td = d.arv && d.arv.title_discount;
  const rows = r.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="amt">${money(l.low)} to ${money(l.high)}</td></tr>`).join('')
    || '<tr><td>No damaged parts or fault codes</td><td class="amt">$0</td></tr>';
  const widen = r.widen.map((w) => `<tr class="widen"><td>${esc(w.reason)} (could cost more)</td><td class="amt">+${money(w.amount)}</td></tr>`).join('');
  const titleNote = td && td[1] > 0 ? `${Math.round(td[0] * 100)}–${Math.round(td[1] * 100)}% off for ${t === 'unknown' ? 'an unconfirmed' : `a ${TITLE_LABEL[t].toLowerCase()}`} title` : 'no title discount';
  return `<p class="tab-note">Parts plus labor at ${money(a.labor_rate)}/hr, paint where a panel needs it, plus fault-code repairs.</p>
    <table class="lines"><tbody>${rows}${widen}<tr class="total"><td>Repair estimate</td><td class="amt">${money(r.low)} to ${money(r.high)}</td></tr></tbody></table>
    <dl class="facts">
      ${d.arv ? `<div class="fact"><dt>Value after repair</dt><dd>${money(d.arv.low)} to ${money(d.arv.high)}<small>Clean wholesale less 5–12% for condition, ${esc(titleNote)}</small></dd></div>` : ''}
      ${d.as_is ? `<div class="fact"><dt>Value as-is</dt><dd>${money(d.as_is.low)} to ${money(d.as_is.high)}<small>Range of ${d.as_is.comps} salvage comps</small></dd></div>` : ''}
      <div class="fact"><dt>Costs to sell</dt><dd>${money(a.fix_selling_fee)} + ${money(a.daily_cost)}/day<small>After repair. As-is: ${money(a.as_is_fee)} fee + ${money(a.transport)} transport</small></dd></div>
    </dl>`;
}

function conditionTab() {
  const counts = {}; state.grades.forEach((g) => counts[g.grade] = (counts[g.grade] || 0) + 1);
  const yn = (v) => v === true ? 'Yes' : v === false ? 'No' : 'Unknown';
  const gaps = (state.photoGaps || []).length ? `<p class="tab-note" style="margin-top:12px">Missing angles: ${esc(state.photoGaps.join('; '))}</p>` : '';
  return `${state.gradeNote ? `<p class="notice">${esc(state.gradeNote)}</p>` : ''}
    <p class="tab-note">${counts.replace || 0} replace, ${counts.repairable || 0} repairable, ${counts.unknown || 0} not visible. Click a grade or flag to change it.</p>
    <ul class="parts">${[...state.grades].map(([part, g]) => `
      <li class="g-${g.grade}"><button type="button" data-part="${part}" class="${g.edited ? 'edited' : ''}" aria-label="${esc(label(part))}: ${GRADE_LABEL[g.grade]}. Click to change.">
        <span class="dot" aria-hidden="true"></span><span>${esc(label(part))}${g.photo ? ` <span class="ph">#${g.photo}</span>` : ''}</span><span class="grade">${GRADE_LABEL[g.grade]}${g.edited ? '*' : ''}</span>
      </button></li>`).join('')}</ul>
    <div class="flags">${Object.keys(FLAG_LABEL).map((k) => `<button type="button" data-flag="${k}" class="${state.flags[k] === true ? 'yes' : ''}">${FLAG_LABEL[k]}: <b>${yn(state.flags[k])}</b></button>`).join('')}</div>${gaps}`;
}

function codesTab() {
  const r = state.codes;
  if (!r.codes.length) return '<p class="tab-note">No codes from the scan tool.</p>';
  const sev = (s) => s[0].toUpperCase() + s.slice(1);
  const inspect = r.triage === 'full_inspection' ? 'A full inspection is worth paying for.' : `A full inspection isn't worth paying for: ${r.reason.replace(/^Skip inspection:\s*/, '')}`;
  return `<p class="tab-note">${r.summary.count} code${r.summary.count === 1 ? '' : 's'}, ${money(r.summary.cost_low)} to ${money(r.summary.cost_high)} in the repair estimate. ${esc(inspect)}</p>
    <ul class="codelist">${r.codes.map((c) => `
      <li class="sev-${esc(c.severity)}"><span class="code">${esc(c.code)}</span><span class="desc">${c.description === 'unknown' ? 'Meaning unknown' : esc(c.description)}</span>
        <span class="cost">${c.source === 'invalid' ? '' : `${money(c.cost_low)} to ${money(c.cost_high)}`}</span>
        <span class="meta">${esc(sev(c.severity))}, ${esc(c.system)}, ${esc(CODE_SOURCE[c.source] || c.source)}</span></li>`).join('')}</ul>`;
}

function render(d, first) {
  const out = $('result');
  $('empty').hidden = true; out.hidden = false;
  const unknownCount = [...state.grades.values()].filter((g) => g.grade === 'unknown').length;
  const tabs = [['repair', 'Repair estimate', null], ['condition', 'Condition', unknownCount ? `${unknownCount} unseen` : null], ['codes', 'Fault codes', state.codes.summary.count || null], ['api', 'API response', null]];
  const engine = state.codes.vehicle.engine ? `<span class="vin-code">${esc(state.codes.vehicle.engine)}</span>` : '';
  out.innerHTML = `
    <div class="vehbar"><h2>${esc(vehicleName())}</h2><span class="vin-code">${esc(state.vin)}</span>${engine}${titleBadge()}<span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-copy>Copy link</button></div>
    ${recBlock(d, first)}${rangesBlock(d)}
    <div class="tabs" role="tablist">${tabs.map(([id, name, n]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === activeTab}">${name}${n ? `<span class="count">${esc(n)}</span>` : ''}</button>`).join('')}</div>
    <div class="tabpanel" id="tab-repair" ${activeTab === 'repair' ? '' : 'hidden'}>${repairTab(d)}</div>
    <div class="tabpanel" id="tab-condition" ${activeTab === 'condition' ? '' : 'hidden'}>${conditionTab()}</div>
    <div class="tabpanel" id="tab-codes" ${activeTab === 'codes' ? '' : 'hidden'}>${codesTab()}</div>
    <div class="tabpanel" id="tab-api" ${activeTab === 'api' ? '' : 'hidden'}><pre>${esc(JSON.stringify({ decision: d, codes: state.codes, photos: state.photo && state.photo.data }, null, 2))}</pre></div>`;
  if (first) {
    history.replaceState(null, '', shareUrl().replace(location.origin, ''));
    if (matchMedia('(max-width: 980px)').matches) out.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  }
}

// ---------- Deep links ----------
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get('sample')) { await samplesReady; const v = samples[q.get('sample')]; if (v) loadSample(v); return; }
  const vin = (q.get('vin') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!vin) return;
  $('vin').value = vin; $('vin').dispatchEvent(new Event('input'));
  if (VIN_RE.test(vin)) await checkRegistry(vin);
  if (q.get('title')) setTitle(q.get('title'));
  if (q.get('codes')) codes.set(q.get('codes').split(','));
  if (q.get('clean')) $('clean').value = q.get('clean');
  if (q.get('comps')) comps.set(q.get('comps').split(','));
  if (q.get('run') === '1' && VIN_RE.test(vin)) $('form').requestSubmit();
})();
