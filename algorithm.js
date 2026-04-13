/**
 * algorithm.js  Explore & Exploit Terminal
 * Student names: Kristers Krigers, Edvards Markuss Selikovs, Kristofers Sondors
 *
 * Algorithm:
 *  Exploration (200 successful samples):
 *    Phase 1: 10x10 coarse grid       100 calls
 *    Phase 2: Top-5 hotspot zoom       ~50 calls
 *    Phase 3: Dense patch around best  ~50 calls
 *
 *  Exploitation (10 calls, integer coords, +/-1 steps):
 *    Start at the best bounded integer point found near the best float sample.
 *    At each step, rank unvisited 8-directional neighbors using IDW, but only
 *    accept moves that still leave a full no-revisit continuation path.
 */

'use strict';

/*
   CONFIG
 */
const API_BASE = 'http://157.180.73.240';
const LOCAL_PROXY_BASE = 'http://localhost:8787';
const USE_LOCAL_PROXY = true;
const API_CALL_DELAY_MS = 0;

const PORTS = {
  test: [8080, 8081, 8082],
  exam: [22001, 22002, 22003, 22004, 22005],
};

const EXPLORE_BUDGET = 200;
const EXPLOIT_STEPS = 10;
const XY_RANGE = { min: -100, max: 100 };

/*
   STATE
 */
const state = {
  port: 8080,
  callDelay: API_CALL_DELAY_MS,
  explored: [],
  exploitPath: [],
  visitedKeys: new Set(),
  explorationDone: false,
  exploitationDone: false,
  running: false,
  totalCallCount: 0,
};

/*
   UTILITIES
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clampNum = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const clamp = value => clampNum(value, XY_RANGE.min, XY_RANGE.max);
const iKey = (x, y) => `${Math.round(x)},${Math.round(y)}`;
const fKey = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;

function inBounds(x, y) {
  return (
    x >= XY_RANGE.min && x <= XY_RANGE.max &&
    y >= XY_RANGE.min && y <= XY_RANGE.max
  );
}

/*
   API LAYER
 */
async function queryAPI(x, y) {
  const isExamPort = PORTS.exam.includes(state.port);
  const directUrl = `${API_BASE}:${state.port}/${x}/${y}`;
  const proxyUrl = `${LOCAL_PROXY_BASE}/${state.port}/${x}/${y}`;
  const urls = USE_LOCAL_PROXY
    ? [proxyUrl]
    : [directUrl];

  if (isExamPort && !USE_LOCAL_PROXY) {
    throw new Error('API key mode requires the local proxy.');
  }

  let lastNetworkError = null;

  for (const url of urls) {
    try {
      state.totalCallCount++;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const data = await res.json();
        const raw = typeof data === 'number' ? data : data?.z;
        const val = parseFloat(String(raw));
        if (isNaN(val)) {
          throw new Error(`Non-numeric JSON response: "${JSON.stringify(data)}"`);
        }
        return val;
      }

      const text = await res.text();
      const val = parseFloat(text.trim());
      if (isNaN(val)) {
        throw new Error(`Non-numeric response: "${text}"`);
      }
      return val;
    } catch (err) {
      if (
        err instanceof TypeError ||
        err.message.includes('Failed to fetch') ||
        err.message.includes('NetworkError')
      ) {
        lastNetworkError = err;
        continue;
      }
      throw err;
    }
  }

  if (lastNetworkError) {
    throw new Error('CORS_ERROR');
  }

  throw new Error('API_REQUEST_FAILED');
}

/*
   IDW INTERPOLATION
 */
function estimateZ(x, y, points, k = 15, power = 2) {
  if (points.length === 0) return 0;

  const ranked = points
    .map(p => ({ p, d2: (p.x - x) ** 2 + (p.y - y) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, Math.min(k, points.length));

  if (ranked[0].d2 < 1e-9) return ranked[0].p.z;

  let wSum = 0;
  let zSum = 0;
  for (const { p, d2 } of ranked) {
    const w = 1 / Math.pow(d2, power / 2);
    wSum += w;
    zSum += w * p.z;
  }
  return zSum / wSum;
}

function getUnvisitedNeighbors(x, y, visitedKeys) {
  const neighbors = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      if (visitedKeys.has(iKey(nx, ny))) continue;
      neighbors.push({ x: nx, y: ny });
    }
  }
  return neighbors;
}

function hasContinuationPath(x, y, visitedKeys, remainingMoves) {
  if (remainingMoves === 0) return true;

  const candidates = getUnvisitedNeighbors(x, y, visitedKeys)
    .sort((a, b) => estimateZ(b.x, b.y, state.explored) - estimateZ(a.x, a.y, state.explored));

  for (const next of candidates) {
    const key = iKey(next.x, next.y);
    visitedKeys.add(key);
    const ok = hasContinuationPath(next.x, next.y, visitedKeys, remainingMoves - 1);
    visitedKeys.delete(key);
    if (ok) return true;
  }

  return false;
}

function choosePlannedNeighbor(current, visitedKeys, remainingMovesAfterStep) {
  const candidates = getUnvisitedNeighbors(current.x, current.y, visitedKeys)
    .map(p => ({ ...p, est: estimateZ(p.x, p.y, state.explored) }))
    .sort((a, b) => b.est - a.est);

  for (const candidate of candidates) {
    const nextVisited = new Set(visitedKeys);
    nextVisited.add(iKey(candidate.x, candidate.y));
    if (hasContinuationPath(candidate.x, candidate.y, nextVisited, remainingMovesAfterStep)) {
      return candidate;
    }
  }

  return candidates[0] || null;
}

function pickBestStartPoint() {
  const floatBest = state.explored.reduce((best, p) => (p.z > best.z ? p : best));
  const cx0 = Math.round(floatBest.x);
  const cy0 = Math.round(floatBest.y);
  const candidates = [];

  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const x = cx0 + dx;
      const y = cy0 + dy;
      if (!inBounds(x, y)) continue;
      candidates.push({ x, y, est: estimateZ(x, y, state.explored) });
    }
  }

  candidates.sort((a, b) => b.est - a.est);

  for (const candidate of candidates) {
    const visited = new Set([iKey(candidate.x, candidate.y)]);
    if (hasContinuationPath(candidate.x, candidate.y, visited, EXPLOIT_STEPS - 1)) {
      return candidate;
    }
  }

  return candidates[0] || {
    x: clampNum(cx0, XY_RANGE.min, XY_RANGE.max),
    y: clampNum(cy0, XY_RANGE.min, XY_RANGE.max),
    est: estimateZ(cx0, cy0, state.explored),
  };
}

async function fillExplorationBudget(sample, getCount, center) {
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);

  for (let radius = 1; radius <= 100 && getCount() < EXPLORE_BUDGET; radius++) {
    for (let dx = -radius; dx <= radius && getCount() < EXPLORE_BUDGET; dx++) {
      await sample(cx + dx, cy - radius);
      if (getCount() >= EXPLORE_BUDGET) break;
      await sample(cx + dx, cy + radius);
    }

    for (let dy = -radius + 1; dy <= radius - 1 && getCount() < EXPLORE_BUDGET; dy++) {
      await sample(cx - radius, cy + dy);
      if (getCount() >= EXPLORE_BUDGET) break;
      await sample(cx + radius, cy + dy);
    }
  }

  for (let x = XY_RANGE.min; x <= XY_RANGE.max && getCount() < EXPLORE_BUDGET; x += 5) {
    for (let y = XY_RANGE.min; y <= XY_RANGE.max && getCount() < EXPLORE_BUDGET; y += 5) {
      await sample(x, y);
    }
  }
}

/*
   EXPLORATION
 */
async function runExploration() {
  if (state.running) return;

  state.running = true;
  state.explorationDone = false;
  state.exploitationDone = false;
  state.explored = [];
  state.exploitPath = [];
  state.visitedKeys = new Set();
  state.totalCallCount = 0;

  const sampledSet = new Set();
  let callCount = 0;

  setStatus('running');
  setBtnState(false, false);
  showProgress(true);
  updateProgress('PHASE 1', callCount, EXPLORE_BUDGET);
  clearPathTable();

  async function sample(rawX, rawY) {
    if (callCount >= EXPLORE_BUDGET) return null;

    const x = parseFloat(clamp(rawX).toFixed(2));
    const y = parseFloat(clamp(rawY).toFixed(2));
    const key = fKey(x, y);

    if (sampledSet.has(key)) return null;

    try {
      const z = await queryAPI(x, y);
      const pt = { x, y, z };
      sampledSet.add(key);
      callCount++;
      state.explored.push(pt);
      updateProgress(null, callCount, EXPLORE_BUDGET);
      logExplore(callCount, x, y, z);

      if (callCount % 5 === 0 || callCount <= 10) {
        renderVisualization();
      }

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
    log('[PHASE 1] 10x10 coarse grid (100 calls)...', 'phase');
    const coarse = [-90, -70, -50, -30, -10, 10, 30, 50, 70, 90];
    for (const x of coarse) {
      for (const y of coarse) {
        await sample(x, y);
      }
    }

    if (!state.explored.length) {
      throw new Error('Exploration did not collect any successful samples.');
    }

    log('[PHASE 2] Refining top-5 hotspots (~50 calls)...', 'phase');
    updateProgress('PHASE 2', callCount, EXPLORE_BUDGET);

    const phase1Sorted = [...state.explored].sort((a, b) => b.z - a.z);
    const hotspots = [];
    for (const p of phase1Sorted) {
      const tooClose = hotspots.some(h => Math.hypot(h.x - p.x, h.y - p.y) < 25);
      if (!tooClose) {
        hotspots.push(p);
        if (hotspots.length >= 5) break;
      }
    }

    const phase2Offsets = [
      [-6, -6], [-6, 0], [-6, 6],
      [0, -6], [0, 6],
      [6, -6], [6, 0], [6, 6],
      [-3, -3], [-3, 3], [3, -3], [3, 3],
    ];

    for (const hotspot of hotspots) {
      for (const [dx, dy] of phase2Offsets) {
        if (callCount >= 150) break;
        await sample(hotspot.x + dx, hotspot.y + dy);
      }
      if (callCount >= 150) break;
    }

    log('[PHASE 3] Dense local search around global best (~50 calls)...', 'phase');
    updateProgress('PHASE 3', callCount, EXPLORE_BUDGET);

    const globalBest = state.explored.reduce((best, p) => (p.z > best.z ? p : best));
    const step3 = 3;
    for (let dx = -9; dx <= 9; dx += step3) {
      for (let dy = -9; dy <= 9; dy += step3) {
        if (callCount >= EXPLORE_BUDGET) break;
        await sample(globalBest.x + dx, globalBest.y + dy);
      }
      if (callCount >= EXPLORE_BUDGET) break;
    }

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

    if (callCount < EXPLORE_BUDGET) {
      await fillExplorationBudget(sample, () => callCount, globalBest);
    }

    if (callCount < EXPLORE_BUDGET) {
      throw new Error(`Exploration ended with only ${callCount} successful samples.`);
    }

    renderVisualization();
    state.explorationDone = true;
    state.running = false;
    setStatus('done');
    setBtnState(true, true);
    showProgress(false);

    const peak = state.explored.reduce((best, p) => (p.z > best.z ? p : best));
    log(`[COMPLETE] ${state.explored.length} points sampled.`, 'success');
    log(`[PEAK] (${peak.x}, ${peak.y}) -> z = ${peak.z.toFixed(4)}`, 'highlight');
    updateBestPoint(peak);
    updateExportButtons();
    updateCanvasInfo();
  } catch (err) {
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
async function runExploitation() {
  if (!state.explorationDone || state.running) return;

  state.running = true;
  state.exploitationDone = false;
  state.exploitPath = [];
  state.visitedKeys = new Set();

  setStatus('running');
  setBtnState(false, false);
  clearPathTable();

  try {
    const start = pickBestStartPoint();
    const startX = start.x;
    const startY = start.y;
    const startEst = start.est;

    log(
      `[EXPLOIT] Starting at integer (${startX}, ${startY}) - est z = ${startEst.toFixed(4)}`,
      'phase'
    );

    const z0 = await queryAPI(startX, startY);
    const step0 = { x: startX, y: startY, z: z0 };
    state.exploitPath.push(step0);
    state.visitedKeys.add(iKey(startX, startY));
    log(`[STEP 0] (${startX}, ${startY}) -> z = ${z0.toFixed(4)}`, 'exploit');
    appendPathRow(0, step0);
    renderVisualization();
    await sleep(state.callDelay);

    for (let step = 1; step < EXPLOIT_STEPS; step++) {
      const cur = state.exploitPath[state.exploitPath.length - 1];
      const best = choosePlannedNeighbor(cur, state.visitedKeys, EXPLOIT_STEPS - step - 1);

      if (!best) {
        throw new Error(`Could not build a valid no-revisit path for step ${step}.`);
      }

      const realZ = await queryAPI(best.x, best.y);
      const pt = { x: best.x, y: best.y, z: realZ };
      state.exploitPath.push(pt);
      state.visitedKeys.add(iKey(best.x, best.y));

      log(
        `[STEP ${step}] (${best.x}, ${best.y}) -> z = ${realZ.toFixed(4)}  [est: ${best.est.toFixed(4)}]`,
        'exploit'
      );
      appendPathRow(step, pt);
      renderVisualization();
      await sleep(state.callDelay);
    }

    const total = state.exploitPath.reduce((sum, p) => sum + p.z, 0);
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
