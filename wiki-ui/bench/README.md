# Navigation-latency benchmark

Measures **sidebar click → the new page's body painted**, and splits it across the stack so a
slow number can be attributed instead of guessed at.

## Run it

```bash
npm run bench                  # from wiki-ui/ — seeds, builds, serves, measures
BENCH_SKIP_BUILD=1 npm run bench   # reuse .next-bench (the build dominates iteration time)
node bench/compare.mjs         # the two most recent runs, side by side
```

It is safe to run while `next dev` is up: the bench builds and serves out of `.next-bench`
(`NEXT_DIST_DIR` in `next.config.mjs`) and never touches the dev server's `.next/`. Ports are
fixed — 4470 for the stream host, 3110 for the bench UI — because `NEXT_PUBLIC_*` are inlined at
build time, so the stream URL must be known before the build runs.

## What it measures

The app carries always-on instrumentation (`lib/perf.ts`), so these spans are also visible by
hand: open any page, click around, then `await window.__wikiPerf.peek()` in the console, or look
at the Timings track in a DevTools performance recording.

| metric | span |
|---|---|
| `clickToPainted` | the headline — the click, to the frame carrying the new body |
| `routeCommitMs` | click → route commit: the Next App Router hop, before the engine is asked anything |
| `toMarkdownMs` | the page-render RPC, as the tab sees it (queue + engine + transfer) |
| `describeMutationsMs` | the second RPC every navigation makes, whether or not the model view is open |
| `renderMarkdownMs` | Markdown → HTML |
| `commitToPaint` | React commit + `innerHTML` + style/layout |

`clickToPainted` is measured with a double `requestAnimationFrame`, so it over-reports by up to
one frame (~16 ms) and quantizes to frame boundaries. The bias is uniform, so comparisons hold;
absolute values carry that tail.

## Scenarios

**`warm-repeat` is the headline.** The engine is up, the workspace is folded, and the same two
pages are opened over and over — so anything visible there is paid on *every* click. The others
exist to separate that from things that are paid once.

| | |
|---|---|
| `warm-repeat` | A↔B, 24 clicks, first 4 discarded |
| `large-page-in` / `-out` | small↔~300 KB page — separates render/parse from fixed overhead |
| `deep-tree` | a depth-3 page |
| `warm-first-click` | a page never read before, fresh context per sample |
| `cold` | fresh context, empty IndexedDB: page load → first paint, incl. the ~8 MB pglite wasm compile |

Targets **must alternate**: `TreeItem.activate()` is `if (!isActive) router.push(href)`, so
clicking the row that is already open navigates nowhere and records nothing.

## The fixture

`bench/fixture/seed.ts` builds 111 pages over three levels — 3 KB, 24 KB and one 310 KB page,
with ~15% of paragraphs carrying a page ref so the link-rewrite path is exercised. It reseeds
from scratch each run (~6 s) and is byte-identical every time: the clock and ids are pure
counters and every text choice comes from a fixed-seed xorshift. A second workspace exists only
so `primeSearchIndex()`, which opens every active workspace, is priced realistically.

Bump `FIXTURE_VERSION` when the corpus changes. `compare.mjs` refuses to put two versions on one
axis, and it refuses across CPU architectures for the same reason.

## Reading the numbers honestly

- **Compare only same-machine, same-session runs.** Thermal state, background work and power
  source move these more than most code changes will.
- Results land in `bench/results/` and are gitignored. Raw per-navigation samples are kept
  alongside the summary, so stats can be re-derived and bimodality spotted — a scenario whose
  p50 and min differ by an order of magnitude is telling you something the p50 alone hides.
- The median is the headline. A mean over browser timings is dominated by GC and JIT outliers.
- Headless has no display: "painted" means a frame was produced, not photons.
- Not wired into CI — hosted runners vary too much in CPU for the timings to mean anything. The
  assertions that *are* machine-independent (exactly one `toMarkdown` and one
  `describeMutations` per navigation) live in the spec and would survive a move to CI.
