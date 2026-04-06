# Deep Scan â€” Explore & Exploit Terminal

**Student names:** Kristers Krīgers, Edvards Markuss Selikovs, Kristofers Sondors

A browser-based tool for the 2026 AI HW2 assignment: intelligently explore a 2D scoring API, then exploit the best area found using a connected 10-step walk.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and layout |
| `styles.css` | Swiss minimalist theme (Inter + JetBrains Mono) |
| `app.js` | Full algorithm â€” exploration, exploitation, heatmap, CSV export |

---

## How to Run

1. Open `index.html` in a browser
2. Select environment: **TEST** (ports 8080â€“8082) or **EXAM** (ports 22001â€“22005)
3. Pick the port from the dropdown
4. Click **RUN EXPLORATION** â†’ wait for 200 calls to complete
5. Click **RUN EXPLOITATION** â†’ 10 greedy steps execute automatically
6. Download `explore_PORT.csv` and `moves_PORT.csv` using the export buttons

---

## API

```
GET http://157.180.73.240:PORT/x/y
```

Returns a single float (the z-score). Search space: `x, y âˆˆ [-100, 100]`.

| Environment | Ports |
|---|---|
| Test | 8080, 8081, 8082 |
| Exam | 22001, 22002, 22003, 22004, 22005 |

---

## Algorithm

### The Goal

You are blindly searching a 200Ã—200 grid for the highest score (z-value). You have 200 guesses to find the peak, then 10 connected steps to collect as much score as possible around it.

---

### Exploration â€” 3 Phases, 200 API calls

**Phase 1 â€” Cast a wide net (100 calls)**

Sample a 10Ã—10 grid evenly spaced across the whole space. Like taking 100 soil samples across a field. Gives a rough map of where the "mountains" are.

```
x values: -90, -70, -50, -30, -10, 10, 30, 50, 70, 90
y values:  same
â†’ 100 evenly spaced points covering the full [-100, 100] range
```

**Phase 2 â€” Zoom into promising areas (~50 calls)**

Find the top 5 highest points from Phase 1, ensuring they are at least 25 units apart (so we don't zoom into the same peak 5 times). For each hotspot, sample nearby at offsets of Â±3 and Â±6. This narrows in on the peaks more precisely.

**Phase 3 â€” Dense drill-down (~50 calls)**

Find the single best point found so far. Sample a tight 7Ã—7 grid around it with step size 3, then fill the remaining budget with random points nearby. This precisely maps the peak area at fine resolution.

```
Phase 1: coarse overview    (every 20 units)
Phase 2: hotspot zoom       (every 6 units around top-5)
Phase 3: dense local patch  (every 3 units around global best)
```

All sampled (x, y) pairs are deduplicated â€” the same point is never queried twice.

---

### Exploitation â€” Greedy walk, 10 API calls

You cannot fly to a new area â€” you must walk step by step (Â±1 per move in x and/or y, so 8 possible directions). You also cannot revisit any square (2026 rule).

**Step 0 â€” Pick the best integer starting point**

Round the best float coordinate found during exploration to the nearest integer. Check a Â±3 integer neighborhood around it using IDW estimation, and start at whichever integer square is predicted highest.

**Steps 1â€“9 â€” Greedy neighbour walk**

At each position:
1. Generate all 8 surrounding squares (up, down, left, right, and 4 diagonals)
2. Filter out any already-visited squares
3. Estimate the score of each remaining candidate using **IDW** (see below)
4. Move to the neighbour with the highest estimated score
5. Make 1 real API call to confirm the actual score
6. Mark the square as visited

Repeat until 10 steps are complete or no unvisited neighbours remain.

---

### IDW â€” Inverse Distance Weighting

Since the real score of an unvisited square is unknown, we estimate it from the ~200 explored points nearby. Closer explored points have more influence than distant ones.

```
         Î£ ( záµ¢ / dáµ¢Â² )
zÌƒ(P) = â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
           Î£ ( 1 / dáµ¢Â² )

where dáµ¢ = distance from P to explored point i
      záµ¢ = known score at explored point i
      k  = 15 nearest neighbours used
```

This is called Inverse Distance Weighting (IDW, power=2). It is fast, requires no training, and works well when the landscape is smooth â€” which Gaussian-peak-type functions are.

---

### Why This Works

| Problem | Solution |
|---|---|
| Can't query all ~40,000 squares | 3-phase funnel: coarse â†’ medium â†’ fine |
| Don't know neighbour scores before stepping | IDW predicts from explored data |
| Must walk a connected path | Greedy neighbour selection at each step |
| Cannot revisit squares (2026 rule) | `visitedKeys` Set blocks already-seen tiles |
| Peak might not be on an integer grid point | Phase 3 dense sampling maps sub-integer structure; IDW picks best integer start |

---

## Output Files

### `explore_PORT.csv`
200 rows of the (x, y) pairs queried during exploration. Float values allowed.

```
-90.0,-90.0
-90.0,-70.0
23.0,-45.0
...
```

### `moves_PORT.csv`
10 rows of the exploitation path. Integer values only. First row is the starting point.

```
23,-45
24,-45
24,-44
23,-44
...
```

The sum of the z-values at these 10 coordinates is the final score submitted.

---


## Exam Day Checklist

- [ ] Select correct exam port (22001â€“22005)
- [ ] Set call delay to ~80 ms (fits ~630 calls within 2 minutes)
- [ ] Run Exploration (â‰¤200 calls)
- [ ] Run Exploitation (10 calls)
- [ ] Download `explore_PORT.csv` and `moves_PORT.csv`
- [ ] Note the **Total Sum** displayed in the results panel â€” this is your submission answer

---

## Live Server + CORS

If you open `index.html` using VS Code Live Server, direct browser calls to
`http://157.180.73.240:*` are blocked by CORS.

Use the local proxy included in this repo:

1. Run `node cors-proxy.js` in the project folder.
2. Keep that terminal open.
3. Reload your Live Server page.

`app.js` is configured to use `http://localhost:8787/:port/:x/:y` by default.
