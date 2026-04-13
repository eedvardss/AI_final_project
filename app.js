'use strict';

// UI-only state, kept separate from algorithm core.
state.viewMode = '2d';
state.view3D = {
  yaw: -0.85,                 // horizontal rotation
  pitch: 0.95,                // vertical tilt
  zoom: 1.0,                  // projection zoom
  smoothPasses: 2,            // grid smoothing iterations
  smoothStrength: 0.38,       // 0..1 blend towards neighbor mean
  dragging: false,
  lastX: 0,
  lastY: 0,
};
state.logEntries = [];
state.logCollapsed = false;


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

function renderVisualization() {
  if (state.viewMode === '3d') {
    renderTopography3D();
  } else {
    renderHeatmap();
  }
}

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

function renderTopography3D() {
  const canvas = document.getElementById('heatmap');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const pts = state.explored;
  const zs = pts.map(p => p.z);
  const zMin = zs.length ? Math.min(...zs) : 0;
  const zMax = zs.length ? Math.max(...zs) : 1;
  const zRng = Math.max(zMax - zMin, 1e-6);
  const norm = z => (z - zMin) / zRng;

  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, W, H);

  const res = pts.length >= 150 ? 40 : (pts.length >= 80 ? 34 : 28);
  const yaw = state.view3D.yaw;
  const pitch = state.view3D.pitch;
  const cYaw = Math.cos(yaw), sYaw = Math.sin(yaw);
  const cPitch = Math.cos(pitch), sPitch = Math.sin(pitch);

  const projectUnit = (xN, yN, zVal) => {
    const zN = (norm(zVal) - 0.5) * 2;

    // Rotate in XY plane (yaw), then tilt with height (pitch).
    const x1 = xN * cYaw - yN * sYaw;
    const y1 = xN * sYaw + yN * cYaw;
    const y2 = y1 * cPitch - zN * sPitch;
    const depth = y1 * sPitch + zN * cPitch;
    return { sx: x1, sy: y2, depth };
  };

  const grid = new Array(res);
  for (let gy = 0; gy < res; gy++) {
    grid[gy] = new Array(res);
    const y = XY_RANGE.min + (gy / (res - 1)) * (XY_RANGE.max - XY_RANGE.min);
    for (let gx = 0; gx < res; gx++) {
      const x = XY_RANGE.min + (gx / (res - 1)) * (XY_RANGE.max - XY_RANGE.min);
      const ez = pts.length ? estimateZ(x, y, pts, 10) : 0;
      grid[gy][gx] = { x, y, z: ez };
    }
  }

  // Smooth height field to reduce jagged triangles.
  for (let pass = 0; pass < state.view3D.smoothPasses; pass++) {
    const next = new Array(res);
    for (let gy = 0; gy < res; gy++) {
      next[gy] = new Array(res);
      for (let gx = 0; gx < res; gx++) {
        const cur = grid[gy][gx];
        let sum = cur.z;
        let count = 1;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const ny = gy + oy;
            const nx = gx + ox;
            if (ny < 0 || ny >= res || nx < 0 || nx >= res) continue;
            sum += grid[ny][nx].z;
            count++;
          }
        }
        const mean = sum / count;
        const s = state.view3D.smoothStrength;
        next[gy][gx] = { ...cur, z: cur.z * (1 - s) + mean * s };
      }
    }
    for (let gy = 0; gy < res; gy++) {
      for (let gx = 0; gx < res; gx++) {
        grid[gy][gx].z = next[gy][gx].z;
      }
    }
  }

  // First projection pass to compute bounds.
  let minSX = Infinity, maxSX = -Infinity;
  let minSY = Infinity, maxSY = -Infinity;
  for (let gy = 0; gy < res; gy++) {
    for (let gx = 0; gx < res; gx++) {
      const p = grid[gy][gx];
      const pr = projectUnit(p.x / 100, p.y / 100, p.z);
      p.sx = pr.sx;
      p.sy = pr.sy;
      p.depth = pr.depth;
      p.t = norm(p.z);
      if (pr.sx < minSX) minSX = pr.sx;
      if (pr.sx > maxSX) maxSX = pr.sx;
      if (pr.sy < minSY) minSY = pr.sy;
      if (pr.sy > maxSY) maxSY = pr.sy;
    }
  }

  // Auto-center and scale to viewport.
  const padX = 34;
  const padY = 46;
  const spanX = Math.max(maxSX - minSX, 1e-6);
  const spanY = Math.max(maxSY - minSY, 1e-6);
  const baseScale = Math.min((W - padX * 2) / spanX, (H - padY * 2) / spanY);
  const scale = baseScale * state.view3D.zoom;
  const offX = W * 0.5 - ((minSX + maxSX) * 0.5) * scale;
  const offY = H * 0.54 - ((minSY + maxSY) * 0.5) * scale;

  for (let gy = 0; gy < res; gy++) {
    for (let gx = 0; gx < res; gx++) {
      const p = grid[gy][gx];
      p.px = p.sx * scale + offX;
      p.py = p.sy * scale + offY;
    }
  }

  // Draw quads sorted by depth (back to front).
  const faces = [];
  for (let gy = 0; gy < res - 1; gy++) {
    for (let gx = 0; gx < res - 1; gx++) {
      const p00 = grid[gy][gx];
      const p10 = grid[gy][gx + 1];
      const p11 = grid[gy + 1][gx + 1];
      const p01 = grid[gy + 1][gx];
      faces.push({
        p00, p10, p11, p01,
        tAvg: (p00.t + p10.t + p11.t + p01.t) / 4,
        depth: (p00.depth + p10.depth + p11.depth + p01.depth) / 4,
      });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);

  for (const f of faces) {
    ctx.beginPath();
    ctx.moveTo(f.p00.px, f.p00.py);
    ctx.lineTo(f.p10.px, f.p10.py);
    ctx.lineTo(f.p11.px, f.p11.py);
    ctx.lineTo(f.p01.px, f.p01.py);
    ctx.closePath();
    ctx.fillStyle = heatColor(f.tAvg, 0.92);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.45;
    ctx.stroke();
  }

  // XY boundary frame.
  const c00 = grid[0][0];
  const c10 = grid[0][res - 1];
  const c11 = grid[res - 1][res - 1];
  const c01 = grid[res - 1][0];
  ctx.strokeStyle = 'rgba(255,255,255,0.26)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(c00.px, c00.py);
  ctx.lineTo(c10.px, c10.py);
  ctx.lineTo(c11.px, c11.py);
  ctx.lineTo(c01.px, c01.py);
  ctx.closePath();
  ctx.stroke();

  const projectPoint = (x, y, z) => {
    const pr = projectUnit(x / 100, y / 100, z);
    return { px: pr.sx * scale + offX, py: pr.sy * scale + offY };
  };

  // Explored samples as bright points.
  for (const p of pts) {
    const { px, py } = projectPoint(p.x, p.y, p.z);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.beginPath();
    ctx.arc(px, py, 1.45, 0, Math.PI * 2);
    ctx.fill();
  }

  // Exploitation path in 3D.
  const ep = state.exploitPath;
  if (ep.length > 0) {
    ctx.save();
    ctx.shadowColor = '#00d4aa';
    ctx.shadowBlur = 9;
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ep.forEach((p, i) => {
      const pr = projectPoint(p.x, p.y, p.z);
      i === 0 ? ctx.moveTo(pr.px, pr.py) : ctx.lineTo(pr.px, pr.py);
    });
    ctx.stroke();
    ctx.restore();

    ep.forEach((p, i) => {
      const pr = projectPoint(p.x, p.y, p.z);
      const r = i === 0 ? 5 : 4;
      ctx.fillStyle = i === 0 ? '#ffca3a' : '#00d4aa';
      ctx.beginPath();
      ctx.arc(pr.px, pr.py, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // 3D info label
  ctx.fillStyle = 'rgba(200,214,229,0.66)';
  ctx.font = '11px JetBrains Mono';
  ctx.textAlign = 'left';
  ctx.fillText('3D TOPOGRAPHY VIEW', 12, 18);
  if (pts.length > 0) {
    const fmt = v => Math.abs(v) >= 10000 ? v.toExponential(1) : v.toFixed(2);
    ctx.fillText(`z: [${fmt(zMin)}, ${fmt(zMax)}]`, 12, 34);
    ctx.fillText('drag: rotate  |  wheel: zoom  |  dblclick: reset', 12, 50);
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

function setLogCollapsed(collapsed) {
  state.logCollapsed = collapsed;
  document.body.classList.toggle('log-collapsed', collapsed);

  const btn = document.getElementById('btn-toggle-log');
  if (btn) {
    btn.textContent = collapsed ? 'EXPAND' : 'COLLAPSE';
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
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

  //  Visualization mode (2D / 3D)
  document.getElementById('view-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.view-btn');
    if (!btn) return;
    const mode = btn.dataset.view;
    if (mode !== '2d' && mode !== '3d') return;

    state.viewMode = mode;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const canvas = document.getElementById('heatmap');
    canvas.style.cursor = mode === '3d' ? 'grab' : 'default';
    renderVisualization();
  });

  //  3D canvas interactions: drag rotate, wheel zoom, double-click reset
  const canvas = document.getElementById('heatmap');
  canvas.addEventListener('pointerdown', e => {
    if (state.viewMode !== '3d') return;
    state.view3D.dragging = true;
    state.view3D.lastX = e.clientX;
    state.view3D.lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', e => {
    if (state.viewMode !== '3d' || !state.view3D.dragging) return;
    const dx = e.clientX - state.view3D.lastX;
    const dy = e.clientY - state.view3D.lastY;
    state.view3D.lastX = e.clientX;
    state.view3D.lastY = e.clientY;

    state.view3D.yaw += dx * 0.009;
    state.view3D.pitch = clampNum(state.view3D.pitch + dy * 0.006, 0.25, 1.45);
    renderVisualization();
  });

  const stopDrag = () => {
    state.view3D.dragging = false;
    if (state.viewMode === '3d') {
      canvas.style.cursor = 'grab';
    }
  };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);
  canvas.addEventListener('pointerleave', stopDrag);

  canvas.addEventListener('wheel', e => {
    if (state.viewMode !== '3d') return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0011);
    state.view3D.zoom = clampNum(state.view3D.zoom * factor, 0.58, 2.6);
    renderVisualization();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => {
    if (state.viewMode !== '3d') return;
    state.view3D.yaw = -0.85;
    state.view3D.pitch = 0.95;
    state.view3D.zoom = 1.0;
    renderVisualization();
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

  document.getElementById('btn-toggle-log').addEventListener('click', () => {
    setLogCollapsed(!state.logCollapsed);
  });

  //  Initial render 
  setStatus('idle');
  setBtnState(true, false);
  updatePortUI();
  updateExportButtons();
  setLogCollapsed(false);
  document.getElementById('heatmap').style.cursor = 'default';
  renderVisualization(); // blank canvas with grid
});
