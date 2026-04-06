/**
 * app.js  Explore & Exploit Terminal
 * Student names: Kristers Krīgers, Edvards Markuss Selikovs, Kristofers Sondors
 *
 * Algorithm:
 *  Exploration (200 calls):
 *    Phase 1: 1010 coarse grid        100 calls
 *    Phase 2: Top-5 hotspot zoom        ~50 calls
 *    Phase 3: Dense patch around best   ~50 calls
 *
 *  Exploitation (10 calls, integer coords, 1 steps):
 *    Start at best integer point found in exploration.
 *    At each step, use IDW interpolation over all explored data
 *    to rank unvisited 8-directional neighbors, then move to the
 *    best predicted neighbor and confirm with a real API call.
 *    2026 RULE: no square may be revisited.
 */

'use strict';

/* 
   CONFIG
 */
const API_BASE = 'http://157.180.73.240';
const LOCAL_PROXY_BASE = 'http://localhost:8787';
const USE_LOCAL_PROXY = true;
const API_CALL_DELAY_MS = 0; // Change delay here (UI control removed)

const PORTS = {
  test: [8080, 8081, 8082],
  exam: [22001, 22002, 22003, 22004, 22005],
};

const EXPLORE_BUDGET = 200;
const EXPLOIT_STEPS  = 10;
const XY_RANGE       = { min: -100, max: 100 };

/* 
   STATE
 */
const state = {
  port:             8080,
  callDelay:        API_CALL_DELAY_MS, // ms between API calls
  explored:         [],         // { x, y, z }[]
  exploitPath:      [],         // { x, y, z }[]
  visitedKeys:      new Set(),  // "x,y" for integer squares
  explorationDone:  false,
  exploitationDone: false,
  running:          false,
  totalCallCount:   0,
  logEntries:       [],         // { ts, type, msg }[]
};

/* 
   UTILITIES
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Clamp a value to [XY_RANGE.min, XY_RANGE.max] */
const clamp = v => Math.max(XY_RANGE.min, Math.min(XY_RANGE.max, v));

/** Integer key for the visited-squares set */
const iKey = (x, y) => `${Math.round(x)},${Math.round(y)}`;

/** String key used to deduplicate float-valued exploration samples */
const fKey = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;

/* 
   API LAYER
 */
/**
 * Query the API at (x, y).
 * Returns the numeric z-score.
 * Throws 'CORS_ERROR' string on CORS failure.
 */
async function queryAPI(x, y) {
  const url = USE_LOCAL_PROXY
    ? `${LOCAL_PROXY_BASE}/${state.port}/${x}/${y}`
    : `${API_BASE}:${state.port}/${x}/${y}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('application/json')) {
      const data = await res.json();
      const raw = typeof data === 'number' ? data : data?.z;
      const val = parseFloat(String(raw));
      if (isNaN(val)) throw new Error(`Non-numeric JSON response: "${JSON.stringify(data)}"`);
      return val;
    }

    const text = await res.text();
    const val = parseFloat(text.trim());
    if (isNaN(val)) throw new Error(`Non-numeric response: "${text}"`);
    return val;
  } catch (err) {
    // Distinguish CORS / network errors from server errors
    if (
      err instanceof TypeError ||
      err.message.includes('Failed to fetch') ||
      err.message.includes('NetworkError')
    ) {
      throw new Error('CORS_ERROR');
    }
    throw err;
  }
}

/* 
   IDW INTERPOLATION
   Inverse Distance Weighting with k nearest neighbours
 */
/**
 * Estimate z at (x, y) using the explored dataset.
 * @param {number} x
 * @param {number} y
 * @param {Array}  points  - explored data {x,y,z}[]
 * @param {number} k       - number of nearest neighbours to use
 * @param {number} power   - distance weighting exponent (2 = classic IDW)
 */
function estimateZ(x, y, points, k = 15, power = 2) {
  if (points.length === 0) return 0;

  // Squared distances (skip sqrt for speed; we only need ordering)
  const ranked = points
    .map(p => ({ p, d2: (p.x - x) ** 2 + (p.y - y) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, Math.min(k, points.length));

  // Exact hit
  if (ranked[0].d2 < 1e-9) return ranked[0].p.z;

  let wSum = 0, zSum = 0;
  for (const { p, d2 } of ranked) {
    const w = 1 / Math.pow(d2, power / 2);
    wSum += w;
    zSum += w * p.z;
  }
  return zSum / wSum;
}

/* 
   EXPLORATION
 */
/**
 * Main exploration routine.
 * Runs up to EXPLORE_BUDGET API calls in 3 phases.
 */
async function runExploration() {
  if (state.running) return;
  state.running          = true;
  state.explorationDone  = false;
  state.exploitationDone = false;
  state.explored         = [];
  state.exploitPath      = [];
  state.visitedKeys      = new Set();
  state.totalCallCount   = 0;

  const sampledSet = new Set(); // prevent duplicate float queries
  let callCount = 0;

  setStatus('running');
  setBtnState(false, false);
  showProgress(true);
  updateProgress('PHASE 1', callCount, EXPLORE_BUDGET);
  clearPathTable();

  /**
   * Internal: sample one point and store result.
   * Returns the point object or null if skipped / errored.
   */
  async function sample(rawX, rawY) {
    if (callCount >= EXPLORE_BUDGET) return null;

    const x = parseFloat(clamp(rawX).toFixed(2));
    const y = parseFloat(clamp(rawY).toFixed(2));
    const key = fKey(x, y);

    if (sampledSet.has(key)) return null;
    sampledSet.add(key);
    callCount++;

    updateProgress(null, callCount, EXPLORE_BUDGET);

    try {
      const z = await queryAPI(x, y);
      const pt = { x, y, z };
      state.explored.push(pt);
      logExplore(callCount, x, y, z);

      // Re-render heatmap every 5 points during exploration (performance)
      if (callCount % 5 === 0 || callCount <= 10) renderHeatmap();

      await sleep(state.callDelay);
      return pt;
    } catch (err) {
      if (err.message === 'CORS_ERROR') {
        document.getElementById('cors-notice').style.display = 'block';
        state.running = false;
        setStatus('error');
        setBtnState(true, false);
        throw err;
      }
      log(`[ERROR] (${x},${y}): ${err.message}`, 'error');
      return null;
    }
  }

  try {
    /*  Phase 1: 1010 coarse grid  */
    log('[PHASE 1] 10x10 coarse grid (100 calls)...', 'phase');
    const coarse = [-90, -70, -50, -30, -10, 10, 30, 50, 70, 90];
    for (const x of coarse) {
      for (const y of coarse) {
        await sample(x, y);
      }
    }

    /*  Phase 2: Zoom into top-5 hotspots  */
    log('[PHASE 2] Refining top-5 hotspots (~50 calls)...', 'phase');
    updateProgress('PHASE 2', callCount, EXPLORE_BUDGET);

    // Collect hotspots that are well-separated (> 25 units apart)
    const phase1Sorted = [...state.explored].sort((a, b) => b.z - a.z);
    const hotspots = [];
    for (const p of phase1Sorted) {
      const tooClose = hotspots.some(
        h => Math.hypot(h.x - p.x, h.y - p.y) < 25
      );
      if (!tooClose) {
        hotspots.push(p);
        if (hotspots.length >= 5) break;
      }
    }

    // For each hotspot: sample a 33 ring at 6, 3 offsets
    const phase2Offsets = [
      [-6,-6],[-6, 0],[-6, 6],
      [ 0,-6],         [ 0, 6],
      [ 6,-6],[ 6, 0],[ 6, 6],
      [-3,-3],[-3, 3],[ 3,-3],[ 3, 3],  // diagonals closer in
    ];
    for (const h of hotspots) {
      for (const [dx, dy] of phase2Offsets) {
        if (callCount >= 150) break;
        await sample(h.x + dx, h.y + dy);
      }
      if (callCount >= 150) break;
    }

    /*  Phase 3: Dense patch around global best  */
    log('[PHASE 3] Dense local search around global best (~50 calls)...', 'phase');
    updateProgress('PHASE 3', callCount, EXPLORE_BUDGET);

    // Re-find global best (including phase 2 data)
    const globalBest = state.explored.reduce(
      (best, p) => (p.z > best.z ? p : best)
    );

    // 77 grid with step 3, centered on globalBest
    const step3 = 3;
    for (let dx = -9; dx <= 9; dx += step3) {
      for (let dy = -9; dy <= 9; dy += step3) {
        if (callCount >= EXPLORE_BUDGET) break;
        await sample(globalBest.x + dx, globalBest.y + dy);
      }
      if (callCount >= EXPLORE_BUDGET) break;
    }

    // Fill remaining budget with random points near best (up to 200)
    let attempts = 0;
    while (callCount < EXPLORE_BUDGET && attempts < 100) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 15 + 2;
      await sample(
        globalBest.x + Math.cos(angle) * radius,
        globalBest.y + Math.sin(angle) * radius
      );
    }

    /*  Done  */
    renderHeatmap();
    state.explorationDone = true;
    state.running = false;
    setStatus('done');
    setBtnState(true, true);
    showProgress(false);

    const peak = state.explored.reduce((best, p) => (p.z > best.z ? p : best));
    log(`[COMPLETE] ${state.explored.length} points sampled.`, 'success');
    log(
      `[PEAK] (${peak.x}, ${peak.y}) -> z = ${peak.z.toFixed(4)}`,
      'highlight'
    );
    updateBestPoint(peak);
    updateExportButtons();
    updateCanvasInfo();

  } catch (err) {
    // CORS or unexpected error  already handled in sample()
    if (err.message !== 'CORS_ERROR') {
      log(`[FATAL] ${err.message}`, 'error');
      setStatus('error');
    }
    state.running = false;
    showProgress(false);
    setBtnState(true, false);
  }
}

/* 
   EXPLOITATION
 */
/**
 * Greedy 10-step exploitation.
 * Uses IDW estimates from explored data to rank unvisited neighbours,
 * queries the best predicted neighbour at each step (1 call/step).
 * Strictly enforces the 2026 no-revisit rule.
 */
async function runExploitation() {
  if (!state.explorationDone || state.running) return;
  state.running          = true;
  state.exploitationDone = false;
  state.exploitPath      = [];
  state.visitedKeys      = new Set();

  setStatus('running');
  setBtnState(false, false);
  clearPathTable();

  try {
    /*  Find best integer starting point  */
    // Check 55 integer neighborhood around the best float point
    const floatBest = state.explored.reduce((b, p) => (p.z > b.z ? p : b));
    const cx0 = Math.round(floatBest.x);
    const cy0 = Math.round(floatBest.y);

    let startX = cx0, startY = cy0;
    let startEst = estimateZ(cx0, cy0, state.explored);

    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const est = estimateZ(cx0 + dx, cy0 + dy, state.explored);
        if (est > startEst) {
          startEst = est;
          startX = cx0 + dx;
          startY = cy0 + dy;
        }
      }
    }

    log(`[EXPLOIT] Starting at integer (${startX}, ${startY}) - est z = ${startEst.toFixed(4)}`, 'phase');

    /*  Step 0: Query starting point  */
    const z0 = await queryAPI(startX, startY);
    const step0 = { x: startX, y: startY, z: z0 };
    state.exploitPath.push(step0);
    state.visitedKeys.add(iKey(startX, startY));
    log(`[STEP 0] (${startX}, ${startY}) -> z = ${z0.toFixed(4)}`, 'exploit');
    appendPathRow(0, step0);
    renderHeatmap();
    await sleep(state.callDelay);

    /*  Steps 19: Greedy walk  */
    for (let step = 1; step < EXPLOIT_STEPS; step++) {
      const cur = state.exploitPath[state.exploitPath.length - 1];

      // Build candidate list: 8 directional neighbours, unvisited
      const candidates = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          // Skip out-of-bounds
          if (nx < XY_RANGE.min || nx > XY_RANGE.max) continue;
          if (ny < XY_RANGE.min || ny > XY_RANGE.max) continue;
          const key = iKey(nx, ny);
          if (!state.visitedKeys.has(key)) {
            candidates.push({ x: nx, y: ny, est: estimateZ(nx, ny, state.explored) });
          }
        }
      }

      if (candidates.length === 0) {
        log(`[WARN] No unvisited neighbours at step ${step} - stopping early.`, 'warning');
        break;
      }

      // Sort by estimated z descending; pick the best
      candidates.sort((a, b) => b.est - a.est);
      const best = candidates[0];

      const realZ = await queryAPI(best.x, best.y);
      const pt = { x: best.x, y: best.y, z: realZ };
      state.exploitPath.push(pt);
      state.visitedKeys.add(iKey(best.x, best.y));

      log(
        `[STEP ${step}] (${best.x}, ${best.y}) -> z = ${realZ.toFixed(4)}` +
        `  [est: ${best.est.toFixed(4)}]`,
        'exploit'
      );
      appendPathRow(step, pt);
      renderHeatmap();
      await sleep(state.callDelay);
    }

    /*  Final total  */
    const total = state.exploitPath.reduce((s, p) => s + p.z, 0);
    log(`[RESULT] ${state.exploitPath.length} steps | SUM = ${total.toFixed(4)}`, 'success');
    showTotalSum(total);
    updateExportButtons();

    state.exploitationDone = true;
    state.running = false;
    setStatus('done');
    setBtnState(true, true);

  } catch (err) {
    if (err.message === 'CORS_ERROR') {
      document.getElementById('cors-notice').style.display = 'block';
    } else {
      log(`[FATAL] ${err.message}`, 'error');
    }
    setStatus('error');
    state.running = false;
    setBtnState(true, state.explorationDone);
  }
}

/* 
   HEATMAP RENDERING
 */
const CANVAS_PAD = { l: 52, r: 38, t: 18, b: 38 };

/** Map data coordinate x  canvas pixel x */
function mapX(x, W) {
  const pw = W - CANVAS_PAD.l - CANVAS_PAD.r;
  return CANVAS_PAD.l + (x - XY_RANGE.min) / (XY_RANGE.max - XY_RANGE.min) * pw;
}

/** Map data coordinate y  canvas pixel y (y-axis inverted) */
function mapY(y, H) {
  const ph = H - CANVAS_PAD.t - CANVAS_PAD.b;
  return H - CANVAS_PAD.b - (y - XY_RANGE.min) / (XY_RANGE.max - XY_RANGE.min) * ph;
}

/**
 * Convert normalised value t  [0,1] to an RGB heat colour.
 * Palette: deep-blue  cyan  green  yellow  orange  red
 */
function heatColor(t, alpha = 1) {
  const stops = [
    { p: 0.00, r: 8,   g: 8,   b: 60  },
    { p: 0.15, r: 10,  g: 30,  b: 190 },
    { p: 0.32, r: 0,   g: 160, b: 200 },
    { p: 0.52, r: 20,  g: 210, b: 80  },
    { p: 0.68, r: 220, g: 220, b: 0   },
    { p: 0.82, r: 255, g: 100, b: 0   },
    { p: 1.00, r: 255, g: 0,   b: 0   },
  ];

  t = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].p <= t) i++;

  const s0 = stops[i], s1 = stops[i + 1];
  const lt  = (t - s0.p) / (s1.p - s0.p);
  const r = Math.round(s0.r + lt * (s1.r - s0.r));
  const g = Math.round(s0.g + lt * (s1.g - s0.g));
  const b = Math.round(s0.b + lt * (s1.b - s0.b));

  return alpha < 1
    ? `rgba(${r},${g},${b},${alpha})`
    : `rgb(${r},${g},${b})`;
}

let lastRenderCount = 0;

function renderHeatmap() {
  const canvas = document.getElementById('heatmap');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PW = W - CANVAS_PAD.l - CANVAS_PAD.r;
  const PH = H - CANVAS_PAD.t - CANVAS_PAD.b;

  const pts = state.explored;
  const zs  = pts.map(p => p.z);
  const zMin = zs.length ? Math.min(...zs) : 0;
  const zMax = zs.length ? Math.max(...zs) : 1;
  const zRng = Math.max(zMax - zMin, 1e-6);

  const norm = z => (z - zMin) / zRng;

  //  1. Background 
  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, W, H);

  //  2. IDW interpolation background grid 
  if (pts.length >= 10) {
    const GRID = pts.length >= 60 ? 70 : 35;
    const cw = PW / GRID, ch = PH / GRID;

    for (let gi = 0; gi < GRID; gi++) {
      for (let gj = 0; gj < GRID; gj++) {
        const px = CANVAS_PAD.l + (gi + 0.5) * cw;
        const py = CANVAS_PAD.t + (gj + 0.5) * ch;
        // Map pixel back to data space
        const dx = XY_RANGE.min + (px - CANVAS_PAD.l) / PW * (XY_RANGE.max - XY_RANGE.min);
        const dy = XY_RANGE.min + (H - CANVAS_PAD.b - py) / PH * (XY_RANGE.max - XY_RANGE.min);
        const ez = estimateZ(dx, dy, pts, 8);
        const t  = norm(ez);
        ctx.fillStyle = heatColor(t, 0.75);
        ctx.fillRect(CANVAS_PAD.l + gi * cw, CANVAS_PAD.t + gj * ch, cw + 0.5, ch + 0.5);
      }
    }
  }

  //  3. Grid lines 
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 0.5;
  for (let v = -100; v <= 100; v += 10) {
    ctx.beginPath();
    ctx.moveTo(mapX(v, W), CANVAS_PAD.t);
    ctx.lineTo(mapX(v, W), H - CANVAS_PAD.b);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CANVAS_PAD.l, mapY(v, H));
    ctx.lineTo(W - CANVAS_PAD.r, mapY(v, H));
    ctx.stroke();
  }

  // Major axes (x=0, y=0)  brighter
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mapX(0, W), CANVAS_PAD.t); ctx.lineTo(mapX(0, W), H - CANVAS_PAD.b); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(CANVAS_PAD.l, mapY(0, H)); ctx.lineTo(W - CANVAS_PAD.r, mapY(0, H)); ctx.stroke();
  ctx.restore();

  //  4. Plot border 
  ctx.strokeStyle = '#1a2d3f';
  ctx.lineWidth = 1;
  ctx.strokeRect(CANVAS_PAD.l, CANVAS_PAD.t, PW, PH);

  //  5. Axis labels 
  ctx.fillStyle = 'rgba(200,214,229,0.45)';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'center';
  [-100, -50, 0, 50, 100].forEach(v => {
    ctx.fillText(v, mapX(v, W), H - CANVAS_PAD.b + 14);
  });
  ctx.textAlign = 'right';
  [-100, -50, 0, 50, 100].forEach(v => {
    ctx.fillText(v, CANVAS_PAD.l - 4, mapY(v, H) + 4);
  });

  // Axis titles
  ctx.fillStyle = 'rgba(200,214,229,0.35)';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.fillText('X', W / 2, H - 3);
  ctx.save();
  ctx.translate(10, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Y', 0, 0);
  ctx.restore();

  //  6. Explored points (bright white dots) 
  pts.forEach(p => {
    const px = mapX(p.x, W), py = mapY(p.y, H);
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  //  7. Exploitation path 
  const ep = state.exploitPath;
  if (ep.length > 0) {
    // Glowing connecting line
    ctx.save();
    ctx.shadowColor  = '#00d4aa';
    ctx.shadowBlur   = 12;
    ctx.strokeStyle  = '#00d4aa';
    ctx.lineWidth    = 2;
    ctx.lineJoin     = 'round';
    ctx.beginPath();
    ep.forEach((p, i) => {
      const px = mapX(p.x, W), py = mapY(p.y, H);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();

    // Step circles with numbers
    ep.forEach((p, i) => {
      const px = mapX(p.x, W), py = mapY(p.y, H);
      const isStart = i === 0;
      const isLast  = i === ep.length - 1;
      const r = isStart ? 9 : 7;

      // Outer glow
      const grd = ctx.createRadialGradient(px, py, 0, px, py, r + 4);
      grd.addColorStop(0, isStart ? 'rgba(255,202,58,0.6)' : 'rgba(0,212,170,0.4)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(px, py, r + 4, 0, Math.PI * 2);
      ctx.fill();

      // Circle body
      ctx.fillStyle = isStart ? '#ffca3a' : isLast ? '#ff3c5a' : '#00d4aa';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      // Step number
      ctx.fillStyle = '#070a0e';
      ctx.font = `bold ${isStart ? 9 : 8}px JetBrains Mono`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i, px, py);
      ctx.textBaseline = 'alphabetic';
    });
  }

  //  8. Colorbar 
  if (pts.length > 0) {
    drawColorbar(ctx, W - CANVAS_PAD.r + 6, CANVAS_PAD.t, 10, PH, zMin, zMax);
  }

  lastRenderCount = pts.length;
}

function drawColorbar(ctx, x, y, w, h, zMin, zMax) {
  // Gradient fill
  const grd = ctx.createLinearGradient(x, y + h, x, y);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    grd.addColorStop(t, heatColor(t));
  }
  ctx.fillStyle = grd;
  ctx.fillRect(x, y, w, h);

  // Border
  ctx.strokeStyle = '#1a2d3f';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // Labels
  ctx.fillStyle = 'rgba(200,214,229,0.5)';
  ctx.font = '9px JetBrains Mono';
  ctx.textAlign = 'left';
  const fmt = v => Math.abs(v) >= 10000 ? v.toExponential(1) : v.toFixed(1);
  ctx.fillText(fmt(zMax), x + w + 3, y + 5);
  ctx.fillText(fmt((zMin + zMax) / 2), x + w + 3, y + h / 2 + 4);
  ctx.fillText(fmt(zMin), x + w + 3, y + h);
}

/* 
   CSV EXPORT
 */
function downloadCSV(filename, rows) {
  const content = rows.join('\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportExploreCSV() {
  if (!state.explored.length) return;
  const rows = state.explored.map(p => `${p.x},${p.y}`);
  downloadCSV(`explore_${state.port}.csv`, rows);
}

function exportMovesCSV() {
  if (!state.exploitPath.length) return;
  const rows = state.exploitPath.map(p => `${Math.round(p.x)},${Math.round(p.y)}`);
  downloadCSV(`moves_${state.port}.csv`, rows);
}

function exportDebugJSON() {
  const env = PORTS.test.includes(state.port) ? 'test' : 'exam';
  const best = state.explored.length
    ? state.explored.reduce((acc, p) => (p.z > acc.z ? p : acc), state.explored[0])
    : null;
  const totalSum = state.exploitPath.reduce((sum, p) => sum + p.z, 0);

  const payload = {
    generated_at: new Date().toISOString(),
    environment: env,
    port: state.port,
    call_delay_ms: state.callDelay,
    transport: {
      use_local_proxy: USE_LOCAL_PROXY,
      local_proxy_base: LOCAL_PROXY_BASE,
      api_base: API_BASE,
    },
    algorithm: {
      explore_budget: EXPLORE_BUDGET,
      exploit_steps: EXPLOIT_STEPS,
      xy_range: XY_RANGE,
    },
    summary: {
      exploration_done: state.explorationDone,
      exploitation_done: state.exploitationDone,
      explored_count: state.explored.length,
      exploit_count: state.exploitPath.length,
      total_calls: state.totalCallCount,
      best_point: best ? { x: best.x, y: best.y, z: best.z } : null,
      exploit_sum: state.exploitPath.length ? totalSum : null,
    },
    explored_points: state.explored.map((p, idx) => ({
      i: idx + 1,
      x: p.x,
      y: p.y,
      z: p.z,
    })),
    exploit_path: state.exploitPath.map((p, idx) => ({
      step: idx,
      x: Math.round(p.x),
      y: Math.round(p.y),
      z: p.z,
    })),
    logs: state.logEntries,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debug_${state.port}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* 
   UI HELPERS
 */
function log(msg, type = 'info') {
  const body = document.getElementById('log-body');
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = msg;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  state.logEntries.push({ ts: new Date().toISOString(), type, msg });
}

function logExplore(n, x, y, z) {
  log(`[${String(n).padStart(3)}] (${x.toFixed(2)}, ${y.toFixed(2)}) -> z = ${z.toFixed(4)}`, 'explore');
}

function setStatus(state) {
  const el = document.getElementById('status-text');
  if (!el) return;
  const map = {
    idle: ['IDLE', 'status-idle'],
    running: ['RUNNING', 'status-running'],
    done: ['READY', 'status-done'],
    error: ['ERROR', 'status-error'],
  };
  const [text, cls] = map[state] || map.idle;
  el.textContent = text;
  el.className = cls;
}

function setBtnState(exploreEnabled, exploitEnabled) {
  document.getElementById('btn-explore').disabled = !exploreEnabled;
  document.getElementById('btn-exploit').disabled = !exploitEnabled;
  document.getElementById('btn-explore').classList.toggle('running', !exploreEnabled && state.running);
}

function showProgress(visible) {
  document.getElementById('progress-wrap').style.display = visible ? 'flex' : 'none';
}

function updateProgress(phase, current, total) {
  if (phase) document.getElementById('progress-phase').textContent = phase;
  document.getElementById('progress-count').textContent = `${current} / ${total}`;
  document.getElementById('progress-fill').style.width = `${(current / total) * 100}%`;
}

function updateBestPoint(pt) {
  document.getElementById('best-point').textContent =
    `(${pt.x}, ${pt.y}) -> z = ${pt.z.toFixed(4)}`;
}

function updateCanvasInfo() {
  if (!state.explored.length) return;
  const zMax = Math.max(...state.explored.map(p => p.z));
  const zMin = Math.min(...state.explored.map(p => p.z));
  document.getElementById('canvas-info').textContent =
    `${state.explored.length} pts | z in [${zMin.toFixed(2)}, ${zMax.toFixed(2)}]`;
}

function clearPathTable() {
  document.getElementById('path-tbody').innerHTML =
    `<tr class="empty-row"><td colspan="4">no exploitation data yet</td></tr>`;
  document.getElementById('total-sum-wrap').style.display = 'none';
}

function appendPathRow(step, pt) {
  const tbody = document.getElementById('path-tbody');

  // Remove "empty" placeholder on first row
  if (step === 0) tbody.innerHTML = '';

  const tr = document.createElement('tr');
  tr.className = `step-row${step === 0 ? ' start-row' : ''}`;
  const zNeg = pt.z < 0 ? ' negative' : '';
  tr.innerHTML = `
    <td class="step-num">${step}</td>
    <td class="step-xy">${Math.round(pt.x)}</td>
    <td class="step-xy">${Math.round(pt.y)}</td>
    <td class="step-z${zNeg}">${pt.z.toFixed(4)}</td>
  `;
  tbody.appendChild(tr);

  // Auto-scroll table
  const wrap = document.querySelector('.path-table-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

function showTotalSum(total) {
  const wrap = document.getElementById('total-sum-wrap');
  wrap.style.display = 'flex';
  document.getElementById('total-sum').textContent = total.toFixed(4);
}

function updateExportButtons() {
  const expBtn = document.getElementById('btn-export-explore');
  const movBtn = document.getElementById('btn-export-moves');
  const dbgBtn = document.getElementById('btn-export-debug');
  expBtn.disabled = state.explored.length === 0;
  movBtn.disabled = state.exploitPath.length === 0;
  if (dbgBtn) dbgBtn.disabled = false;
}

function updatePortUI() {
  const port = state.port;

  // Update port-inline spans in export buttons
  document.querySelectorAll('.port-inline').forEach(el => {
    el.textContent = port;
  });
}

/* 
   EVENT LISTENERS
 */
document.addEventListener('DOMContentLoaded', () => {
  //  Port selector 
  const portSelect = document.getElementById('port-select');
  portSelect.addEventListener('change', () => {
    state.port = parseInt(portSelect.value);
    updatePortUI();
  });

  //  Environment toggle buttons 
  document.getElementById('env-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.env-btn');
    if (!btn) return;
    document.querySelectorAll('.env-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const env = btn.dataset.env;

    // Rebuild select options to show that environment first (not strictly needed)
    portSelect.value = env === 'test' ? '8080' : '22001';
    state.port = parseInt(portSelect.value);
    updatePortUI();
  });

  //  Run Exploration 
  document.getElementById('btn-explore').addEventListener('click', () => {
    if (!state.running) runExploration();
  });

  //  Run Exploitation 
  document.getElementById('btn-exploit').addEventListener('click', () => {
    if (!state.running && state.explorationDone) runExploitation();
  });

  //  Export CSVs 
  document.getElementById('btn-export-explore').addEventListener('click', exportExploreCSV);
  document.getElementById('btn-export-moves').addEventListener('click', exportMovesCSV);
  document.getElementById('btn-export-debug').addEventListener('click', exportDebugJSON);

  //  Clear log 
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('log-body').innerHTML = '';
    state.logEntries = [];
  });

  //  Initial render 
  setStatus('idle');
  setBtnState(true, false);
  updatePortUI();
  updateExportButtons();
  renderHeatmap(); // blank canvas with grid
});
