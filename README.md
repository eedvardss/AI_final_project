# AI HW2 - Explore and Exploit Terminal

**Student names:** Kristers Krigers, Edvards Markuss Selikovs, Kristofers Sondors

Web tool for the 2026 AI HW2 task: explore a 2D API in 200 calls, then run a 10-step connected exploitation path.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App layout and controls |
| `styles.css` | UI styling |
| `algorithm.js` | Core API + exploration/exploitation logic |
| `app.js` | UI layer: rendering, controls, exports |
| `cors-proxy.js` | Local CORS proxy for browser testing |
| `task.txt` | Original assignment brief |

---

## How to Run

1. If you are using exam ports, put your real key in `.env`:
   `API_KEY=your_real_key_here`
2. Start the proxy:
   `node cors-proxy.js`
3. Open `index.html` (Live Server or browser).
4. Pick environment and port.
5. Run **RUN EXPLORATION**.
6. Run **RUN EXPLOITATION**.
7. Export `explore_PORT.csv`, `moves_PORT.csv`, and `debug_PORT.json`.

---

## API

Test ports:
`GET http://157.180.73.240:PORT/x/y`

Exam ports:
`GET http://157.180.73.240:PORT/x/y/API_KEY`

- Search space: `x, y` in `[-100, 100]`
- Test ports: `8080, 8081, 8082`
- Exam ports: `22001, 22002, 22003, 22004, 22005`

---

## Task Rules (summary)

- Exactly 200 exploration calls.
- Exactly 10 exploitation moves.
- Exploitation coordinates must be integers.
- Each exploitation move must be connected (`dx,dy` in `{-1,0,1}`, not both zero).
- No revisiting previously used exploitation squares (2026 rule).

---

## Exported Files

- `explore_PORT.csv`: 200 explored `(x,y)` pairs
- `moves_PORT.csv`: 10 exploitation integer coordinates
- `debug_PORT.json`: run metadata, algorithm settings, explored points, path, and logs

---

## Live Server + CORS

Direct browser calls to `157.180.73.240` are CORS-blocked.
Use the included proxy:

1. For exam ports only, create `.env` with `API_KEY=...`
2. `node cors-proxy.js`
3. Keep that terminal open
4. Reload the page

The app calls `http://localhost:8787/:port/:x/:y` when proxy mode is enabled in code.
The proxy appends the API key server-side only for exam ports, so it never has to live in browser code.
