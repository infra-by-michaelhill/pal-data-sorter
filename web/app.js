/* PAL Data Sorter — front-end logic.
   Login once -> the server returns the full dataset for both leagues/all
   brackets -> everything after that (league, bracket, sort) is local. */

const $ = (s) => document.querySelector(s);

// League/season names and bracket labels are whatever the server discovered on
// the PAL site — nothing here is hardcoded to a particular season.

// Columns. `default sort` is Points (GP) descending.
const COLUMNS = [
  { key: "rank",   label: "#",           type: "rank" },
  { key: "name",   label: "Player",      type: "text" },
  { key: "GP",     label: "Points",      type: "num" },
  { key: "GPMP",   label: "Pts / Match", type: "num" },
  { key: "MW",     label: "Match Wins",  type: "num" },
  { key: "ML",     label: "Losses",      type: "num" },
  { key: "MP",     label: "Matches",     type: "num" },
  { key: "winPct", label: "Win %",       type: "num" },
];
const DEFAULT_SORT = { key: "GP", dir: "desc" };

const state = {
  data: null,        // full dataset from the server
  league: "standard",
  bracket: null,     // specific bracket label, or "__both__"
  sort: { ...DEFAULT_SORT },
  showBracketCol: false,
};

// ---- storage helpers -----------------------------------------------------
const store = {
  saveEmail(e) { try { localStorage.setItem("pal.email", e); } catch (_) {} },
  email() { try { return localStorage.getItem("pal.email") || ""; } catch (_) { return ""; } },
  saveCreds(e, p) { try { localStorage.setItem("pal.creds", btoa(unescape(encodeURIComponent(e + "\n" + p)))); } catch (_) {} },
  creds() {
    try {
      const raw = localStorage.getItem("pal.creds");
      if (!raw) return null;
      const [user, password] = decodeURIComponent(escape(atob(raw))).split("\n");
      return { user, password };
    } catch (_) { return null; }
  },
  clearCreds() { try { localStorage.removeItem("pal.creds"); } catch (_) {} },
  cacheData(d) { try { sessionStorage.setItem("pal.data", JSON.stringify(d)); } catch (_) {} },
  cachedData() { try { return JSON.parse(sessionStorage.getItem("pal.data") || "null"); } catch (_) { return null; } },
  clearData() { try { sessionStorage.removeItem("pal.data"); } catch (_) {} },
  theme() { try { return localStorage.getItem("pal.theme"); } catch (_) { return null; } },
  saveTheme(t) { try { localStorage.setItem("pal.theme", t); } catch (_) {} },
};

// ---- theme ---------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("#themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
}
function initTheme() {
  const saved = store.theme();
  const t = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(t);
}
$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  store.saveTheme(next);
  applyTheme(next);
});

// ---- network -------------------------------------------------------------
async function fetchData(user, password) {
  const res = await fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---- login flow ----------------------------------------------------------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = $("#email").value.trim();
  const password = $("#password").value;
  const btn = $("#loginBtn");
  const err = $("#loginError");
  err.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const data = await fetchData(user, password);
    store.saveEmail(user);
    if ($("#remember").checked) store.saveCreds(user, password);
    else store.clearCreds();
    onData(data);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in & load data";
  }
});

$("#signoutBtn").addEventListener("click", () => {
  store.clearCreds();
  store.clearData();
  state.data = null;
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#password").value = "";
});

$("#refreshBtn").addEventListener("click", async () => {
  const creds = store.creds();
  const btn = $("#refreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    let user, password;
    if (creds) { user = creds.user; password = creds.password; }
    else {
      user = prompt("Email:", store.email() || "");
      password = user ? prompt("Password:") : null;
      if (!user || !password) throw new Error("cancelled");
    }
    const data = await fetchData(user, password);
    onData(data);
  } catch (ex) {
    if (ex.message !== "cancelled") alert("Refresh failed: " + ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
});

// ---- once we have data ---------------------------------------------------
function onData(data) {
  state.data = data;
  store.cacheData(data);
  state.league = (data.order && data.order[0]) || "standard";
  state.sort = { ...DEFAULT_SORT };
  pickDefaultBracket();
  $("#fetchedMeta").textContent = data.fetchedAt
    ? "Updated " + new Date(data.fetchedAt).toLocaleString() : "";
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  renderLeagueSeg();
  renderAll();
}

function bracketsFor(league) {
  const b = state.data.leagues[league].brackets;
  return Object.keys(b).sort();  // ["A","B"] or ["Main"]
}

function pickDefaultBracket() {
  const labels = bracketsFor(state.league);
  state.bracket = labels.length > 1 ? "__both__" : labels[0];
}

// ---- rendering: controls -------------------------------------------------
function renderLeagueSeg() {
  const seg = $("#leagueSeg");
  seg.innerHTML = "";
  state.data.order.forEach((key) => {
    if (!state.data.leagues[key]) return;
    const btn = document.createElement("button");
    btn.textContent = state.data.leagues[key].name;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", key === state.league);
    btn.onclick = () => {
      if (state.league === key) return;
      state.league = key;
      pickDefaultBracket();
      renderLeagueSeg();
      renderAll();
    };
    seg.appendChild(btn);
  });
}

function renderBracketSeg() {
  const labels = bracketsFor(state.league);
  const group = $("#bracketGroup");
  const seg = $("#bracketSeg");
  seg.innerHTML = "";
  // Single-bracket leagues (Scotch Doubles) don't need a bracket chooser.
  if (labels.length < 2) { group.classList.add("hidden"); return; }
  group.classList.remove("hidden");
  // single-letter labels read nicely as "Bracket A"; anything else shown as-is
  const options = [
    ...labels.map((l) => ({ v: l, t: l.length === 1 ? "Bracket " + l : l })),
    { v: "__both__", t: "Both" },
  ];
  options.forEach((o) => {
    const btn = document.createElement("button");
    btn.textContent = o.t;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.bracket === o.v);
    btn.onclick = () => {
      state.bracket = o.v;
      renderBracketSeg();
      renderTable();
      renderStats();
    };
    seg.appendChild(btn);
  });
}

// ---- rendering: rows -----------------------------------------------------
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
  return sortRows(rows);
}

function sortRows(rows) {
  const { key, dir } = state.sort;
  const mult = dir === "asc" ? 1 : -1;
  const col = COLUMNS.find((c) => c.key === key) || {};
  return rows.slice().sort((a, b) => {
    if (col.type === "text") {
      return mult * String(a[key]).localeCompare(String(b[key]));
    }
    const av = a[key], bv = b[key];
    // nulls (e.g. GP/MP with 0 matches) always sort to the bottom
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return mult * (av - bv);
  });
}

function renderThead() {
  const tr = document.createElement("tr");
  COLUMNS.forEach((c) => {
    if (c.key === "rank") { // rank column isn't a data field; not sortable
      const th = document.createElement("th");
      th.textContent = c.label;
      th.setAttribute("aria-sort", "none");
      tr.appendChild(th);
      return;
    }
    const th = document.createElement("th");
    if (c.type === "text") th.className = "text";
    const active = state.sort.key === c.key;
    th.setAttribute("aria-sort", active ? state.sort.dir : "none");
    th.innerHTML = c.label + ' <span class="arrow">' +
      (active ? (state.sort.dir === "asc" ? "▲" : "▼") : "▼") + "</span>";
    th.onclick = () => {
      if (state.sort.key === c.key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = c.key;
        state.sort.dir = c.type === "text" ? "asc" : "desc";
      }
      renderTable();
    };
    tr.appendChild(th);
  });
  // optional bracket column when showing Both
  if (state.showBracketCol) {
    const th = document.createElement("th");
    th.className = "text";
    th.textContent = "Bkt";
    th.setAttribute("aria-sort", "none");
    tr.appendChild(th);
  }
  const thead = $("#thead");
  thead.innerHTML = "";
  thead.appendChild(tr);
}

function fmt(v, key) {
  if (v === null || v === undefined) return "—";
  if (key === "GPMP") return v.toFixed(2);
  if (key === "winPct") return v.toFixed(1) + "%";
  return v;
}

function renderTable() {
  renderThead();
  const rows = currentRows();
  const tbody = $("#tbody");
  tbody.innerHTML = "";
  $("#emptyState").classList.toggle("hidden", rows.length > 0);
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    let html = "";
    COLUMNS.forEach((c) => {
      if (c.key === "rank") html += `<td class="rank">${i + 1}</td>`;
      else if (c.key === "name") html += `<td class="text name">${escapeHtml(r.name)}</td>`;
      else html += `<td>${fmt(r[c.key], c.key)}</td>`;
    });
    if (state.showBracketCol) html += `<td class="text"><span class="badge">${r.bracket}</span></td>`;
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}

function renderStats() {
  const rows = currentRows();
  const rated = rows.filter((r) => r.MP > 0);
  const avg = (arr, k) => arr.length ? (arr.reduce((s, r) => s + r[k], 0) / arr.length) : 0;
  const tiles = [
    { k: "Players", v: rows.length },
    { k: "Avg Points", v: avg(rated, "GP").toFixed(1) },
    { k: "Avg Pts / Match", v: avg(rated, "GPMP").toFixed(2) },
    { k: "Avg Win %", v: avg(rated, "winPct").toFixed(1) + "%" },
  ];
  $("#stats").innerHTML = tiles.map((t) =>
    `<div class="stat"><div class="k">${t.k}</div><div class="v">${t.v}</div></div>`).join("");
}

function renderAll() {
  renderBracketSeg();
  renderStats();
  renderTable();
}

// ---- CSV export ----------------------------------------------------------
$("#csvBtn").addEventListener("click", () => {
  const rows = currentRows();
  const cols = COLUMNS.filter((c) => c.key !== "rank");
  const header = ["rank", ...cols.map((c) => c.label)];
  if (state.showBracketCol) header.push("bracket");
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(",")];
  rows.forEach((r, i) => {
    const line = [i + 1, ...cols.map((c) => cell(r[c.key]))];
    if (state.showBracketCol) line.push(r.bracket);
    lines.push(line.join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const leagueSlug = slug(state.data.leagues[state.league].name) || state.league;
  const bkt = state.showBracketCol ? "both" : slug(state.bracket || "all");
  a.download = `pal_${leagueSlug}_${bkt}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---- boot ----------------------------------------------------------------
(async function boot() {
  initTheme();
  $("#email").value = store.email();
  if (store.creds()) $("#remember").checked = true;

  // 1) Data already cached for this browser session? Show it, no query.
  const cached = store.cachedData();
  if (cached && cached.leagues) { onData(cached); return; }

  // 2) Saved credentials? Auto-load so the app "just opens" to the data.
  const creds = store.creds();
  if (creds) {
    try {
      const data = await fetchData(creds.user, creds.password);
      onData(data);
      return;
    } catch (_) { /* fall through to the login screen */ }
  }
  // 3) Otherwise the login screen is already visible.
})();
