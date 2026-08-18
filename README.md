# Electricity Management Dashboard — AOR / GE(N) Maint Isld

A power-monitoring dashboard for the 360-acre complex. Every monitored location
carries a stable **tag ID**, reports live demand, and is checked against a
**consumption limit** — with the alarm behaviour a control room actually needs
rather than a naive `value > limit` test.

Built from the asset register in `AOR - GE (N) Maint Isld.docx`.

> ### Read this before trusting a number
> The source register is an **asset inventory**, not a telemetry archive. It
> contains **no metering of any kind** — searching it for *voltage*, *frequency*,
> *power factor*, *MVAR*, *kWh*, *generator*, *incomer* or *breaker* returns
> **zero** hits.
>
> So the dashboard marks every figure with its provenance:
>
> | Badge | Meaning |
> |---|---|
> | **REG** | stated in the asset register — asset counts, transformer capacity, topology, named locations |
> | **SIM** | simulated — every live electrical reading, because no measured data exists |
>
> Simulated values are not invented independently: they are derived from the
> modelled real power using standard three-phase relationships
> (`S = sqrt(3)·V·I`, `Q = P·tan(acos PF)`), so they stay physically consistent
> with one another.
>
> **The register records no diesel generators and no 132 kV intake**, so neither
> is modelled. The single-line diagram shows the documented 11 kV network only.

---

## Run it

```bash
node server/mock-scada.js      # or: npm start
```

Then open **http://localhost:8787/** (pass `--port` to change it).

That starts a zero-dependency mock SCADA server which serves the dashboard *and*
a simulated telemetry feed over the same REST + SSE path your real system will
use — so the network path is exercised for real, not faked in the browser.

```bash
npm test        # register reconciliation + alarm-engine behaviour (29 checks)
npm run check   # register reconciliation only
```

No dependencies, no build step. Node 18+.

### Running from a clone

**`package.json` is deliberately not committed to this repository.** The browser
dashboard does not need it, but Node does: it carries `"type": "module"`, and
without it `node server/mock-scada.js` fails with *"Cannot use import statement
outside a module"*.

After cloning, create it in the project root:

```json
{
  "name": "aor-power-load-monitor",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server/mock-scada.js",
    "check": "node scripts/verify-register.js",
    "test": "node scripts/verify-register.js && node scripts/test-alarms.js"
  }
}
```

There are no dependencies, so there is nothing to `npm install`.

---

## The screens

A left nav switches between them. The layout fits **390 px phones through
2560 px wall displays** — verified at nine widths with zero horizontal overflow.

| Screen | What it shows |
|---|---|
| **Overview** | 6-KPI electrical strip (MW / MVAR / PF / Hz / kV / kWh), load trend vs typical, active alarms, power-distribution donut, load by category, energy gauge and summary, 11 kV single-line diagram, 3-phase voltage profile with statutory limits, secondary metrics, register data gaps |
| **Power Flow** | Sankey-style flow from source through the 11 kV bus to substations to load groups, with link thickness proportional to power; losses and delivery efficiency; feeder loading against installed capacity |
| **Load Monitoring** | Every monitored location: tag, live kW, typical, vs typical, limit, % of limit, trend, status, age. Searchable, sortable, filterable. Click a row for its trend with limit lines drawn on it, plus its alarm history |
| **Voltage & Frequency** | System frequency against the 49.5–50.5 Hz band, per-substation 3-phase L-L voltage with statutory limits, worst phase imbalance, and a per-substation table of voltage / imbalance / current / PF / kVAr |
| **Energy Analytics** | Energy consumed, average and peak demand, load factor; energy mix (import vs solar vs losses); load-duration curve; energy by group; top-10 consumers |
| **Solar** | Fleet output against installed capacity with an expected-output marker, performance ratio, generation trend vs expected, and a per-array table with under-output status |
| **Transformers** | The 109-unit fleet and its 18,530 kVA — entirely register-derived, no simulation |
| **Switchgear** | Status grid for the 8 VCBs at 11 kV across their four register-named sites, feeder loading, and a distribution-board summary |
| **Alarms & Events** | Active alarms plus the full log — raised / acknowledged / cleared, nothing disappears silently |
| **Reports** | Session summary, consumption and energy by group, substation utilisation, CSV export |
| **Forecasting** | 24-hour demand projection with a confidence band widening by horizon, forecast peak and headroom against firm capacity, and a forecast-points table |
| **Settings** | Full data-provenance statement and the register reconciliation gaps |

Every nav destination is a real page. Where a page would need data the register
does not contain, it says so on the page rather than inventing it — the
Forecasting page states plainly that it is a profile-based projection and not a
trained prediction, because no historical consumption exists to train on, and
the Switchgear page notes that breaker positions are simulated while the device
population and its four sites come from the document.

Light/dark themes, plus a **wall-display density** toggle (the `A` button) that
enlarges everything for a screen read from across a room.

## The alarm engine

Getting this wrong is the usual failure mode of dashboards like this, so the
rules are explicit (`src/limits.js`):

- **Three severity tiers only** — Normal → Warning → Over limit. There is no fourth.
- **Status is never colour alone.** Every badge is icon + word + colour.
- **On-delay.** A limit must be exceeded *continuously* for 6 s before an alarm
  raises. One noisy sample cannot trip it.
- **Hysteresis + off-delay.** Clearing requires falling 4 % below the limit and
  staying there for 12 s, so a value hovering on the threshold cannot chatter.
- **One episode per point.** While an alarm is open, further breaches *escalate
  the existing episode* rather than raising a new one. This is the anti-flooding rule.
- **Re-arm.** After an episode closes, the same point cannot re-raise at the same
  severity for 90 s. A *higher* severity always bypasses it.
- **Condition ≠ annunciation.** While annunciation is held by the re-arm window,
  the point still *displays* as over limit. Anti-flood machinery must never hide
  a genuine fault.
- **Latched and acknowledged.** Alarms persist until acknowledged. An alarm that
  clears *before* being acknowledged stays visible (ringback) — nothing ever
  disappears silently. Re-escalation clears a prior acknowledgement.
- **Full audit.** Every episode records raised / acknowledged / cleared times,
  the limit breached, and the peak reached. Exportable as CSV.

### Data quality is a separate axis from severity

An offline meter and a meter reading 0 kW are different facts and never collapse
into each other:

| State | Meaning |
|---|---|
| `good` | fresh sample |
| `pending` | not heard from *yet* (start-up) — deliberately not an alarm |
| `stale` | last sample older than 15 s |
| `offline` | last sample older than 40 s — raises a **comms** alarm, shown distinctly |
| `bad` | meter reported bad quality — limits are not evaluated on it |

A point absent from a payload keeps its last known value and is counted as *not
reporting*. It is never silently treated as zero.

### Feed health

The whole feed is watchdogged independently of message content: `live` →
`degraded` (8 s silence) → `down` (25 s silence). When the feed dies, a banner
says so loudly and the view dims, rather than freezing on stale values while
looking healthy.

### Smoothing

Readings are EMA-smoothed (6 s time constant) before display *and* before limit
evaluation, so sensor jitter doesn't read as plant instability. The unsmoothed
sample is shown in the point detail and the tooltip, so the filtering is visible.

---

## Connecting your real SCADA

**This is the only seam you need to touch.** Point the source at your endpoint —
no other file changes.

In `src/app.js`:

```js
const source = createSource(monitored, register.GROUPS, {
  mode: 'sse',                      // 'sse' | 'poll' | 'sim'
  streamUrl:   'https://scada.example/api/stream',
  readingsUrl: 'https://scada.example/api/readings',
  intervalMs: 2000,                 // poll period
});
```

The source mode is also switchable at runtime from the dropdown in the header.

### Payload contract

Both `poll` and `sse` expect this shape (SSE: one JSON object per `data:` frame):

```json
{
  "ts": 1785755194099,
  "daylight": true,
  "readings": [
    { "id": "TW-01", "kW": 14.8, "ts": 1785755194099, "quality": "good" },
    { "id": "MED-HOSP", "kW": 291.4, "ts": 1785755194099, "quality": "good" }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | must match a tag in `src/register.js` |
| `kW` | instantaneous demand. **Generation points report positive output.** |
| `ts` | when the sample was taken **at the meter**, not when it arrived. Staleness is measured from this — do not substitute arrival time. |
| `quality` | `good` or `bad` |
| `daylight` | optional; gates solar under-performance limits. Computed locally if omitted. |

**A meter you cannot reach must be omitted from `readings` entirely — never sent
as `0`.** That distinction is what separates "offline" from "drawing nothing",
and sending zeros destroys it.

The reader is tolerant of common aliases (`tag`/`pointId` for `id`,
`kw`/`value` for `kW`, `timestamp` for `ts`) — see `normalise()` in
`src/source.js`.

For another transport (OPC-UA, Modbus, MQTT), add a mode in `src/source.js` that
emits the same normalised object. Everything above that line is unchanged.

### Replacing the register

`src/register.js` is the single source of truth for what is monitored, shared by
the browser and the server. Replace it with an export from your SCADA point
database. Each point needs at minimum:

```js
{ id, name, location, groupId, substationId, units, unitKw, ratedKw,
  warnKw, alarmKw, monitored: true }
```

Then run `npm run check` — it re-reconciles the register against the document's
stated totals and validates that every limit ladder is coherent.

### Deleting the simulator

Once live, `src/simulator.js` can be deleted along with `server/`. Only
`src/source.js` imports it (and `src/store.js` uses its demand curves as the
"typical load" reference — see below).

---

## Where the numbers come from

Counts and named locations are **from the register** and reconcile exactly to its
own totals — `npm run check` proves it on every run:

| Reconciled against the document | |
|---|---|
| Buildings | **2,157** (the document's own G Total) |
| Transformers | **109** units, **18,530 kVA** installed (1250×1, 630×1, 200×73, 100×20, 50×1, + 13 satellite stations) |
| Tube wells | 14 (11 named with locations) · Filter plants 4 · OHWT 3 · UGWT 42 |
| Motor pumps 84 · Reedbeds 4 · Street/flood lights 980 · Solar 13 |
| Elevators 15 + lifts 5 · Outstations 16 · DBs 475 · 3 feeders, 3 substations |

### ⚠ What is estimated

**The source register contains no metered consumption.** Every kW figure is an
engineering estimate:

- **Unit kW ratings** — assumed per asset type (bungalow ≈ 7.5 kW, tube well ≈ 15 kW,
  hospital block ≈ 45 kW…). Every limit derives from these, so **every limit is
  an estimate too**.
- **Feeder allocation** — which loads sit on which of the 3 feeders is not stated
  in the register. Correct it from the site single-line diagram.
- **Per-substation transformer split** — the fleet total is from the document; its
  allocation across PNS Hafeez / ARC / NHQ is assumed (it still sums exactly to
  109 units and 18,530 kVA).
- **Circuit splits** — street lighting, motor pumps and vertical transport are
  given only as totals, so they are split into circuits/areas to be separately
  meterable. The split is assumed.
- **"Typical for this hour"** — currently modelled from demand-profile curves per
  asset class. In production, replace with a trailing same-hour median from your
  historian (`expectedFactor` in `src/simulator.js`, consumed by `src/store.js`).

These are flagged in the UI — in the "Register data gaps" panel, as `estimate`
chips in the point detail, and in the page footer — so nothing assumed is ever
mistaken for something measured.

### Discrepancies found in the register

Surfaced rather than silently patched — these are questions for the facility team:

- The register states **14 tube wells, 12 operational**, but lists **11** with
  locations. One operational tube well is unaccounted for. TW-02/06/12 have no
  register entry and are carried as *not monitored*.
- Satellite station transformer ratings are not stated, so outstation capacity is
  recorded as unknown rather than zero.

---

## Layout

```
index.html              shell, left nav, both themes, icon sprite
src/
  register.js           point register - tag ids, limits, feeders   <- replace from SCADA
  source.js             data source: sim | sse | poll + watchdog    <- the integration seam
  limits.js             alarm engine
  store.js              history, EMA smoothing, roll-ups
  electrical.js         derived V / I / PF / Hz / kVAR / energy     <- all SIM
  switchgear.js         breaker / feeder / DB state model           <- positions SIM
  overview.js           overview screen + transformers page
  pages.js              flow / voltage / energy / solar / switchgear / forecast
  ui.js                 point table, alarms, drawer, reports
  charts.js             trend / sparkline / bars
  charts-power.js       donut / gauge / voltage profile / SLD
  charts-pages.js       power flow / status grid / forecast band / duration curve
  format.js             units and precision
  simulator.js          stand-in feed - delete once live
server/mock-scada.js    zero-dep server: static + /api/readings + /api/stream + /api/points + /api/health
scripts/
  verify-register.js    reconciles the register against the document
  test-alarms.js        behavioural tests for the alarm engine
```

**Rendering is decoupled from the data rate.** Readings are folded in whenever
they arrive; the screen repaints on a fixed 1 s tick, and only the cells whose
values changed are written. A fast feed can't thrash the DOM, and — more
importantly — a feed that *stops* still repaints, so staleness surfaces on its own.

---

## Accessibility & environment

- Status always reads as icon + word, never colour alone; palette validated for
  colour-vision deficiency against both surfaces.
- The point table *is* the table view — every charted value is readable as text.
- Rows, charts and alarm actions are keyboard reachable (`Tab`, `Enter`, `←`/`→`
  to scrub a chart, `Esc` to close the detail panel); hit targets sized for touch panels.
- Light and dark are separately chosen palettes, not an inversion.
- Wall-display density for mounted screens.
- Respects `prefers-reduced-motion`.
