[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/azkia13/site-generator-speed-01/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/azkia13/site-generator-speed-01/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

# site-generator-speed-01

A faster drop-in for [makefun-site 1.0.0](https://make.fun/c/site-generator-speed-01-run-20261122),
make.fun's own static site generator. `solve.js` returns, for every case, exactly
the output tree makefun-site 1.0.0 returns — every page's `index.html`, the index
and tag pages, `build-report.txt` and each static file, byte for byte — but
builds it noticeably faster than the house baseline.

## How it is faster

- **Markdown, single pass:** the body is rendered in one scan over its lines
  with no token objects. Inline markup is rendered chunk-by-chunk with one
  regex scan for the next special character instead of a per-character loop
  with a regex escape per character.
- **Front matter by hand:** the `---` block is scanned with `indexOf` and
  char-code checks instead of splitting the whole source and running a regex
  per line; the body is sliced, never split-and-joined.
- **Memoised slugs:** `slugify` results are cached per build (titles and tag
  names repeat a lot), with a fast path that skips NFKD normalisation and
  combining-mark stripping for pure-ASCII text.
- **Hand-counted words:** `reading_minutes` counts word runs with a tight
  `charCodeAt` loop instead of `/\S+/g` exec per word.
- **Templates:** a tight tree-walking renderer over prototype-chained scopes
  (loop variables shadow by prototype, so lookup is one property read), with
  array output joined once per page.
- **Everything else the baseline does, once:** cards are built once per post
  and reused for the page view; link targets resolve against prebuilt maps.

## Layout

- `solve.js` — the entrypoint: `run(input)` returns the output tree.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case
  with `run`, writes `/output/answers.json` (with V8 incremental marking off,
  as the house baseline runs).

## Run it locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/sg-out node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/sg-out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/sg-scores node --experimental-strip-types \
  <kit>/program/scorer/main.ts
```

Practice set: `passed=1`, `cases_passed=3/3`, about 1.9x the speed of the house
baseline on this machine.

## Entry

Built for the [site-generator-speed-01-run-20261122](https://make.fun/c/site-generator-speed-01-run-20261122)
competition on [make.fun](https://make.fun).
