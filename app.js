/* PAL Data Sorter — front-end logic (Model B: open, read-only).
   Loads a shared cached snapshot (standings + every player's match history) from
   /api/snapshot and renders it — no login. A single top-bar Refresh asks the
   server to re-scrape (service account); it's capped to once per hour, so the
   button greys out with a countdown in between. All sorting/filtering is local. */

const $ = (s) => document.querySelector(s);

// ---- column definitions --------------------------------------------------
const BASE_COLUMNS = [
  { key: "rank",   label: "#",           type: "rank" },
  { key: "name",   label: "Player",      type: "text" },
  { key: "GP",     label: "Points",      type: "num" },
  { key: "GPMP",   label: "Pts / Match", type: "num" },
  { key: "MW",     label: "Match Wins",  type: "num" },
  { key: "ML",     label: "Losses",      type: "num" },
  { key: "MP",     label: "Matches",     type: "num" },
  { key: "winPct", label: "Win %",       type: "num" },
];
const GRANULAR_COLUMNS = [
  { key: "fargo",  label: "Fargo",         type: "num" },
  { key: "avgOpp", label: "Avg Opp Fargo", type: "num" },
];
const DETAIL_COLUMNS = [
  { key: "idx",      label: "#",         type: "rank" },
  { key: "dateISO",  label: "Date",      type: "date" },
  { key: "opponent", label: "Opponent",  type: "text" },
  { key: "oppFargo", label: "Opp Fargo", type: "num" },
  { key: "score",    label: "Score",     type: "text", sortable: false },
  { key: "spot",     label: "Spot",      type: "num" },
  { key: "playedAs", label: "Performance", type: "num" },
  { key: "result",   label: "Result",    type: "text" },
];
const DEFAULT_SORT = { key: "GP", dir: "desc" };

const state = {
  data: null,
  league: null, bracket: null, showBracketCol: false,
  sort: { ...DEFAULT_SORT },
  view: "standings",                    // "standings" | "player"
  detail: null, detailTab: "insights",  // "insights" | "matches"
  detailSort: { key: "dateISO", dir: "asc" },
  granular: { loaded: false, byId: {}, fetchedAt: null },
  refreshing: false,
  hiddenCols: new Set(),   // column keys the user chose to hide
  mode: "standings",       // "standings" | "h2h"
  h2h: { a: null, b: null, basis: "fargo" },  // basis: "fargo" | "form"; league = global state.league
  collapsed: false,
};

// ---- storage helpers -----------------------------------------------------
const store = {
  // cache the last snapshot so a reload paints instantly before the fetch lands
  cacheData(d) { try { sessionStorage.setItem("pal.snapshot", JSON.stringify(d)); } catch (_) {} },
  cachedData() { try { return JSON.parse(sessionStorage.getItem("pal.snapshot") || "null"); } catch (_) { return null; } },
  theme() { try { return localStorage.getItem("pal.theme"); } catch (_) { return null; } },
  saveTheme(t) { try { localStorage.setItem("pal.theme", t); } catch (_) {} },
  hiddenCols() { try { return new Set(JSON.parse(localStorage.getItem("pal.hiddenCols") || "[]")); } catch (_) { return new Set(); } },
  saveHiddenCols(set) { try { localStorage.setItem("pal.hiddenCols", JSON.stringify([...set])); } catch (_) {} },
  collapsed() { try { return localStorage.getItem("pal.collapsed") === "1"; } catch (_) { return false; } },
  saveCollapsed(v) { try { localStorage.setItem("pal.collapsed", v ? "1" : "0"); } catch (_) {} },
};

// ---- theme ---------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelectorAll(".theme-toggle").forEach((b) => { b.textContent = t === "dark" ? "☀️" : "🌙"; });
}
function initTheme() {
  const t = store.theme() || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(t);
}
document.querySelectorAll(".theme-toggle").forEach((b) => b.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  store.saveTheme(next); applyTheme(next);
}));

// ---- formatting ----------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function fmtNum(v, key) {
  if (v === null || v === undefined) return "—";
  if (key === "GPMP" || key === "avgOpp") return Number(v).toFixed(key === "avgOpp" ? 1 : 2);
  if (key === "winPct") return Number(v).toFixed(1) + "%";
  return v;
}
function fmtDate(iso, raw) {
  if (!iso) return raw ? escapeHtml(raw) : "—";
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) +
    " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---- generic sort + table renderer --------------------------------------
function sortRows(rows, sort, columns) {
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows.slice();
  const mult = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    if (col.type === "text") {
      return mult * String(av ?? "").localeCompare(String(bv ?? ""));
    }
    // num / date: nulls always last regardless of direction
    const an = av === null || av === undefined, bn = bv === null || bv === undefined;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (col.type === "date") return mult * (av < bv ? -1 : av > bv ? 1 : 0);
    return mult * (av - bv);
  });
}

// opts: { sortState, onSort, rowClick, cell(row,col,i)->html, extraCols }
function renderTable(columns, rows, opts) {
  const cols = columns.concat(opts.extraCols || []);
  // thead
  const trh = document.createElement("tr");
  cols.forEach((c) => {
    const th = document.createElement("th");
    if (c.type === "text" || c.type === "date" || c.type === "rank") th.className = "text";
    th.classList.add("col-" + c.key);
    const sortable = c.sortable !== false && c.type !== "rank" && opts.onSort;
    if (sortable) {
      const active = opts.sortState.key === c.key;
      th.setAttribute("aria-sort", active ? opts.sortState.dir : "none");
      th.innerHTML = escapeHtml(c.label) + ' <span class="arrow">' +
        (active ? (opts.sortState.dir === "asc" ? "▲" : "▼") : "▼") + "</span>";
      th.onclick = () => opts.onSort(c);
    } else {
      th.textContent = c.label;
      th.style.cursor = "default";
    }
    trh.appendChild(th);
  });
  const thead = $("#thead"); thead.innerHTML = ""; thead.appendChild(trh);

  // tbody
  const tbody = $("#tbody"); tbody.innerHTML = "";
  $("#emptyState").classList.toggle("hidden", rows.length > 0);
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = cols.map((c) => opts.cell(r, c, i)).join("");
    tr.querySelectorAll("td").forEach((td, idx) => td.classList.add("col-" + cols[idx].key));
    if (opts.rowClick) { tr.classList.add("row-click"); tr.onclick = () => opts.rowClick(r); }
    tbody.appendChild(tr);
  });
}

// ---- network -------------------------------------------------------------
async function fetchSnapshot() {
  const res = await fetch("/api/snapshot");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function triggerRefresh() {
  const res = await fetch("/api/refresh", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- single manual refresh (server scrapes; capped at once per hour) ------
const COOLDOWN_MS = 60 * 60 * 1000;
document.querySelectorAll(".refresh-btn").forEach((b) => b.addEventListener("click", doRefresh));

async function doRefresh() {
  if (state.refreshing) return;
  if (cooldownRemaining() > 0) { flashMeta(`Data's fresh — try again in ${Math.ceil(cooldownRemaining() / 60000)}m`); return; }
  state.refreshing = true;
  showTopProgress(true); updateFreshness(); updateRefreshButton();
  try {
    const r = await triggerRefresh();
    if (r.ok) {
      onData(await fetchSnapshot(), { keepView: true });
    } else if (r.status === 429) {
      flashMeta(r.data.error || "Data is fresh — try again shortly.");
    } else {
      flashMeta(r.data.error || "Refresh failed.");
    }
  } catch (_) {
    flashMeta("Refresh failed — check your connection.");
  } finally {
    state.refreshing = false; showTopProgress(false); updateFreshness(); updateRefreshButton();
  }
}

function cooldownRemaining() {
  if (!state.granular.fetchedAt) return 0;
  return Math.max(0, COOLDOWN_MS - (Date.now() - new Date(state.granular.fetchedAt).getTime()));
}
function updateRefreshButton() {
  const wait = cooldownRemaining();
  document.querySelectorAll(".refresh-btn").forEach((btn) => {
    if (state.refreshing) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    else if (wait > 0) { btn.disabled = true; btn.textContent = `Refresh in ${Math.ceil(wait / 60000)}m`; }
    else { btn.disabled = false; btn.textContent = "Refresh"; }
  });
}
let _metaTimer = null;
function flashMeta(msg) {
  document.querySelectorAll(".freshness").forEach((m) => { m.textContent = msg; });
  clearTimeout(_metaTimer); _metaTimer = setTimeout(updateFreshness, 4000);
}

// ---- once we have data ---------------------------------------------------
function onData(snap, opts = {}) {
  state.data = { order: snap.order || [], leagues: snap.leagues || {} };
  state.granular.byId = snap.byId || {};
  state.granular.loaded = Object.keys(state.granular.byId).length > 0;
  state.granular.fetchedAt = snap.fetchedAt || null;
  store.cacheData(snap);
  const hasData = state.data.order.length > 0;
  if (!opts.keepView || !state.league) {
    state.league = hasData ? (state.data.order[0]) : null;
    state.sort = { ...DEFAULT_SORT };
    state.view = "standings"; state.detail = null;
    if (state.league) pickDefaultBracket();
  }
  renderAll();
}

// the one "last updated" indicator (mirrored to sidebar + mobile top bar)
function updateFreshness() {
  const txt = state.refreshing ? "Refreshing… (this can take a minute or two)"
    : state.granular.fetchedAt ? `Updated ${relAge(state.granular.fetchedAt)}` : "No data yet";
  document.querySelectorAll(".freshness").forEach((m) => { m.textContent = txt; });
}
function showTopProgress(on) { $("#topProgress").classList.toggle("hidden", !on); }

function bracketsFor(league) { return Object.keys(state.data.leagues[league].brackets).sort(); }
function pickDefaultBracket() {
  const labels = bracketsFor(state.league);
  state.bracket = labels.length > 1 ? "__both__" : labels[0];
}
function relAge(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}


// ---- sidebar navigation --------------------------------------------------
const ICON_BUILDING = '<svg class="scope-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 21v-4h6v4"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01"/></svg>';
const ICON_CHEV = '<svg class="scope-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// crucible-style scope switcher, rendered into any container (sidebar + mobile)
function renderScope(container) {
  if (!container) return;
  const name = state.data.leagues[state.league] ? state.data.leagues[state.league].name : "—";
  container.innerHTML =
    `<button class="scope-btn" aria-haspopup="listbox" aria-expanded="false" title="Division: ${escapeHtml(name)}">` +
      ICON_BUILDING +
      `<span class="scope-text"><span class="scope-cap">Division</span><span class="scope-name">${escapeHtml(name)}</span></span>` +
      ICON_CHEV +
    `</button>` +
    `<div class="scope-menu hidden" role="listbox">` +
      state.data.order.map((k) =>
        `<button class="scope-opt" role="option" data-league="${k}">` +
        `<span class="check${k === state.league ? "" : " hidden-check"}">${ICON_CHECK}</span>` +
        `<span>${escapeHtml(state.data.leagues[k].name)}</span></button>`).join("") +
    `</div>`;
  const menu = container.querySelector(".scope-menu");
  container.querySelector(".scope-btn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  menu.querySelectorAll(".scope-opt").forEach((o) => o.onclick = () => {
    menu.classList.add("hidden");
    const k = o.dataset.league;
    if (k !== state.league) { state.league = k; pickDefaultBracket(); state.h2h.a = null; state.h2h.b = null; renderAll(); }
  });
}

function renderSidebar() {
  renderScope($("#divisionSwitch"));
  renderScope($("#divisionSwitchMobile"));
  // nav items — sidebar + mobile tab bar (all [data-mode] triggers)
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.setAttribute("aria-current", state.mode === b.dataset.mode ? "page" : "false");
    b.onclick = () => {
      const target = b.dataset.mode;
      // a top-level nav click always lands on that view's default
      if (target === "standings") { state.view = "standings"; state.detail = null; }
      state.mode = target;
      renderAll();
    };
  });
  // collapse
  $("#app").classList.toggle("collapsed", state.collapsed);
  const cb = $("#collapseBtn");
  if (cb) {
    const chevL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
    const chevR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
    cb.innerHTML = state.collapsed ? chevR : chevL;
    cb.setAttribute("aria-label", state.collapsed ? "Expand sidebar" : "Collapse sidebar");
    cb.onclick = () => {
      state.collapsed = !state.collapsed;
      store.saveCollapsed(state.collapsed);
      $("#app").classList.toggle("collapsed", state.collapsed);
      cb.innerHTML = state.collapsed ? chevR : chevL;
      cb.setAttribute("aria-label", state.collapsed ? "Expand sidebar" : "Collapse sidebar");
    };
  }
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".scope-switch")) document.querySelectorAll(".scope-menu").forEach((m) => m.classList.add("hidden"));
});

function renderBracketSeg() {
  const labels = bracketsFor(state.league);
  const group = $("#bracketGroup"), seg = $("#bracketSeg");
  seg.innerHTML = "";
  if (labels.length < 2) { group.classList.add("hidden"); return; }
  group.classList.remove("hidden");
  const options = [
    ...labels.map((l) => ({ v: l, t: l.length === 1 ? "Bracket " + l : l })),
    { v: "__both__", t: "Both" },
  ];
  options.forEach((o) => {
    const btn = document.createElement("button");
    btn.textContent = o.t;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.bracket === o.v);
    btn.onclick = () => { state.bracket = o.v; renderBracketSeg(); renderStandingsTable(); renderStats(); };
    seg.appendChild(btn);
  });
}

function standingsColumnsAll() {
  return state.granular.loaded ? BASE_COLUMNS.concat(GRANULAR_COLUMNS) : BASE_COLUMNS.slice();
}
// visible columns = all minus the ones the user hid (# and Player always stay)
function standingsColumns() {
  return standingsColumnsAll().filter((c) => !state.hiddenCols.has(c.key));
}
// columns the user is allowed to hide, in display order
function toggleableColumns() {
  return standingsColumnsAll().filter((c) => c.key !== "rank" && c.key !== "name");
}

function currentRows() {
  const labels = bracketsFor(state.league);
  const brackets = state.data.leagues[state.league].brackets;
  let rows = [];
  if (state.bracket === "__both__" || labels.length < 2) {
    labels.forEach((l) => brackets[l].forEach((r) => rows.push({ ...r, bracket: l })));
    state.showBracketCol = labels.length > 1;
  } else {
    rows = brackets[state.bracket].map((r) => ({ ...r, bracket: state.bracket }));
    state.showBracketCol = false;
  }
  if (state.granular.loaded) {
    rows = rows.map((r) => {
      const g = state.granular.byId[r.team_id];
      return { ...r, fargo: g ? g.fargo : null, avgOpp: g ? g.avgOpp : null };
    });
  }
  return sortRows(rows, state.sort, standingsColumnsAll());  // sort works even if that column is hidden
}

function standingsCell(r, c, i) {
  if (c.key === "rank") return `<td class="rank">${i + 1}</td>`;
  if (c.key === "name") {
    const disc = state.granular.loaded ? '<span class="disclosure">›</span>' : "";
    return `<td class="text name"><span class="nm">${escapeHtml(r.name)}</span>${disc}</td>`;
  }
  if (c.key === "bracket") return `<td class="text"><span class="badge">${escapeHtml(r.bracket)}</span></td>`;
  return `<td>${fmtNum(r[c.key], c.key)}</td>`;
}

function renderStandingsTable() {
  const cols = standingsColumns();
  const extra = state.showBracketCol ? [{ key: "bracket", label: "Bkt", type: "text", sortable: false }] : [];
  renderTable(cols, currentRows(), {
    sortState: state.sort,
    onSort: (c) => {
      if (state.sort.key === c.key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else { state.sort.key = c.key; state.sort.dir = c.type === "text" ? "asc" : "desc"; }
      renderStandingsTable();
    },
    rowClick: state.granular.loaded ? (r) => openDetail(r) : null,
    cell: standingsCell,
    extraCols: extra,
  });
}

// ---- column filter -------------------------------------------------------
function renderColumnMenu() {
  const wrap = $("#colMenuWrap"); if (!wrap) return;
  const cols = toggleableColumns();
  const hiddenCount = cols.filter((c) => state.hiddenCols.has(c.key)).length;
  const label = hiddenCount ? `Columns (${cols.length - hiddenCount}/${cols.length})` : "Columns";
  wrap.innerHTML =
    `<button class="btn btn-secondary btn-sm" id="colBtn" aria-haspopup="true">${label} ▾</button>` +
    `<div class="col-menu hidden" id="colMenu">` +
      `<div class="col-menu-head">Show columns</div>` +
      cols.map((c) =>
        `<label class="col-opt"><input type="checkbox" data-key="${c.key}"` +
        `${state.hiddenCols.has(c.key) ? "" : " checked"}> ${escapeHtml(c.label)}</label>`).join("") +
      `<button class="col-menu-all" id="colAll">Show all</button>` +
    `</div>`;
  const menu = $("#colMenu");
  $("#colBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  menu.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) state.hiddenCols.delete(cb.dataset.key);
      else state.hiddenCols.add(cb.dataset.key);
      store.saveHiddenCols(state.hiddenCols);
      renderStandingsTable(); renderColumnMenu(); $("#colMenu").classList.remove("hidden");
    };
  });
  $("#colAll").onclick = () => {
    state.hiddenCols.clear(); store.saveHiddenCols(state.hiddenCols);
    renderStandingsTable(); renderColumnMenu(); $("#colMenu").classList.remove("hidden");
  };
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#colMenuWrap")) { const m = $("#colMenu"); if (m) m.classList.add("hidden"); }
});

function renderStats() {
  const rows = currentRows(), rated = rows.filter((r) => r.MP > 0);
  const avg = (arr, k) => arr.length ? (arr.reduce((s, r) => s + r[k], 0) / arr.length) : 0;
  const rf = rows.filter((r) => r.fargo != null);
  const avgFargo = rf.length ? Math.round(avg(rf, "fargo")) : "—";
  const tiles = [
    { k: "Players", v: rows.length },
    { k: "Avg Points", v: avg(rated, "GP").toFixed(1) },
    { k: "Avg Pts / Match", v: avg(rated, "GPMP").toFixed(2) },
    { k: "Avg Fargo", v: avgFargo },
  ];
  $("#stats").innerHTML = tiles.map((t) =>
    `<div class="stat"><div class="k">${t.k}</div><div class="v">${t.v}</div></div>`).join("");
}

// ==========================================================================
// FargoRate math  (see the ⓘ popovers in the UI for the plain-English version)
//
//   p(win a game)      = 2^(Δ/100) / (1 + 2^(Δ/100)),  Δ = yourFargo − oppFargo
//                        → a 100-pt edge = 2:1 games (66.7%); 200 = 4:1 (80%).
//   played-as (1 match)= oppFargo + 100·log2(gamesWon / gamesLost)   [on-table]
//   played-as (session)= the rating R where Σ expected game-wins = actual wins
//                        (maximum-likelihood — the same method FargoRate uses).
//
// "On-table" games remove the spot: bonus points are games the lower-rated
// player is given on the wire, so games actually won = official score − BP.
// ==========================================================================
const FARGO = {
  pGame(r, ropp) { return 1 / (1 + Math.pow(2, -(r - ropp) / 100)); },
  playedAsMatch(wg, lg, ropp) {
    if (wg + lg === 0) return null;
    let w = wg, l = lg;
    if (l === 0) l = 0.5;          // continuity at a shutout, so it stays finite
    if (w === 0) w = 0.5;
    return Math.round(ropp + 100 * Math.log2(w / l));
  },
  playedAsSession(perMatch) {
    const games = perMatch.filter((m) => m.ropp != null && (m.wg + m.lg) > 0);
    const total = games.reduce((s, m) => s + m.wg + m.lg, 0);
    const won = games.reduce((s, m) => s + m.wg, 0);
    if (total === 0) return null;
    if (won <= 0) return 200;                 // lost every on-table game (floor)
    if (won >= total) return 900;             // won every on-table game (cap)
    const expWins = (R) => games.reduce((s, m) => s + (m.wg + m.lg) * this.pGame(R, m.ropp), 0);
    let lo = 200, hi = 900;
    for (let i = 0; i < 60; i++) {            // binary search — expWins is monotonic in R
      const mid = (lo + hi) / 2;
      if (expWins(mid) < won) lo = mid; else hi = mid;
    }
    return Math.round((lo + hi) / 2);
  },
  // PAL handicap: bonus games spotted to the lower-rated player, by Fargo gap.
  spot(delta) {
    const d = Math.abs(delta);
    if (d <= 50) return 0;
    if (d <= 100) return 1;
    if (d <= 150) return 2;
    if (d <= 225) return 3;
    return 4;
  },
};

function _comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

// Full result distribution for a race to 7 with a spot.
// The RACE (who's spotted, and by how much) is ALWAYS set by the actual Fargos
// (offA/offB) — that's the real handicap. The per-game odds use ratA/ratB, which
// may be the players' season form; so "season form" only shifts the odds, not
// the race. Returns { higher:'A'|'B', delta, spot, pGame, aWin, bWin, results, modal }
function matchup(offA, offB, ratA, ratB) {
  const delta = Math.abs(offA - offB);
  const spot = FARGO.spot(delta);
  const higher = offA >= offB ? "A" : "B";  // the un-spotted player (needs 7)
  const rHi = higher === "A" ? ratA : ratB;
  const rLo = higher === "A" ? ratB : ratA;
  const p = FARGO.pGame(rHi, rLo);          // favorite's per-game win prob (by chosen basis)
  const need = 7 - spot;                    // on-table wins the underdog needs
  const rows = [];
  // favorite wins: underdog gets j on-table games (j = 0 .. need-1)
  for (let j = 0; j <= need - 1; j++) {
    rows.push({ favG: 7, dogG: spot + j, favWin: true,
                prob: _comb(6 + j, 6) * Math.pow(p, 7) * Math.pow(1 - p, j) });
  }
  // underdog wins: favorite gets i on-table games (i = 6 .. 0), closest first
  for (let i = 6; i >= 0; i--) {
    rows.push({ favG: i, dogG: 7, favWin: false,
                prob: _comb(need - 1 + i, i) * Math.pow(1 - p, need) * Math.pow(p, i) });
  }
  // map favorite/underdog back to A/B for display
  const results = rows.map((r) => {
    const aIsFav = higher === "A";
    const a = aIsFav ? r.favG : r.dogG;
    const b = aIsFav ? r.dogG : r.favG;
    const winner = r.favWin === aIsFav ? "A" : "B";
    return { a, b, winner, prob: r.prob };
  });
  const aWin = results.filter((r) => r.winner === "A").reduce((s, r) => s + r.prob, 0);
  let modal = 0;
  results.forEach((r, i) => { if (r.prob > results[modal].prob) modal = i; });
  return { higher, delta, spot, pGame: p, aWin, bWin: 1 - aWin, results, modal };
}

// ---- detail (per-player) view --------------------------------------------
function openDetail(row) {
  state.detail = { teamId: row.team_id, name: row.name, league: state.league, from: state.mode };
  state.detailTab = "insights";
  state.detailSort = { key: "dateISO", dir: "asc" };
  state.view = "player";
  state.mode = "standings";   // the player page is a sub-view of standings
  renderAll();
}
function backToStandings() {
  state.mode = (state.detail && state.detail.from) || "standings";
  state.view = "standings"; state.detail = null;
  renderAll();
}

// enrich each match with on-table games, the spot, and the per-match played-as
function enrichedMatches() {
  const g = state.granular.byId[state.detail.teamId];
  const fargo = g ? g.fargo : null;
  return (g ? g.matches : []).map((m) => {
    const wg = m.my - (m.myBp || 0);   // games YOU won on the table
    const lg = m.opp - (m.oppBp || 0); // games OPP won on the table
    const spotN = (m.myBp || 0) || (m.oppBp || 0);
    const spotWho = (m.myBp || 0) ? "you" : (m.oppBp || 0) ? "opp" : null;
    const playedAs = m.oppFargo != null ? FARGO.playedAsMatch(wg, lg, m.oppFargo) : null;
    return { ...m, wg, lg, ropp: m.oppFargo, spotN, spotWho,
             score: `${m.my}–${m.opp}`, playedAs, myFargo: fargo };
  });
}

function detailCell(m, c, i) {
  if (c.key === "idx") return `<td class="rank">${i + 1}</td>`;
  if (c.key === "dateISO") return `<td class="text">${fmtDate(m.dateISO, m.date)}</td>`;
  if (c.key === "opponent") return `<td class="text name">${escapeHtml(m.opponent)}</td>`;
  if (c.key === "score") return `<td class="text">${m.score}</td>`;
  if (c.key === "spot") {
    if (!m.spotN) return `<td class="spot-opp">—</td>`;
    const cls = m.spotWho === "you" ? "spot-you" : "spot-opp";
    return `<td class="${cls}">+${m.spotN} ${m.spotWho}</td>`;
  }
  if (c.key === "playedAs") {
    if (m.playedAs == null) return `<td>—</td>`;
    const d = m.myFargo != null ? m.playedAs - m.myFargo : 0;
    const cls = d > 8 ? "up" : d < -8 ? "down" : "";
    return `<td class="pa-cell ${cls}">${m.playedAs}</td>`;
  }
  if (c.key === "result") {
    const w = m.result === "W";
    return `<td class="text"><span class="wl ${w ? "w" : "l"}">${m.result}</span></td>`;
  }
  return `<td>${fmtNum(m[c.key], c.key)}</td>`;
}

function renderDetailBar() {
  const g = state.granular.byId[state.detail.teamId] || { matches: [], fargo: null };
  const matches = g.matches || [];
  const wins = matches.filter((m) => m.result === "W").length;
  const bar = $("#detailBar");
  bar.classList.remove("hidden");
  bar.innerHTML =
    `<button class="btn btn-secondary btn-sm" id="backBtn">← Back</button>` +
    `<span class="title">${escapeHtml(state.detail.name)}</span>` +
    `<div class="facts">` +
      `<span class="fact">Fargo <b>${g.fargo ?? "—"}</b></span>` +
      `<span class="fact">Record <b>${wins}–${matches.length - wins}</b></span>` +
    `</div>` +
    `<span class="grow"></span>` +
    `<div class="tabs" role="tablist">` +
      `<button role="tab" aria-selected="${state.detailTab === "insights"}" data-tab="insights">Insights</button>` +
      `<button role="tab" aria-selected="${state.detailTab === "matches"}" data-tab="matches">Matches</button>` +
    `</div>` +
    `<button class="btn btn-secondary btn-sm" id="compareBtn">Compare ⚔</button>` +
    `<button class="btn btn-primary btn-sm" id="detailCsvBtn">Export CSV</button>`;
  $("#backBtn").onclick = backToStandings;
  $("#detailCsvBtn").onclick = exportDetailCsv;
  $("#compareBtn").onclick = () => {
    state.mode = "h2h";
    state.league = state.detail.league || state.league;
    state.h2h.a = state.detail.teamId; state.h2h.b = null;
    state.h2h.basis = "fargo";   // a fresh comparison starts from actual Fargo
    renderAll();
  };
  bar.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => { state.detailTab = b.dataset.tab; renderAll(); };
  });
}

function renderDetailTable() {
  const rows = sortRows(enrichedMatches(), state.detailSort, DETAIL_COLUMNS);
  renderTable(DETAIL_COLUMNS, rows, {
    sortState: state.detailSort,
    onSort: (c) => {
      if (state.detailSort.key === c.key) state.detailSort.dir = state.detailSort.dir === "asc" ? "desc" : "asc";
      else { state.detailSort.key = c.key; state.detailSort.dir = (c.type === "text" || c.type === "date") ? "asc" : "desc"; }
      renderDetailTable();
    },
    cell: detailCell,
  });
}

// ---- Insights ------------------------------------------------------------
function info(id, html) {
  return `<span class="info"><button class="info-btn" data-info="${id}" aria-label="How this is calculated">i</button>` +
    `<span class="info-pop hidden" id="info-${id}">${html}</span></span>`;
}
const SRC = `<span class="src">Model: FargoRate — 100 rating points ≈ winning twice as many games; ratings are the maximum-likelihood fit to games won &amp; lost.</span>`;

function computeInsights() {
  const g = state.granular.byId[state.detail.teamId] || { matches: [], fargo: null };
  const official = g.fargo;
  const all = enrichedMatches();
  const rated = all.filter((m) => m.ropp != null && (m.wg + m.lg) > 0);
  const perMatch = rated.map((m) => ({ ...m }));
  const actualGames = rated.reduce((s, m) => s + m.wg, 0);
  const totalGames = rated.reduce((s, m) => s + m.wg + m.lg, 0);
  const expectedGames = official != null
    ? rated.reduce((s, m) => s + (m.wg + m.lg) * FARGO.pGame(official, m.ropp), 0) : null;
  const sessionPA = FARGO.playedAsSession(perMatch);
  const delta = (sessionPA != null && official != null) ? sessionPA - official : null;
  const excluded = all.length - rated.length;
  // best / off night by played-as
  const withPA = perMatch.filter((m) => m.playedAs != null);
  let best = null, worst = null;
  withPA.forEach((m) => {
    if (!best || m.playedAs > best.playedAs) best = m;
    if (!worst || m.playedAs < worst.playedAs) worst = m;
  });
  return { official, sessionPA, delta, actualGames, expectedGames, totalGames,
           perMatch, rated, excluded, best, worst };
}

function renderInsights() {
  const box = $("#insights");
  const ins = computeInsights();
  const { official, sessionPA, delta, actualGames, expectedGames, totalGames, excluded, best, worst } = ins;

  if (!ins.rated.length || official == null) {
    box.innerHTML = `<div class="panel"><p class="caption">Not enough rated matches yet to compute insights for this player.</p></div>`;
    return;
  }

  const dir = delta > 8 ? "up" : delta < -8 ? "down" : "flat";
  const sign = delta > 0 ? "+" : "";
  const verdict = delta > 8 ? "Overperforming your rating"
    : delta < -8 ? "Underperforming your rating" : "Right about on your rating";
  const smallSample = totalGames < 20;

  // expected vs actual bar scaling
  const evaMax = Math.max(actualGames, expectedGames || 0) || 1;
  const gDelta = expectedGames != null ? actualGames - expectedGames : null;
  const gSign = gDelta > 0 ? "+" : "";

  box.innerHTML =
    `<div class="insights-grid">` +
      // Hero verdict
      `<div class="panel">` +
        `<p class="panel-title">Performance Rating · this session ${info("pa",
          `<b>Performance rating</b> is the FargoRate that best explains the games you actually won this session — the rating where your expected game-wins equal your real ones. Spots (bonus points) are removed first. ${SRC}`)}</p>` +
        `<div class="hero-num"><span class="big">${sessionPA}</span>` +
          `<span class="delta ${dir}">${sign}${delta}</span></div>` +
        `<p class="verdict ${dir}">${verdict}</p>` +
        `<p class="hero-sub">Your official Fargo is <b>${official}</b>. This session your performance rating is <b>${sessionPA}</b>` +
          `${smallSample ? " — but it's early, so treat this as a rough read." : "."}</p>` +
      `</div>` +
      // Expected vs actual
      `<div class="panel">` +
        `<p class="panel-title">Games won vs. expected ${info("eva",
          `<b>Expected</b> adds up your win chance in every game from the Fargo gap with each opponent. <b>Actual</b> is games you truly won on the table (spots removed). Ahead of expected = you're outplaying the ratings. ${SRC}`)}</p>` +
        `<div class="eva-row"><div class="lab"><span>Actual</span><b>${actualGames}</b></div>` +
          `<div class="eva-track"><div class="eva-fill actual" style="width:${(actualGames / evaMax * 100).toFixed(1)}%"></div></div></div>` +
        `<div class="eva-row"><div class="lab"><span>Expected</span><b>${expectedGames != null ? expectedGames.toFixed(1) : "—"}</b></div>` +
          `<div class="eva-track"><div class="eva-fill expected" style="width:${((expectedGames || 0) / evaMax * 100).toFixed(1)}%"></div></div></div>` +
        (gDelta != null
          ? `<p class="caption">You've won <b style="color:hsl(var(--${gDelta >= 0 ? "success" : "danger"}))">${gSign}${gDelta.toFixed(1)}</b> games ${gDelta >= 0 ? "more" : "fewer"} than your rating predicts, over ${totalGames} on-table games.</p>`
          : "") +
      `</div>` +
    `</div>` +
    // Chart
    `<div class="chart-card">` +
      `<div class="chart-head"><h3>How you've played, match by match</h3>` +
        info("chart", `Each dot is one match: the rating you'd need to have played to produce that result (spot removed), from your on-table games and the opponent's Fargo. The dashed line is your official Fargo — dots above it mean you outplayed your rating that night. ${SRC}`) +
      `</div>` +
      `<p class="caption" style="margin-top:0">Above the dashed line = you played better than your ${official} rating.</p>` +
      `<div class="chart-wrap" id="paChartWrap"></div>` +
    `</div>` +
    // Highlights
    `<div class="highlights">` +
      (best ? `<div class="hl best"><div class="k">Best performance</div>` +
        `<div class="v">Performance ${best.playedAs}</div>` +
        `<div class="d">vs ${escapeHtml(best.opponent)} (${best.ropp}) · on-table ${best.wg}–${best.lg} · ${best.result}</div></div>` : "") +
      (worst ? `<div class="hl worst"><div class="k">Off night</div>` +
        `<div class="v">Performance ${worst.playedAs}</div>` +
        `<div class="d">vs ${escapeHtml(worst.opponent)} (${worst.ropp}) · on-table ${worst.wg}–${worst.lg} · ${worst.result}</div></div>` : "") +
    `</div>` +
    (excluded ? `<p class="caption">${excluded} match${excluded > 1 ? "es" : ""} excluded (opponent unrated).</p>` : "");

  renderPlayedAsChart($("#paChartWrap"), ins);
  wireInfoButtons(box);
}

function renderPlayedAsChart(wrap, ins) {
  const data = ins.perMatch
    .filter((m) => m.playedAs != null)
    .slice()
    .sort((a, b) => String(a.dateISO || "").localeCompare(String(b.dateISO || "")));
  if (!data.length) { wrap.innerHTML = `<p class="caption">No rated matches to plot.</p>`; return; }

  const W = 720, H = 260, mL = 44, mR = 16, mT = 14, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const ys = data.map((d) => d.playedAs).concat([ins.official]);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const pad = Math.max(30, (yMax - yMin) * 0.15);
  yMin = Math.floor((yMin - pad) / 10) * 10; yMax = Math.ceil((yMax + pad) / 10) * 10;
  const x = (i) => mL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => mT + ih - ((v - yMin) / (yMax - yMin)) * ih;

  // gridlines / y ticks (4)
  let grid = "";
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const val = Math.round(yMin + (t / ticks) * (yMax - yMin));
    const yy = y(val);
    grid += `<line class="grid-line" x1="${mL}" y1="${yy.toFixed(1)}" x2="${W - mR}" y2="${yy.toFixed(1)}"/>`;
    grid += `<text class="axis-text" x="${mL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${val}</text>`;
  }
  // reference line at official fargo
  const refY = y(ins.official);
  const refLine = `<line class="ref-line" x1="${mL}" y1="${refY.toFixed(1)}" x2="${W - mR}" y2="${refY.toFixed(1)}"/>` +
    `<text class="ref-label" x="${W - mR}" y="${(refY - 6).toFixed(1)}" text-anchor="end">Your Fargo ${ins.official}</text>`;
  // line path
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.playedAs).toFixed(1)}`).join(" ");
  // date labels: first & last
  const dl = (d) => d.dateISO ? new Date(d.dateISO).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
  const xLabels =
    `<text class="axis-text" x="${x(0)}" y="${H - 6}" text-anchor="start">${dl(data[0])}</text>` +
    (data.length > 1 ? `<text class="axis-text" x="${x(data.length - 1)}" y="${H - 6}" text-anchor="end">${dl(data[data.length - 1])}</text>` : "");
  const dots = data.map((d, i) =>
    `<circle class="pa-dot" cx="${x(i).toFixed(1)}" cy="${y(d.playedAs).toFixed(1)}" r="4.5"/>` +
    `<circle cx="${x(i).toFixed(1)}" cy="${y(d.playedAs).toFixed(1)}" r="14" fill="transparent" ` +
      `data-i="${i}" class="pa-hit"/>`).join("");

  wrap.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Performance rating by match">` +
      grid + refLine + `<path class="pa-line" d="${path}"/>` + dots + xLabels +
    `</svg><div class="chart-tip" id="paTip"></div>`;

  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector("#paTip");
  wrap.querySelectorAll(".pa-hit").forEach((h) => {
    h.addEventListener("mouseenter", () => {
      const d = data[+h.dataset.i];
      const rect = svg.getBoundingClientRect();
      const sx = rect.left + (x(+h.dataset.i) / W) * rect.width;
      const sy = rect.top + (y(d.playedAs) / H) * rect.height;
      const wr = wrap.getBoundingClientRect();
      tip.innerHTML = `<b>Performance ${d.playedAs}</b><br>vs ${escapeHtml(d.opponent)} (${d.ropp})<br>` +
        `on-table ${d.wg}–${d.lg} · ${d.result}${d.spotN ? ` · +${d.spotN} ${d.spotWho}` : ""}`;
      tip.style.left = (sx - wr.left) + "px";
      tip.style.top = (sy - wr.top) + "px";
      tip.style.opacity = "1";
    });
    h.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
  });
}

function wireInfoButtons(scope) {
  scope.querySelectorAll(".info-btn").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const pop = scope.querySelector("#info-" + b.dataset.info);
      const open = !pop.classList.contains("hidden");
      scope.querySelectorAll(".info-pop").forEach((p) => p.classList.add("hidden"));
      if (!open) pop.classList.remove("hidden");
    };
  });
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".info")) document.querySelectorAll(".info-pop").forEach((p) => p.classList.add("hidden"));
});

// ---- Head-to-Head --------------------------------------------------------
function fargoFor(id) { const g = state.granular.byId[id]; return g ? g.fargo : null; }
function playedAsFor(id) {
  const g = state.granular.byId[id];
  if (!g || !g.matches) return null;
  const per = g.matches.filter((m) => m.oppFargo != null)
    .map((m) => ({ wg: m.my - (m.myBp || 0), lg: m.opp - (m.oppBp || 0), ropp: m.oppFargo }));
  return FARGO.playedAsSession(per);
}
function leaguePlayers(league) {
  const bks = state.data.leagues[league].brackets;
  const out = [];
  Object.keys(bks).sort().forEach((label) => bks[label].forEach((r) => out.push({ ...r, bracket: label })));
  return out;
}
function findPlayer(league, id) { return leaguePlayers(league).find((p) => p.team_id === id) || null; }
function rankOf(league, bracket, id) {
  const rows = state.data.leagues[league].brackets[bracket].slice().sort((a, b) => b.GP - a.GP);
  const i = rows.findIndex((r) => r.team_id === id);
  return i >= 0 ? i + 1 : null;
}
function actualMatch(aId, bName) {
  const g = state.granular.byId[aId];
  if (!g || !g.matches) return null;
  const bn = String(bName).trim().toUpperCase();
  return g.matches.find((m) => String(m.opponent).trim().toUpperCase() === bn) || null;
}

function playerOptions(players, selectedId) {
  const byBracket = {};
  players.forEach((p) => { (byBracket[p.bracket] = byBracket[p.bracket] || []).push(p); });
  return Object.keys(byBracket).sort().map((br) => {
    const label = br.length === 1 ? "Bracket " + br : br;
    const opts = byBracket[br].slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) =>
      `<option value="${p.team_id}"${p.team_id === selectedId ? " selected" : ""}>` +
      `${escapeHtml(p.name)} · ${fargoFor(p.team_id) ?? "—"}</option>`).join("");
    return `<optgroup label="${escapeHtml(label)}">${opts}</optgroup>`;
  }).join("");
}

function renderH2H() {
  const box = $("#h2h");
  const league = state.league;
  const players = leaguePlayers(league);
  box.innerHTML =
    `<div class="controls">` +
      `<div class="control-group"><span>Rate by</span><div class="segmented" id="h2hBasis">` +
        `<button data-basis="fargo" aria-selected="${state.h2h.basis === "fargo"}">Fargo</button>` +
        `<button data-basis="form" aria-selected="${state.h2h.basis === "form"}">Performance</button>` +
      `</div></div>` +
    `</div>` +
    `<div class="h2h-pickers">` +
      `<select class="h2h-select" id="h2hA"><option value="">Select player…</option>${playerOptions(players, state.h2h.a)}</select>` +
      `<span class="h2h-vs">vs</span>` +
      `<select class="h2h-select" id="h2hB"><option value="">Select player…</option>${playerOptions(players, state.h2h.b)}</select>` +
    `</div>` +
    `<div id="h2hResult"></div>`;
  $("#h2hBasis").querySelectorAll("button").forEach((b) => b.onclick = () => {
    state.h2h.basis = b.dataset.basis; renderH2H();
  });
  $("#h2hA").onchange = (e) => { state.h2h.a = e.target.value ? +e.target.value : null; renderH2HResult(); };
  $("#h2hB").onchange = (e) => { state.h2h.b = e.target.value ? +e.target.value : null; renderH2HResult(); };
  renderH2HResult();
}

function h2hCardHTML(p, colorClass) {
  const f = fargoFor(p.team_id), pa = playedAsFor(p.team_id);
  const arrow = pa == null || f == null ? "" :
    pa > f ? '<span class="pa-cell up">▲</span>' : pa < f ? '<span class="pa-cell down">▼</span>' : "";
  const brLabel = p.bracket.length === 1 ? "Bracket " + p.bracket : p.bracket;
  const rank = rankOf(state.league, p.bracket, p.team_id);
  return `<div class="h2h-card">` +
    `<div class="h2h-name"><span class="dot ${colorClass}"></span>${escapeHtml(p.name)}</div>` +
    `<div class="h2h-sub">${escapeHtml(brLabel)}${rank ? ` · Rank ${rank}` : ""}</div>` +
    `<div class="h2h-stats">` +
      `<div><span>Fargo</span><b>${f ?? "—"}</b></div>` +
      `<div><span>Performance</span><b>${pa ?? "—"} ${arrow}</b></div>` +
      `<div><span>Record</span><b>${p.MW}–${p.ML}</b></div>` +
    `</div></div>`;
}

function renderH2HResult() {
  const el = $("#h2hResult"); if (!el) return;
  const { a, b, basis } = state.h2h;
  const league = state.league;
  if (!a || !b) { el.innerHTML = `<div class="panel"><p class="caption">Pick two players to see the matchup.</p></div>`; return; }
  if (a === b) { el.innerHTML = `<div class="panel"><p class="caption">Pick two different players.</p></div>`; return; }
  const pa = findPlayer(league, a), pb = findPlayer(league, b);
  if (!pa || !pb) { el.innerHTML = ""; return; }

  const fa = fargoFor(a), fb = fargoFor(b);
  const formA = playedAsFor(a), formB = playedAsFor(b);
  const formAvail = formA != null && formB != null;
  const useForm = basis === "form" && formAvail;
  const rA = useForm ? formA : fa, rB = useForm ? formB : fb;
  if (rA == null || rB == null) {
    el.innerHTML = `<div class="panel"><p class="caption">Not enough rating data to compare these two yet.</p></div>`;
    return;
  }

  const m = matchup(fa, fb, rA, rB);   // race from actual Fargos; odds from chosen basis
  const aPct = Math.round(m.aWin * 100), bPct = 100 - aPct;
  const favPct = Math.max(aPct, bPct);
  const favName = m.aWin >= 0.5 ? pa.name : pb.name;
  const verdict = favPct >= 80 ? "a heavy favorite" : favPct >= 65 ? "a clear favorite"
    : favPct >= 55 ? "a slight edge" : "a toss-up";
  const higherName = m.higher === "A" ? pa.name : pb.name;
  const lowerName = m.higher === "A" ? pb.name : pa.name;

  // scoreline chart
  const maxProb = Math.max(...m.results.map((r) => r.prob), 0.0001);
  const bars = m.results.filter((r) => r.prob >= 0.005).map((r) => {
    const pct = r.prob * 100;
    const w = (r.prob / maxProb * 100).toFixed(1);
    const cls = r.winner === "A" ? "favA" : "favB";
    const modal = r === m.results[m.modal] ? " modal" : "";
    return `<div class="sl-row${modal}">` +
      `<span class="sl-score">${r.a}–${r.b}</span>` +
      `<span class="sl-track"><span class="sl-bar ${cls}" style="width:${w}%"></span></span>` +
      `<span class="sl-pct">${pct < 1 ? "<1" : Math.round(pct)}%</span></div>`;
  }).join("");

  // actual match (same bracket only)
  let actual = "";
  if (pa.bracket === pb.bracket) {
    const am = actualMatch(a, pb.name);
    if (am) {
      const spotTxt = am.myBp ? ` (${pa.name.split(" ")[0]} +${am.myBp})` : am.oppBp ? ` (${pb.name.split(" ")[0]} +${am.oppBp})` : "";
      const winner = am.my > am.opp ? pa.name : pb.name;
      actual = `<div class="panel"><p class="panel-title">Their actual match</p>` +
        `<p class="hero-sub">${fmtDate(am.dateISO, am.date)} — <b>${escapeHtml(pa.name)} ${am.my}–${am.opp} ${escapeHtml(pb.name)}</b>${spotTxt}. ${escapeHtml(winner)} won.</p></div>`;
    } else {
      actual = `<div class="panel"><p class="hero-sub">Same bracket — they play once this season, but haven't yet. This is the forecast.</p></div>`;
    }
  }

  const basisNote = basis === "form" && !formAvail
    ? ` <span class="notice">(performance rating unavailable — using Fargo)</span>` : "";

  el.innerHTML =
    `<div class="h2h-compare">${h2hCardHTML(pa, "cA")}<div class="h2h-mid">VS</div>${h2hCardHTML(pb, "cB")}</div>` +
    `<div class="panel">` +
      `<div class="race-banner">` +
        `<span class="race-tag">RACE TO 7</span>` +
        `<span class="race-text">${m.spot === 0
          ? "Even — no games on the wire"
          : `${escapeHtml(lowerName)} gets <b>${m.spot}</b> game${m.spot > 1 ? "s" : ""} on the wire`}</span>` +
        `<span class="race-detail">${escapeHtml(higherName)} needs 7 · ${escapeHtml(lowerName)} needs ${7 - m.spot}</span>` +
      `</div>` +
      `<p class="panel-title">Win probability ${info("h2hp",
        `Each game is won by the higher-rated player with chance <b>2^(Δ/100)/(1+2^(Δ/100))</b> from the Fargo gap. The match is a race to 7 with the lower player spotted per PAL's table (Δ 1–50→0, 51–100→1, 101–150→2, 151–225→3, 226+→4). The win % and every scoreline below already include those spotted games. ${SRC}`)}${basisNote}</p>` +
      `<div class="meter-track"><span class="meter-a" style="width:${aPct}%"></span><span class="meter-b" style="width:${bPct}%"></span></div>` +
      `<div class="meter-labels"><span><span class="dot cA"></span>${escapeHtml(pa.name)} ${aPct}%</span>` +
        `<span>${bPct}% ${escapeHtml(pb.name)}<span class="dot cB"></span></span></div>` +
      `<p class="verdict-line">${escapeHtml(favName)} is ${verdict}${useForm ? ", by this season's performance" : ""}.</p>` +
    `</div>` +
    `<div class="panel"><p class="panel-title">Possible results ${info("h2hs",
      `Every final score that can happen in this race, with its probability. The spot compresses the favorite's range (they can't win by more than 7–${m.spot}). ${SRC}`)}</p>` +
      `<div class="sl-chart">${bars}</div></div>` +
    actual;
  wireInfoButtons(el);
}

// ---- Leaderboard ---------------------------------------------------------
const LB_MIN = 5;   // minimum matches to qualify
const LB_TOP = 5;

const LEADERBOARDS = [
  { key: "over", title: "Overperformers", sub: "Playing furthest above their Fargo rating",
    val: (r) => r.over, fmt: (v) => `${v > 0 ? "+" : ""}${v}`,
    ctx: (r) => `played as ${r.playedAs} · Fargo ${r.fargo}` },
  { key: "form", title: "Performance Rating", sub: "Highest performance rating this season",
    val: (r) => r.playedAs, fmt: (v) => v, ctx: (r) => `Fargo ${r.fargo}` },
  { key: "gpmp", title: "Points per Match", sub: "Game points ÷ matches played",
    val: (r) => r.GPMP, fmt: (v) => v.toFixed(2), ctx: (r) => `${r.GP} pts · ${r.MP} matches` },
  { key: "gamewin", title: "Game Win %", sub: "Games won on the table (spots removed)",
    val: (r) => r.gameWin, fmt: (v) => v.toFixed(1) + "%", ctx: (r) => `${r.MW}–${r.ML} matches` },
  { key: "clutch", title: "Clutch", sub: "Record in hill-hill (deciding) games",
    val: (r) => r.clutch, fmt: (v) => v.toFixed(0) + "%", tie: (r) => r.closeN,
    ctx: (r) => `${r.closeW}–${r.closeL} in hill-hill games` },
  { key: "sos", title: "Toughest Schedule", sub: "Highest average opponent Fargo",
    val: (r) => r.avgOpp, fmt: (v) => Math.round(v), ctx: (r) => `${r.MP} matches played` },
];

function leaderboardRows() {
  const labels = bracketsFor(state.league);
  const brackets = state.data.leagues[state.league].brackets;
  let rows = [];
  if (state.bracket === "__both__" || labels.length < 2) {
    labels.forEach((l) => brackets[l].forEach((r) => rows.push({ ...r, bracket: l })));
  } else {
    rows = (brackets[state.bracket] || []).map((r) => ({ ...r, bracket: state.bracket }));
  }
  return rows.map((r) => {
    const g = state.granular.byId[r.team_id] || {};
    const playedAs = playedAsFor(r.team_id);
    let wg = 0, lg = 0, closeN = 0, closeW = 0;
    (g.matches || []).forEach((m) => {
      if (m.oppFargo != null) { wg += m.my - (m.myBp || 0); lg += m.opp - (m.oppBp || 0); }
      if (Math.abs(m.my - m.opp) === 1 && Math.max(m.my, m.opp) === 7) {  // 7–6 = hill-hill (both on the hill)
        closeN++; if (m.my > m.opp) closeW++;
      }
    });
    return {
      ...r, fargo: g.fargo ?? null, avgOpp: g.avgOpp ?? null, playedAs,
      over: (playedAs != null && g.fargo != null) ? playedAs - g.fargo : null,
      gameWin: (wg + lg) > 0 ? (wg / (wg + lg)) * 100 : null,
      closeN, closeW, closeL: closeN - closeW,
      clutch: closeN >= 3 ? (closeW / closeN) * 100 : null,   // needs 3+ deciders
    };
  });
}

function renderLeaderboard() {
  const box = $("#leaderboard");
  const labels = bracketsFor(state.league);
  let controls = "";
  if (labels.length > 1) {
    const opts = [...labels.map((l) => ({ v: l, t: "Bracket " + l })), { v: "__both__", t: "Both" }];
    controls = `<div class="controls"><div class="control-group"><span>Bracket</span>` +
      `<div class="segmented" id="lbBracketSeg">` +
      opts.map((o) => `<button data-b="${o.v}" aria-selected="${state.bracket === o.v}">${o.t}</button>`).join("") +
      `</div></div></div>`;
  }
  const eligible = leaderboardRows().filter((r) => r.MP >= LB_MIN);
  const cards = LEADERBOARDS.map((lb) => {
    const ranked = eligible.filter((r) => lb.val(r) != null)
      .sort((a, b) => (lb.val(b) - lb.val(a)) || (lb.tie ? lb.tie(b) - lb.tie(a) : 0))
      .slice(0, LB_TOP);
    const items = ranked.map((r, i) => {
      const rank = i < 3 ? `<span class="medal">${["🥇", "🥈", "🥉"][i]}</span>` : `<span class="lb-num">${i + 1}</span>`;
      return `<li class="lb-row">${rank}` +
        `<span class="lb-name" data-id="${r.team_id}" data-name="${escapeHtml(r.name)}">` +
          `${escapeHtml(r.name)}<span class="lb-ctx">${lb.ctx(r)}</span></span>` +
        `<span class="lb-val">${lb.fmt(lb.val(r))}</span></li>`;
    }).join("");
    return `<div class="lb-card"><h3 class="lb-title">${lb.title}</h3>` +
      `<p class="lb-sub">${lb.sub}</p>` +
      `<ol class="lb-list">${items || '<li class="lb-empty">Not enough data yet.</li>'}</ol></div>`;
  }).join("");
  box.innerHTML = controls + `<div class="lb-grid">${cards}</div>` +
    `<p class="caption">Minimum ${LB_MIN} matches played to qualify.</p>`;
  if (labels.length > 1) {
    $("#lbBracketSeg").querySelectorAll("button").forEach((b) =>
      b.onclick = () => { state.bracket = b.dataset.b; renderLeaderboard(); });
  }
  box.querySelectorAll(".lb-name").forEach((n) =>
    n.onclick = () => openDetail({ team_id: +n.dataset.id, name: n.dataset.name }));
}

// ---- view switch ---------------------------------------------------------
function renderAll() {
  updateFreshness(); updateRefreshButton();
  const hasData = state.data && state.data.order && state.data.order.length > 0;
  const SECTIONS = ["#controls", "#stats", "#detailBar", "#tableCard", "#insights", "#h2h", "#leaderboard"];
  $("#emptyApp").classList.toggle("hidden", hasData);
  $("#sidebar").classList.toggle("hidden", !hasData);
  if (!hasData) { SECTIONS.forEach((s) => $(s).classList.add("hidden")); return; }
  renderSidebar();

  if (state.mode === "h2h" || state.mode === "leaderboard") {
    SECTIONS.forEach((s) => $(s).classList.add("hidden"));
    if (state.mode === "h2h") { $("#h2h").classList.remove("hidden"); renderH2H(); }
    else { $("#leaderboard").classList.remove("hidden"); renderLeaderboard(); }
    return;
  }
  $("#h2h").classList.add("hidden");
  $("#leaderboard").classList.add("hidden");
  const standings = state.view === "standings";
  const insights = !standings && state.detailTab === "insights";
  $("#controls").classList.toggle("hidden", !standings);
  $("#stats").classList.toggle("hidden", !standings);
  $("#detailBar").classList.toggle("hidden", standings);
  $("#tableCard").classList.toggle("hidden", insights);
  $("#insights").classList.toggle("hidden", !insights);
  if (standings) {
    renderBracketSeg(); renderColumnMenu();
    renderStats(); renderStandingsTable();
  } else {
    renderDetailBar();
    if (insights) renderInsights(); else renderDetailTable();
  }
}

// ---- CSV export ----------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }

$("#csvBtn").addEventListener("click", () => {
  const rows = currentRows();
  const cols = standingsColumns().filter((c) => c.key !== "rank");
  const header = ["rank", ...cols.map((c) => c.label)];
  if (state.showBracketCol) header.push("bracket");
  const lines = [header.join(",")];
  rows.forEach((r, i) => {
    const line = [i + 1, ...cols.map((c) => csvCell(r[c.key]))];
    if (state.showBracketCol) line.push(r.bracket);
    lines.push(line.join(","));
  });
  const leagueSlug = slug(state.data.leagues[state.league].name) || state.league;
  const bkt = state.showBracketCol ? "both" : slug(state.bracket || "all");
  download(`pal_${leagueSlug}_${bkt}.csv`, lines.join("\n"));
});

function exportDetailCsv() {
  const matches = sortRows(enrichedMatches(), state.detailSort, DETAIL_COLUMNS);
  const header = ["date", "opponent", "opp_fargo", "you", "opp",
    "bonus_points", "bp_to", "ontable_you", "ontable_opp", "performance_rating", "result"];
  const lines = [header.join(",")];
  matches.forEach((m) => lines.push([
    csvCell(m.date || m.dateISO || ""), csvCell(m.opponent), csvCell(m.oppFargo),
    csvCell(m.my), csvCell(m.opp), csvCell(m.spotN || 0), csvCell(m.spotWho || ""),
    csvCell(m.wg), csvCell(m.lg), csvCell(m.playedAs), csvCell(m.result),
  ].join(",")));
  download(`pal_${slug(state.detail.name)}_matches.csv`, lines.join("\n"));
}

// ---- boot ----------------------------------------------------------------
(async function boot() {
  initTheme();
  state.hiddenCols = store.hiddenCols();
  state.collapsed = store.collapsed();
  // paint the cached snapshot instantly, then pull the latest from the server
  const cached = store.cachedData();
  if (cached && cached.order) onData(cached);
  else renderAll();  // empty state until the fetch lands
  try {
    onData(await fetchSnapshot(), { keepView: !!(cached && cached.order && cached.order.length) });
  } catch (_) { /* keep whatever we have */ }
  // keep the "updated Nm ago" label and the refresh cooldown countdown live
  setInterval(() => { if (!state.refreshing) { updateFreshness(); updateRefreshButton(); } }, 30000);
})();
