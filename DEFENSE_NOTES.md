# AI HW2 Defense Notes

## Short version

Our solution is split into two clearly different parts because the assignment itself has two different rule sets:

1. `exploration`
   We are allowed to use floats and spend up to `200` calls learning the surface.
2. `exploitation`
   We only get `10` moves, they must use integer coordinates, every move must go to a neighboring tile, and we should avoid revisiting tiles.

So the whole logic is:

1. Use exploration to understand where the good regions are.
2. Build a local estimate of the surface from those explored points.
3. Use that estimate to choose a connected 10-tile integer path that follows the best area without getting trapped.

---

## What the algorithm does

The algorithm treats the API like an unknown 2D landscape.

- Each `(x, y)` coordinate gives back some score `z`
- We do not know the formula behind it
- The search space is limited to `[-100, 100]` for both `x` and `y`

Because of that, the algorithm first learns the landscape roughly, then refines the best parts, and only after that does the final 10-step walk.

This is important because if we started exploiting too early, we might commit to a region that only looked good from a few random samples.

---

## Exploration phase

### Phase 1: coarse global scan

We start with a `10 x 10` grid over the whole search space.

Why:

- it gives broad coverage of the full allowed area
- it avoids assuming the best region is near the center
- it is cheap enough to still leave a lot of budget for refinement

What this gives us:

- a rough map of the surface
- a first guess of where high-value areas might be

In simple words: this phase answers the question, “which part of the map even looks promising?”

### Phase 2: refine several hotspots

After the coarse scan, we sort the explored points by score and choose top hotspot candidates.

But we do **not** just take the highest 5 points blindly.
We force those hotspots to be separated from each other.

Why:

- otherwise the top few points might all belong to the same local hill
- that would waste exploration budget on one area while ignoring other strong regions

Around each hotspot, we sample nearby offsets.

Why:

- this shows whether that hotspot is a real hill, a ridge, a narrow spike, or just noise
- it gives more local structure for later prediction

In simple words: this phase answers, “among the promising regions, which ones are actually shaped well?”

### Phase 3: dense search near the best region

After phase 2, we take the best currently known area and spend most remaining budget around it.

Why:

- the final 10-step path will almost always depend on local structure
- once we know the best general region, it makes sense to spend more calls there instead of scanning the whole map again

This phase uses:

- a denser local grid around the current best point
- then additional nearby samples to fill the rest of the budget

### Fallback to exactly 200 successful samples

The assignment expects the exported exploration file to contain the actual explored coordinates.
So we count only **successful** API responses as exploration points.

Why that matters:

- if a request fails and we still counted it, the file could end up with less than `200` actual rows
- that would be risky for submission

So if the main exploration phases do not reach exactly `200` successful samples, the fallback safely fills the rest.

---

## Why we use IDW

The API is basically a black box.
We know inputs and outputs, but not the function.

So we need some way to estimate what unexplored nearby points might look like.
For that we use `IDW` which means `Inverse Distance Weighting`.

Basic idea:

- every explored point votes on the value of a new point
- nearby explored points get much more weight
- far away explored points matter less

Why this is a good fit here:

- it is simple
- it uses only the explored data
- it does not assume a specific formula
- it works well for local interpolation when nearby samples are informative

In simple words:
if a tile is surrounded by strong explored points, IDW predicts it is probably strong too.

---

## Exploitation phase

Exploration and exploitation are separated on purpose.

Exploration is about learning.
Exploitation is about scoring under strict rules.

### Choosing the start point

We first take the best float-region discovered during exploration.
Then we search nearby integer coordinates around it.

Why:

- exploitation is integer-only
- the best float point itself may not be an integer
- also, the nearest integer is not always the best integer tile

But we do one more check:
we do not only ask “is this start point strong?”
we also ask “can I still complete a full 10-step path from here without revisiting?”

Why:

- a point can look excellent but still be a trap
- for example, near a border or inside a narrow shape

### Choosing each next move

At every step:

1. Look at the 8 neighboring integer tiles
2. Ignore already visited tiles
3. Score the remaining candidates with the IDW estimate
4. Prefer the best estimated move
5. But only accept it if there is still a valid continuation path for the remaining steps

This means the algorithm is:

- `greedy`, because it prefers the best local predicted move
- but also `look-ahead aware`, because it checks future feasibility

That combination is important.

If we were only greedy, we could step onto a high-value tile and then get stuck.
The look-ahead check prevents that.

---

## Why the no-revisit rule matters

The revisit rule changes the problem a lot.

Without that rule, a simple local hill-climbing walk would be easier.
You could move toward good local values and recover from mistakes by stepping back.

With no revisits, every move matters more.

Bad things that can happen without protection:

- getting trapped near the map border
- entering a dead-end shape
- using up too many tiles in a narrow corridor
- reaching a high tile but losing the ability to finish all 10 moves

That is why we use the recursive continuation check:

> “If I move here now, is there still a valid path for the remaining moves?”

That check is the part that makes the exploitation phase constraint-aware rather than just greedy.

---

## Practical implementation details

### API key handling

Only exam ports need the API key.

So:

- test ports work normally
- exam ports go through the local proxy
- the proxy reads the key from `.env`
- the browser never needs to know the key directly

Why this is useful:

- safer than hardcoding the key in frontend code
- easier to switch machines or keys
- avoids exposing the key in the page source

### Export behavior

The app exports:

- `explore_PORT.csv`
- `moves_PORT.csv`
- `debug_PORT.json`

This matches the assignment flow closely:

- exploration coordinates are saved exactly
- exploitation coordinates are saved as integer moves
- debug file helps verify what happened during the run

---

## Why this is a reasonable approach

### 1. It balances global and local search

We do not spend all 200 calls randomly.
We also do not spend all 200 calls around a single early guess.

Instead:

- first scan globally
- then refine multiple candidates
- then focus locally where it matters most

That is a balanced use of a limited budget.

### 2. It matches the assignment constraints directly

A lot of “nice looking” optimization methods ignore practical constraints.
This one does not.

It directly respects:

- exact exploration row count
- integer-only exploitation
- neighbor-only movement
- no revisits
- bounded search area

### 3. It is explainable

This matters for defense.

We can explain every major design choice:

- why exploration is staged
- why IDW is used
- why exploitation is greedy with look-ahead
- why the start point is checked for path viability

So the solution is not just “something that worked”.
It is something that has a clear logic behind it.

### 4. It adapts to unknown surfaces

Because the API is unknown, overfitting to one assumed shape would be risky.

This method works reasonably well whether the surface is:

- smooth
- hill-like
- ridge-like
- multi-peak
- somewhat irregular

It may not be mathematically perfect, but it is robust for a black-box problem with a small budget.

---

## Why we did not use other approaches

### Why not pure random exploration?

Because random sampling wastes too much budget.

Problems with pure random:

- coverage is uneven
- it can miss strong regions entirely
- it gives a messier basis for building the final path

The coarse grid is much more reliable for the first pass.

### Why not full brute force?

Because the search space is too large for the allowed budget.

Even with only integer coordinates, the full grid is about `40,000` points.
We only get `200` exploration calls and `10` exploitation calls.

So brute force is impossible under the rules.

### Why not use only the single best exploration point?

Because one strong point does not tell us the shape around it.

For exploitation we need not just one good tile, but a **connected 10-tile path**.
That depends on the surrounding neighborhood, not just the peak.

### Why not simple hill climbing?

Plain hill climbing is too naive here.

Problems:

- it can get stuck in local optima
- it does not naturally handle no-revisit constraints
- it can walk into dead ends

Our method is still locally greedy, but the continuation check makes it safer.

### Why not a more complex ML model?

Because that would be overkill for the budget and likely harder to justify.

Reasons:

- only 200 exploration samples
- unknown function behavior
- need for a method that is stable and explainable
- exam-time simplicity matters

IDW gives a good tradeoff between quality and simplicity.

### Why not use simulated annealing / genetic algorithm / reinforcement learning?

Mostly because those methods are not a great match for this exact task.

Problems:

- they usually need more evaluations
- they are harder to control under strict movement rules
- they are harder to defend cleanly in a short explanation
- the final problem is not only “find a high point”, but “find a legal 10-step route”

For this assignment, a structured exploration + constrained local path planner is more practical.

---

## If they ask about weaknesses

Be honest here.

Possible weaknesses:

- IDW is still only an approximation
- if the surface is extremely weird or very discontinuous, prediction quality can drop
- the exploitation path is not globally optimal, it is locally greedy with feasibility checks
- with only 200 exploration calls, there is always uncertainty

But the defense is:

- the method is designed for a small budget
- it respects all constraints
- it uses the available information efficiently
- it is robust and explainable

---

## Very short oral summary

If you need a fast spoken version:

> We split the task into exploration and exploitation because the rules are different.  
> In exploration we first scan the whole space with a coarse grid, then refine several separated hotspots, then spend the remaining budget near the best region.  
> To estimate unexplored nearby values we use IDW, where closer explored points matter more than far ones.  
> For exploitation we choose a strong integer start near the best explored area, then greedily move through neighboring tiles using the IDW estimate, but only if the move still allows a full 10-step no-revisit path.  
> So the method is simple, constraint-aware, and practical for an unknown black-box surface with a limited call budget.

---

## If they ask "what is the smartest part?"

Best answer:

> The smartest part is probably not the interpolation itself, but the fact that exploitation checks future path viability.  
> That matters because under the no-revisit rule, a locally best move can still be a bad move if it traps the path early.
