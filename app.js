// FRC Prescouting - zero-dependency static app (CSV -> table/team/compare).
// Designed for GitHub Pages: reads `config.json` and `data/prescout.csv` from same origin.

const DEFAULT_CONFIG = {
  dataPath: "./data/prescout.csv",
  sourceUrl: "",
  teamIdColumnCandidates: ["Team", "team", "队号", "队伍", "队伍编号", "Team Number", "TeamNumber"],
  preferredMetricColumns: [],
  maxCompareTeams: 4,
  topInsightCount: 3,
  tba: {
    // If set, the app will call your proxy (recommended) and users won't need to enter a TBA key.
    // Example: "https://your-worker.example.com"
    // If you put a raw key here, the site will work without user input, but the key will be public.
    key: "",
    proxyBase: "",
  },
  supabase: {
    url: "",
    anonKey: "",
    table: "app_settings",
    tbaKeyName: "tba_api_key",
    datasetTable: "prescout_datasets",
    datasetName: "default",
    teamTable: "prescout_teams",
    statboticsTable: "statbotics_event_matches",
  },
  ui: { defaultView: "overview" },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of children) n.append(c);
  return n;
};

const state = {
  config: DEFAULT_CONFIG,
  source: { kind: "path", label: DEFAULT_CONFIG.dataPath },
  rows: [],
  cols: [],
  teamCol: null,
  numericCols: [],
  import: { active: false, replaced: false, backup: null },
  viz: { mode: "scatter" },
  tba: { key: "", proxyBase: "", cache: new Map() },
  supabase: {
    url: "",
    anonKey: "",
    table: "app_settings",
    tbaKeyName: "tba_api_key",
    datasetTable: "prescout_datasets",
    datasetName: "default",
    teamTable: "prescout_teams",
    statboticsTable: "statbotics_event_matches",
  },
  stats: {
    min: new Map(),
    max: new Map(),
    score: new Map(), // teamId -> score 0..100
    rank: new Map(), // teamId -> 1..N
    epaRank: new Map(),
    tierRank: new Map(),
  },
  table: { sortCol: "Rank", sortDir: "asc", query: "", rankMode: "epa" },
  schedule: {
    events: [],
    matches: [],
    event: null,
    statbotics: new Map(), // matchKey -> statbotics match payload
    statboticsTeams: new Map(), // teamNumber -> statbotics team payload
    statboticsSource: "",
  },
  compare: new Set(),
};

const LS_TBA_KEY = "frc_prescout_tba_key";
const LS_SUPABASE_CONFIG = "frc_prescout_supabase_config";

function showStatus(msg) {
  const card = $("#statusCard");
  const t = $("#statusText");
  if (!msg) {
    card.hidden = true;
    t.textContent = "";
    return;
  }
  card.hidden = false;
  t.textContent = msg;
}

function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  return "*".repeat(Math.max(15, Math.min(48, k.length)));
}

function updateTbaKeyUi() {
  const saved = $("#tbaKeySaved");
  if (!saved) return;
  saved.textContent = state.tba.proxyBase
    ? "已启用：TBA 代理"
    : state.tba.key
      ? `已保存：${maskKey(state.tba.key)}`
      : "未保存";
}

function hasTbaAccess() {
  return Boolean(state.tba.key || state.tba.proxyBase);
}

function supabaseConfigFromInputs() {
  const normalizeTable = (name) =>
    String(name || "")
      .trim()
      .replace(/^public\./i, "")
      .replace(/^"(.+)"$/i, "$1");

  return {
    url: String($("#supabaseUrl")?.value || "").trim().replace(/\/$/, ""),
    anonKey: String($("#supabaseAnonKey")?.value || "").trim(),
    table: normalizeTable($("#supabaseTable")?.value) || "app_settings",
    tbaKeyName: String($("#supabaseSettingKey")?.value || "").trim() || "tba_api_key",
    datasetTable: "prescout_datasets",
    datasetName: String($("#supabaseDatasetName")?.value || "").trim() || "default",
    teamTable: normalizeTable($("#supabaseDatasetTable")?.value) || "prescout_teams",
    statboticsTable: "statbotics_event_matches",
  };
}

function setSupabaseConfig(config) {
  const normalizeTable = (name) =>
    String(name || "")
      .trim()
      .replace(/^public\./i, "")
      .replace(/^"(.+)"$/i, "$1");

  state.supabase = {
    url: String(config?.url || "").trim().replace(/\/$/, ""),
    anonKey: String(config?.anonKey || "").trim(),
    table: normalizeTable(config?.table) || "app_settings",
    tbaKeyName: String(config?.tbaKeyName || "tba_api_key").trim() || "tba_api_key",
    datasetTable: String(config?.datasetTable || "prescout_datasets").trim() || "prescout_datasets",
    datasetName: String(config?.datasetName || "default").trim() || "default",
    teamTable: normalizeTable(config?.teamTable) || "prescout_teams",
    statboticsTable: String(config?.statboticsTable || "statbotics_event_matches").trim() || "statbotics_event_matches",
  };
}

function updateSupabaseUi() {
  const cfg = state.supabase;
  const url = $("#supabaseUrl");
  const anonKey = $("#supabaseAnonKey");
  const table = $("#supabaseTable");
  const settingKey = $("#supabaseSettingKey");
  const datasetTable = $("#supabaseDatasetTable");
  const datasetName = $("#supabaseDatasetName");
  const status = $("#supabaseStatus");
  if (url) url.value = cfg.url || "";
  if (anonKey) anonKey.value = cfg.anonKey || "";
  if (table) table.value = cfg.table || "app_settings";
  if (settingKey) settingKey.value = cfg.tbaKeyName || "tba_api_key";
  if (datasetTable) datasetTable.value = cfg.teamTable || "prescout_teams";
  if (datasetName) datasetName.value = cfg.datasetName || "default";
  if (status) status.textContent = cfg.url ? `已配置 Supabase：${cfg.url}` : "表结构：app_settings(key text primary key, value text)。";
}

function saveSupabaseConfigToLocalStorage() {
  try {
    localStorage.setItem(LS_SUPABASE_CONFIG, JSON.stringify(state.supabase));
  } catch {
    // ignore
  }
}

function loadSupabaseConfigFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_SUPABASE_CONFIG);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function mergeSupabaseConfig(base, override) {
  const merged = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (String(value ?? "").trim()) merged[key] = value;
  }
  return merged;
}

function supabaseRestUrl(pathAndQuery = "") {
  const base = String(state.supabase.url || "").replace(/\/$/, "");
  return `${base}/rest/v1/${pathAndQuery}`;
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: state.supabase.anonKey,
    Authorization: `Bearer ${state.supabase.anonKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function hasSupabaseConfig() {
  return Boolean(state.supabase.url && state.supabase.anonKey && state.supabase.table && state.supabase.tbaKeyName);
}

function hasSupabaseDatasetConfig() {
  return Boolean(hasSupabaseConfig() && state.supabase.datasetTable && state.supabase.datasetName);
}

function hasSupabaseTeamConfig() {
  return Boolean(hasSupabaseConfig() && state.supabase.teamTable);
}

function safeParseNumber(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Allow "92%" style if user exported as percent.
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function detectDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/).find((l) => l.trim().length) || "";
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  if (tabCount >= 2 && tabCount >= commaCount) return "\t";
  return ",";
}

// Minimal delimited parser with quote support (CSV/TSV).
function parseCSV(text, delimiter = ",") {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    // Ignore trailing empty last row.
    if (row.length === 1 && row[0] === "" && rows.length > 0) return;
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushField();
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Consume optional \r\n
      i += 1;
      if (text[i] === "\n") i += 1;
      pushField();
      pushRow();
      continue;
    }
    field += ch;
    i += 1;
  }
  pushField();
  if (row.length) pushRow();
  return rows;
}

function normalizeColName(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pickTeamColumn(cols, candidates) {
  const normCols = cols.map((c) => [c, normalizeColName(c)]);
  const want = candidates.map(normalizeColName);
  for (const w of want) {
    const found = normCols.find(([, n]) => n === w);
    if (found) return found[0];
  }
  // fallback: any column that looks like team number
  const fuzzy = normCols.find(([, n]) => (n.includes("team") && n.includes("num")) || n.includes("队号"));
  return fuzzy ? fuzzy[0] : cols[0] ?? null;
}

function inferNumericColumns(rows, cols) {
  const numeric = [];
  for (const c of cols) {
    let ok = 0;
    let total = 0;
    for (const r of rows) {
      const v = r[c];
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      total += 1;
      const n = safeParseNumber(s);
      if (n != null) ok += 1;
    }
    if (total === 0) continue;
    if (ok / total >= 0.7) numeric.push(c);
  }
  return numeric;
}

function computeStats() {
  state.stats.min.clear();
  state.stats.max.clear();
  state.stats.score.clear();
  state.stats.rank.clear();
  state.stats.epaRank.clear();
  state.stats.tierRank.clear();

  for (const c of state.numericCols) {
    let min = Infinity;
    let max = -Infinity;
    for (const r of state.rows) {
      const n = safeParseNumber(r[c]);
      if (n == null) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (min === Infinity || max === -Infinity) continue;
    state.stats.min.set(c, min);
    state.stats.max.set(c, max);
  }

  const metricCols =
    (state.config.preferredMetricColumns || []).filter((c) => state.numericCols.includes(c)) ||
    [];
  const colsForScore = metricCols.length ? metricCols : state.numericCols;

  for (const r of state.rows) {
    const team = String(r[state.teamCol] ?? "").trim();
    if (!team) continue;
    let sum = 0;
    let cnt = 0;
    for (const c of colsForScore) {
      const n = safeParseNumber(r[c]);
      if (n == null) continue;
      const min = state.stats.min.get(c);
      const max = state.stats.max.get(c);
      if (min == null || max == null) continue;
      const t = max === min ? 1 : (n - min) / (max - min);
      sum += Math.max(0, Math.min(1, t));
      cnt += 1;
    }
    const score01 = cnt ? sum / cnt : 0;
    state.stats.score.set(team, Math.round(score01 * 1000) / 10); // one decimal
  }

  const epaRanked = [...state.stats.score.entries()].sort((a, b) => b[1] - a[1]);
  epaRanked.forEach(([team], idx) => state.stats.epaRank.set(team, idx + 1));

  const tierCol = state.cols.find((c) => normalizeColName(c) === "tier" || c.includes("排行"));
  const tierRanked = [...state.rows].sort((a, b) => {
    const at = tierRankValue(a[tierCol]);
    const bt = tierRankValue(b[tierCol]);
    if (at !== bt) return at - bt;
    const ae = safeParseNumber(a.EPA) ?? -Infinity;
    const be = safeParseNumber(b.EPA) ?? -Infinity;
    if (ae !== be) return be - ae;
    return String(a[state.teamCol] ?? "").localeCompare(String(b[state.teamCol] ?? ""), undefined, { numeric: true });
  });
  tierRanked.forEach((row, idx) => {
    const team = String(row[state.teamCol] ?? "").trim();
    if (team) state.stats.tierRank.set(team, idx + 1);
  });
  updateActiveRank();
}

function tierRankValue(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s || s === "N/A" || s === "？" || s === "?") return 99;
  const match = s.match(/^T(\d+(?:\.\d+)?)$/);
  return match ? Number(match[1]) : 99;
}

function normalizeTierDisplay(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const match = s.match(/^t(\d+(?:\.\d+)?)$/i);
  if (match) return `T${match[1]}`;
  return s;
}

function tierCategory(value) {
  const s = normalizeTierDisplay(value);
  if (!s || s === "N/A" || s === "？" || s === "?") return "未知";
  return s;
}

function updateActiveRank() {
  state.stats.rank.clear();
  const source = state.table.rankMode === "tier" ? state.stats.tierRank : state.stats.epaRank;
  for (const [team, rank] of source.entries()) state.stats.rank.set(team, rank);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseHash() {
  const h = (location.hash || "").replace(/^#/, "");
  if (!h) return { view: state.config.ui?.defaultView || "overview", team: null, compare: [] };

  const [head, rest] = h.split("=", 2);
  const view = head.trim();
  if (view === "team") return { view, team: rest ? decodeURIComponent(rest) : null, compare: [] };
  if (view === "compare") {
    const list = (rest || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { view, team: null, compare: list };
  }
  if (["overview", "table", "viz", "schedule", "import"].includes(view)) return { view, team: null, compare: [] };
  return { view: "overview", team: null, compare: [] };
}

function setActiveNav(view) {
  for (const a of document.querySelectorAll(".nav-link")) {
    const href = a.getAttribute("href") || "";
    const active = href === `#${view}` || href === `#${view}`.replace("=null", "");
    a.classList.toggle("active", active);
  }
}

function showView(viewId) {
  $("#viewOverview").hidden = viewId !== "overview";
  $("#viewTable").hidden = viewId !== "table";
  $("#viewViz").hidden = viewId !== "viz";
  $("#viewTeam").hidden = viewId !== "team";
  $("#viewSchedule").hidden = viewId !== "schedule";
  $("#viewCompare").hidden = viewId !== "compare";
  $("#viewImport").hidden = viewId !== "import";
  setActiveNav(viewId);
}

function getMetricColumns(limit = Infinity) {
  const preferred = (state.config.preferredMetricColumns || []).filter((c) => state.numericCols.includes(c));
  const cols = preferred.length ? preferred : state.numericCols;
  return cols.slice(0, limit);
}

function getTeamRow(teamId) {
  return state.rows.find((r) => String(r[state.teamCol] ?? "").trim() === String(teamId).trim());
}

function normalizedValue(row, col) {
  const v = safeParseNumber(row?.[col]);
  const min = state.stats.min.get(col);
  const max = state.stats.max.get(col);
  if (v == null || min == null || max == null) return null;
  return max === min ? 1 : Math.max(0, Math.min(1, (v - min) / (max - min)));
}

function findNotes(row) {
  const noteCols = state.cols.filter((c) => /note|备注|评价|comment|优势|问题|特点/i.test(c));
  return noteCols
    .map((c) => String(row[c] ?? "").trim())
    .filter(Boolean)
    .join("；");
}

function renderOverview() {
  const panel = $("#overviewPanel");
  panel.innerHTML = "";
  if (!state.rows.length) {
    panel.append(
      el("div", {
        class: "pane",
        html: `<div class="empty-title">还没有载入真实 prescout 数据</div><div class="muted">请从腾讯文档导出 CSV，覆盖 <code>data/prescout.csv</code>，然后刷新页面。现在我已经移除了示例队伍，避免误导。</div>`,
      })
    );
    return;
  }
  const ranked = [...state.stats.score.entries()].sort((a, b) => b[1] - a[1]);
  const avgScore = ranked.length ? ranked.reduce((sum, [, score]) => sum + Number(score || 0), 0) / ranked.length : 0;
  const sourceLink = state.config.sourceUrl
    ? `<a href="${escapeHtml(state.config.sourceUrl)}" target="_blank" rel="noreferrer">腾讯文档源表</a>`
    : escapeHtml(state.source.label);

  panel.append(
    el("div", { class: "pane" }, [
      el("div", { class: "statrow" }, [
        el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "队伍数" }), el("div", { class: "stat-v", html: String(state.rows.length) })]),
        el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "数值指标" }), el("div", { class: "stat-v", html: String(state.numericCols.length) })]),
        el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "平均评分" }), el("div", { class: "stat-v", html: `${formatNumber(avgScore)}<small> /100</small>` })]),
        el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "数据来源" }), el("div", { class: "stat-v stat-v-small", html: sourceLink })]),
      ]),
    ])
  );

  const topCount = state.config.topInsightCount || 3;
  const topTeams = ranked.slice(0, topCount);
  const topList = el("div", { class: "rank-list" });
  for (const [team, score] of topTeams) {
    topList.append(
      el("a", { class: "rank-item", href: `#team=${encodeURIComponent(team)}` }, [
        el("span", { html: `#${escapeHtml(team)}` }),
        el("strong", { html: `${escapeHtml(score)} /100` }),
      ])
    );
  }

  const metricSummary = el("div", { class: "metric-grid" });
  for (const c of getMetricColumns(8)) {
    metricSummary.append(
      el("div", { class: "metric-card" }, [
        el("div", { class: "metric-name", html: escapeHtml(c) }),
        el("div", { class: "metric-range", html: `${formatNumber(state.stats.min.get(c))} → ${formatNumber(state.stats.max.get(c))}` }),
      ])
    );
  }

  panel.append(
    el("div", { class: "pane col5" }, [el("div", { class: "pane-title", html: "Top 队伍" }), topList]),
    el("div", { class: "pane col7" }, [el("div", { class: "pane-title", html: "指标范围" }), metricSummary])
  );
}

function renderViz() {
  const viz = $("#tableViz");
  viz.innerHTML = "";
  const teamCol = state.teamCol;
  if (!teamCol) return;
  if (!state.rows.length) {
    viz.append(
      el("div", {
        class: "viz-card",
        html: `还没有数据。请到“导入”页粘贴表格或导入 CSV，然后回来查看图表。`,
      })
    );
    return;
  }

  const q = (state.table.query || "").trim().toLowerCase();
  const tierCol =
    state.cols.find(
      (c) => normalizeColName(c) === "tier" || c.includes("排行") || normalizeColName(c).includes("t0-4")
    ) || "Tier";
  const epaCol = state.cols.find((c) => normalizeColName(c) === "epa") || "EPA";
  const nameCol = state.cols.find((c) => normalizeColName(c) === "team name" || normalizeColName(c) === "teamname") || "Team Name";

  const rows = state.rows
    .filter((r) => {
      if (!q) return true;
      const team = String(r[teamCol] ?? "").toLowerCase();
      if (team.includes(q)) return true;
      // search any string column (small data)
      for (const c of state.cols) {
        const v = r[c];
        if (v == null) continue;
        const s = String(v).toLowerCase();
        if (s.includes(q)) return true;
      }
      return false;
    })
    .map((r) => {
      const team = String(r[teamCol] ?? "").trim();
      return { ...r, Score: state.stats.score.get(team) ?? "", Rank: state.stats.rank.get(team) ?? "" };
    });

  // ---- Chart 1: dot graph (Tier vs EPA) ----
  const points = rows
    .map((r) => {
      const team = String(r[teamCol] ?? "").trim();
      const name = String(r[nameCol] ?? "").trim();
      const epa = safeParseNumber(r[epaCol]);
      const tier = tierCategory(r[tierCol]);
      return { team, name, epa, tier };
    })
    .filter((p) => p.team && p.epa != null && p.tier !== "未知");

  // X axis: T4 -> T0 (descending). Unknown tiers are excluded.
  const tiers = [...new Set(points.map((p) => p.tier))].sort((a, b) => tierRankValue(b) - tierRankValue(a));
  const rawMinEpa = Math.min(...points.map((p) => p.epa));
  const rawMaxEpa = Math.max(...points.map((p) => p.epa));
  const padEpa = (rawMaxEpa - rawMinEpa) * 0.08;
  const minEpa = rawMinEpa - (Number.isFinite(padEpa) ? padEpa : 0);
  const maxEpa = rawMaxEpa + (Number.isFinite(padEpa) ? padEpa : 0);

  const dotCard = el("div", { class: "viz-card" }, [
    el("div", { class: "viz-title", html: "Dot Graph" }),
    el("div", { class: "viz-sub", html: "X 轴：EPA｜Y 轴：Tier｜点击点进入队伍详情" }),
  ]);

  const w = 1100;
  const h = 720;
  const pad = { l: 56, r: 18, t: 18, b: 62 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const yStep = tiers.length > 1 ? plotH / (tiers.length - 1) : plotH / 2;
  const yIndex = (tier) => {
    const idx = tiers.indexOf(tier);
    if (idx < 0) return tiers.length - 1;
    // Flip: show T0 at top, T4 at bottom (for Tier axis)
    return (tiers.length - 1) - idx;
  };
  const yOf = (tier) => pad.t + yIndex(tier) * yStep;
  const xOf = (epa) => {
    const t = maxEpa === minEpa ? 0.5 : (epa - minEpa) / (maxEpa - minEpa);
    return pad.l + t * plotW;
  };

  const jitter = (team) => {
    // stable pseudo-random [-1, 1]
    const s = String(team ?? "");
    let hash = 2166136261;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const u = (hash >>> 0) / 0xffffffff;
    return u * 2 - 1;
  };

  const xTicks = 5;
  const grid = [];
  for (let i = 0; i <= xTicks; i++) {
    const t = i / xTicks;
    const x = pad.l + t * plotW;
    const v = Math.round((minEpa + (maxEpa - minEpa) * t) * 10) / 10;
    grid.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${h - pad.b}" stroke="rgba(255,255,255,0.08)" />`);
    grid.push(`<text x="${x}" y="${h - 30}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="12">${v}</text>`);
  }
  const yLabels = tiers
    .map((t) => {
      const y = yOf(t);
      grid.push(`<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="rgba(255,255,255,0.06)" />`);
      return `<text x="${pad.l - 10}" y="${y + 4}" text-anchor="end" fill="rgba(255,255,255,0.75)" font-size="12">${escapeHtml(t)}</text>`;
    })
    .join("");

  const dots = points
    .map((p) => {
      const j = jitter(p.team);
      const x = Math.max(pad.l, Math.min(w - pad.r, xOf(p.epa) + j * 9));
      const y = Math.max(pad.t, Math.min(h - pad.b, yOf(p.tier) + j * 7));
      const title = `${p.team}`;
      return `
        <a xlink:href="#team=${encodeURIComponent(p.team)}">
          <circle cx="${x}" cy="${y}" r="5" fill="rgba(126,231,135,0.85)" stroke="rgba(0,0,0,0.35)" stroke-width="1">
            <title>${escapeHtml(title)}</title>
            <desc data-team="${escapeHtml(p.team)}" data-name="${escapeHtml(p.name)}" data-epa="${escapeHtml(formatNumber(p.epa))}" data-tier="${escapeHtml(p.tier)}"></desc>
          </circle>
        </a>
      `;
    })
    .join("");

  dotCard.append(
    el("div", {
      html: `<svg class="viz-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="EPA vs Tier scatter">
        <rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.08)" />
        ${grid.join("")}
        ${yLabels}
        <text x="${w / 2}" y="${h - 10}" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="12">EPA</text>
        <text x="16" y="${h / 2}" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="12" transform="rotate(-90 16 ${h / 2})">Tier</text>
        ${dots}
      </svg>`,
    })
  );
  dotCard.style.position = "relative";
  const tooltip = el("div", { class: "dot-tooltip", style: "display:none" });
  dotCard.append(tooltip);

  const updateTooltip = (evt, data) => {
    tooltip.innerHTML = `
      <div><b>${escapeHtml(data.team)}</b>${data.name ? ` · ${escapeHtml(data.name)}` : ""}</div>
      <div class="muted">EPA: <b>${escapeHtml(data.epa)}</b> · Tier: <b>${escapeHtml(data.tier)}</b></div>
    `;
    tooltip.style.display = "block";
    const rect = dotCard.getBoundingClientRect();
    const x = Math.min(rect.width - 16, Math.max(8, evt.clientX - rect.left + 12));
    const y = Math.min(rect.height - 16, Math.max(8, evt.clientY - rect.top + 12));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.style.transform = "translate(0, 0)";
  };

  const hideTooltip = () => {
    tooltip.style.display = "none";
  };

  // Attach hover tooltip for dots.
  dotCard.querySelectorAll("circle").forEach((circle) => {
    const desc = circle.querySelector("desc");
    if (!desc) return;
    const data = {
      team: desc.getAttribute("data-team") || "",
      name: desc.getAttribute("data-name") || "",
      epa: desc.getAttribute("data-epa") || "",
      tier: desc.getAttribute("data-tier") || "",
    };
    circle.addEventListener("mousemove", (e) => updateTooltip(e, data));
    circle.addEventListener("mouseenter", (e) => updateTooltip(e, data));
    circle.addEventListener("mouseleave", hideTooltip);
  });

  // ---- Chart 2: Tier distribution ----
  const counts = new Map();
  for (const p of points) counts.set(p.tier, (counts.get(p.tier) || 0) + 1);
  const distTiers = [...counts.keys()].sort((a, b) => tierRankValue(a) - tierRankValue(b));
  const maxCount = Math.max(...distTiers.map((t) => counts.get(t) || 0), 1);

  const distCard = el("div", { class: "viz-card" }, [
    el("div", { class: "viz-title", html: "Tier 分布" }),
    el("div", { class: "viz-sub", html: "每个 Tier 的队伍数量" }),
  ]);

  const dw = 780;
  const dh = 560;
  const dpad = { l: 36, r: 16, t: 18, b: 62 };
  const dPlotW = dw - dpad.l - dpad.r;
  const dPlotH = dh - dpad.t - dpad.b;
  const barW = distTiers.length ? dPlotW / distTiers.length : dPlotW;

  const bars = distTiers
    .map((t, idx) => {
      const c = counts.get(t) || 0;
      const bh = (c / maxCount) * dPlotH;
      const x = dpad.l + idx * barW + Math.max(1, barW * 0.15);
      const y = dpad.t + (dPlotH - bh);
      const wBar = Math.max(2, barW * 0.7);
      return `
        <rect x="${x}" y="${y}" width="${wBar}" height="${bh}" fill="rgba(79,168,255,0.75)">
          <title>${escapeHtml(t)}: ${c}</title>
        </rect>
        <text x="${x + wBar / 2}" y="${dh - 30}" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="12">${escapeHtml(t)}</text>
      `;
    })
    .join("");

  distCard.append(
    el("div", {
      html: `<svg class="viz-svg" viewBox="0 0 ${dw} ${dh}" role="img" aria-label="Tier distribution">
        <rect x="${dpad.l}" y="${dpad.t}" width="${dPlotW}" height="${dPlotH}" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.08)" />
        ${bars}
        <text x="${dw / 2}" y="${dh - 10}" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="12">Tier</text>
        <text x="14" y="${dh / 2}" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-size="12" transform="rotate(-90 14 ${dh / 2})">Count</text>
      </svg>`,
    })
  );

  viz.append(state.viz.mode === "dist" ? distCard : dotCard);
}

function renderTable() {
  const table = $("#teamsTable");
  table.innerHTML = "";
  const teamCol = state.teamCol;
  if (!teamCol) return;
  if (!state.rows.length) {
    table.append(
      el("tbody", {}, [
        el("tr", {}, [
          el("td", {
            html: `还没有数据。请到“导入”页粘贴表格或导入 CSV。`,
          }),
        ]),
      ])
    );
    return;
  }

  const q = (state.table.query || "").trim().toLowerCase();
  const nameCol =
    state.cols.find((c) => normalizeColName(c) === "team name" || normalizeColName(c) === "teamname") || "Team Name";
  const epaCol = state.cols.find((c) => normalizeColName(c) === "epa") || "EPA";
  const tierCol = state.cols.find(
    (c) => normalizeColName(c) === "tier" || c.includes("排行") || normalizeColName(c).includes("t0-4")
  );

  const showCols = [teamCol, nameCol, epaCol, ...(tierCol ? [tierCol] : []), "Rank"];

  const rows = state.rows
    .filter((r) => {
      if (!q) return true;
      const team = String(r[teamCol] ?? "").toLowerCase();
      if (team.includes(q)) return true;
      for (const c of state.cols) {
        const v = r[c];
        if (v == null) continue;
        const s = String(v).toLowerCase();
        if (s.includes(q)) return true;
      }
      return false;
    })
    .map((r) => {
      const team = String(r[teamCol] ?? "").trim();
      return { ...r, Rank: state.stats.rank.get(team) ?? "" };
    });

  const sortCol = state.table.sortCol;
  const dir = state.table.sortDir;
  if (sortCol) {
    rows.sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      const an = safeParseNumber(av);
      const bn = safeParseNumber(bv);
      if (an != null && bn != null) return dir === "asc" ? an - bn : bn - an;
      return dir === "asc"
        ? String(av ?? "").localeCompare(String(bv ?? ""))
        : String(bv ?? "").localeCompare(String(av ?? ""));
    });
  }

  const thead = el("thead");
  const trh = el("tr");
  for (const c of showCols) {
    const label = tierCol && c === tierCol ? "Tier" : c;
    const th = el("th", {
      html: escapeHtml(label) + (state.table.sortCol === c ? (state.table.sortDir === "asc" ? " ▲" : " ▼") : ""),
      onclick: () => {
        if (state.table.sortCol === c) state.table.sortDir = state.table.sortDir === "asc" ? "desc" : "asc";
        else {
          state.table.sortCol = c;
          state.table.sortDir = c === teamCol ? "asc" : "desc";
        }
        renderTable();
      },
    });
    trh.append(th);
  }
  thead.append(trh);

  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const c of showCols) {
      let v = r[c];
      if (c === teamCol) {
        const team = String(v ?? "").trim();
        const a = el("a", { href: `#team=${encodeURIComponent(team)}`, html: escapeHtml(team) });
        const td = el("td");
        td.append(a);
        tr.append(td);
        continue;
      }
      if (v == null) v = "";
      if (tierCol && c === tierCol) v = normalizeTierDisplay(v);
      tr.append(el("td", { html: escapeHtml(v) }));
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
}

function renderTeam(teamId) {
  const panel = $("#teamPanel");
  panel.innerHTML = "";
  const btnAdd = $("#btnAddToCompare");
  btnAdd.disabled = !teamId;
  if (!teamId) {
    panel.append(el("div", { class: "pane", html: `<div class="muted">输入队号，然后点击“查看”。</div>` }));
    return;
  }

  const row = getTeamRow(teamId);
  if (!row) {
    panel.append(el("div", { class: "pane", html: `<div class="muted">未找到队伍：<b>${escapeHtml(teamId)}</b></div>` }));
    return;
  }

  const team = String(row[state.teamCol] ?? "").trim();
  const teamName = String(row["Team Name"] ?? row["队名"] ?? "").trim();
  const teamTitle = teamName ? `${team} · ${teamName}` : team;
  const score = state.stats.score.get(team) ?? "";
  const rank = state.stats.rank.get(team) ?? "";
  const tier = normalizeTierDisplay(row.Tier ?? row["排行（t0-4）"]) || "-";
  const canTrench = String(row["Can Trench"] ?? row["能否过trench"] ?? "").trim() || "-";

  const statsPane = el("div", { class: "pane" }, [
    el("div", { class: "pane-title", html: `队伍 <b>${escapeHtml(teamTitle)}</b>` }),
    el("div", { class: "statrow" }, [
      el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "综合评分" }), el("div", { class: "stat-v", html: `${escapeHtml(score)}<small> /100</small>` })]),
      el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "排名（按评分）" }), el("div", { class: "stat-v", html: `${escapeHtml(rank)}` })]),
      el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "Tier" }), el("div", { class: "stat-v", html: escapeHtml(tier) })]),
      el("div", { class: "stat" }, [el("div", { class: "stat-k", html: "是否能过 Trench" }), el("div", { class: "stat-v", html: escapeHtml(canTrench) })]),
    ]),
  ]);

  const tbaPane = el("div", { class: "pane" }, [
    el("div", { class: "pane-title", html: "过往战绩（TBA 资格赛排名）" }),
    el("div", { class: "toolbar" }, [
      el("input", { id: "tbaYear", class: "input", type: "number", value: String(new Date().getFullYear()), min: "1992", max: "2100" }),
      el("button", { class: "btn", html: "查询", onclick: () => loadTbaQualRanks(team) }),
      el("div", { class: "spacer" }),
    ]),
    el("div", { id: "tbaResults", class: "muted" }, [
      document.createTextNode(state.tba.key ? "点击“查询”获取数据。" : "在“导入”页填入 TBA Key 后可查询。"),
    ]),
  ]);

  const cols = getMetricColumns(10);
  const rankedMetrics = cols
    .map((c) => ({ col: c, pct: normalizedValue(row, c), value: row[c] }))
    .filter((x) => x.pct != null)
    .sort((a, b) => b.pct - a.pct);
  const bars = el("div", { class: "bars" });
  for (const c of cols) {
    const v = safeParseNumber(row[c]);
    const min = state.stats.min.get(c);
    const max = state.stats.max.get(c);
    const t = v == null || min == null || max == null ? 0 : max === min ? 1 : (v - min) / (max - min);
    const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
    const bar = el("div", { class: "bar" }, [
      el("div", { class: "bar-label", html: escapeHtml(c) }),
      el("div", { class: "bar-track" }, [el("div", { class: "bar-fill", style: `width:${pct}%` })]),
      el("div", { class: "bar-val", html: v == null ? "-" : escapeHtml(String(v)) }),
    ]);
    bars.append(bar);
  }

  const analysisPane = el("div", { class: "pane" }, [
    el("div", { class: "pane-title", html: "指标概览（相对本表 min-max）" }),
    bars,
    el("div", { class: "hint muted", html: "这是一种简单的相对归一化：只适合 prescout 快速比较；后续可按你赛事规则自定义权重/阈值。" }),
  ]);

  const extraFieldGroups = [
    { label: "车类型", fields: ["车类型", "Robot Type", "RobotType", "Type"] },
    { label: "车辆状态", fields: ["车辆状态", "Robot Status", "RobotStatus", "Status"] },
    { label: "打法", fields: ["打法", "Playstyle", "Play Style"] },
    { label: "备注", fields: ["备注", "其他", "Note", "Notes", "Comment", "Comments"] },
  ];

  const extraRows = extraFieldGroups
    .map(({ label, fields }) => {
      for (const f of fields) {
        const v = String(row?.[f] ?? "").trim();
        if (v) return [label, v];
      }
      return null;
    })
    .filter(Boolean);

  const insightPane = el("div", { class: "pane" }, [
    el("div", { class: "pane-title", html: "其他数据" }),
    el("div", {
      class: "analysis-list",
      html: extraRows.length
        ? extraRows.map(([label, value]) => `<div><b>${escapeHtml(label)}：</b>${escapeHtml(value)}</div>`).join("")
        : `<div class="muted">暂无其他数据</div>`,
    }),
  ]);

  const rawTable = el("table", { class: "table" });
  const thead = el("thead");
  thead.append(el("tr", {}, [el("th", { html: "字段" }), el("th", { html: "值" })]));
  const tbody = el("tbody");
  for (const c of state.cols) {
    const v = row[c];
    tbody.append(el("tr", {}, [el("td", { html: escapeHtml(c) }), el("td", { html: escapeHtml(v) })]));
  }
  rawTable.append(thead, tbody);
  const rawPane = el("div", { class: "pane" }, [el("div", { class: "pane-title", html: "原始数据" }), el("div", { class: "scroll" }, [rawTable])]);

  panel.append(statsPane, tbaPane, insightPane, analysisPane, rawPane);

  btnAdd.onclick = () => {
    addCompare(team);
    location.hash = `#compare=${encodeURIComponent([...state.compare].join(","))}`;
  };
}

function addCompare(teamId) {
  const t = String(teamId ?? "").trim();
  if (!t) return;
  if (state.compare.has(t)) return;
  if (state.compare.size >= (state.config.maxCompareTeams || 4)) return;
  state.compare.add(t);
  renderCompareChips();
  renderComparePanel();
}

function removeCompare(teamId) {
  state.compare.delete(String(teamId));
  renderCompareChips();
  renderComparePanel();
}

async function tbaFetchJson(path) {
  const base = String(state.tba.proxyBase || "").trim();
  const url = base
    ? `${base.replace(/\/$/, "")}/api/tba?path=${encodeURIComponent(path)}`
    : `https://www.thebluealliance.com/api/v3${path}`;
  const cached = state.tba.cache.get(url);
  if (cached) return cached;
  const headers = {};
  if (state.tba.key) {
    if (base) headers["x-tba-auth-key"] = state.tba.key;
    else headers["X-TBA-Auth-Key"] = state.tba.key;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TBA HTTP ${res.status}`);
  const data = await res.json();
  state.tba.cache.set(url, data);
  return data;
}

async function loadTbaKeyFromSupabase({ silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseConfig()) {
    if (!silent && status) status.textContent = "请先填写 Supabase URL、anon key、表名和 key 名。";
    return false;
  }

  const table = encodeURIComponent(state.supabase.table);
  const keyName = encodeURIComponent(state.supabase.tbaKeyName);
  const url = supabaseRestUrl(`${table}?key=eq.${keyName}&select=value&limit=1`);
  try {
    if (!silent && status) status.textContent = "正在从 Supabase 读取 TBA Key…";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    const data = await res.json();
    const key = String(data?.[0]?.value || "").trim();
    if (!key) {
      if (!silent && status) status.textContent = `Supabase 里没有找到 ${state.supabase.tbaKeyName}。`;
      return false;
    }
    state.tba.key = key;
    state.tba.cache.clear();
    try {
      localStorage.setItem(LS_TBA_KEY, key);
    } catch {
      // ignore
    }
    const input = $("#tbaKey");
    if (input) input.value = "";
    updateTbaKeyUi();
    if (status) status.textContent = `已从 Supabase 读取 TBA Key：${maskKey(key)}`;
    return true;
  } catch (e) {
    if (!silent && status) status.textContent = `读取失败：${String(e?.message || e)}`;
    return false;
  }
}

async function saveTbaKeyToSupabase() {
  const status = $("#supabaseStatus");
  const currentKey = String(state.tba.key || $("#tbaKey")?.value || "").trim();
  if (!hasSupabaseConfig()) {
    if (status) status.textContent = "请先填写并保存 Supabase 连接。";
    return;
  }
  if (!currentKey) {
    if (status) status.textContent = "请先在 TBA Key 输入框里填入 key。";
    return;
  }

  const table = encodeURIComponent(state.supabase.table);
  const url = supabaseRestUrl(table);
  try {
    if (status) status.textContent = "正在把 TBA Key 存进 Supabase…";
    const res = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ key: state.supabase.tbaKeyName, value: currentKey }),
    });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    state.tba.key = currentKey;
    state.tba.cache.clear();
    try {
      localStorage.setItem(LS_TBA_KEY, currentKey);
    } catch {
      // ignore
    }
    updateTbaKeyUi();
    if (status) status.textContent = `已存进 Supabase：${maskKey(currentKey)}`;
  } catch (e) {
    if (status) status.textContent = `保存失败：${String(e?.message || e)}。请确认表有 upsert 权限。`;
  }
}

async function saveTeamsToSupabase({ silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseTeamConfig()) {
    if (!silent && status) status.textContent = "请先填写并保存 Supabase 连接。";
    return false;
  }
  if (!state.rows.length || !state.cols.length) {
    if (!silent && status) status.textContent = "当前没有队伍数据，请先粘贴表格或导入 CSV。";
    return false;
  }
  if (!state.teamCol) {
    if (!silent && status) status.textContent = "当前数据没有队号列，无法上传到 Supabase。";
    return false;
  }

  const table = encodeURIComponent(state.supabase.teamTable);
  const url = supabaseRestUrl(`${table}?on_conflict=team_number`);
  const updatedAt = new Date().toISOString();
  const seen = new Set();
  const payload = [];

  for (const row of state.rows) {
    const teamNumber = String(row?.[state.teamCol] ?? "").trim();
    if (!teamNumber || seen.has(teamNumber)) continue;
    seen.add(teamNumber);
    payload.push({
      team_number: teamNumber,
      data: row,
      updated_at: updatedAt,
    });
  }

  if (!payload.length) {
    if (!silent && status) status.textContent = "没有可上传的队伍行。";
    return false;
  }

  try {
    if (!silent && status) status.textContent = `正在逐队上传 ${payload.length} 支队伍到 Supabase…`;
    const res = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      throw new Error(`Supabase HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    const ok = await loadTeamsFromSupabase({ silent: true });
    if (!ok) {
      if (status) status.textContent = `已发送上传请求，但读回验证失败（可能是 RLS/权限或表名不对）。`;
      return false;
    }

    const requiredCols = ["车类型", "车辆状态", "打法", "备注", "其他"];
    const hasAny = requiredCols.some((c) => state.cols.includes(c));
    if (status) {
      status.textContent = hasAny
        ? `已逐队上传并验证：${payload.length} 支队伍（同队号已覆盖），当前库内 ${state.rows.length} 支队伍。`
        : `已逐队上传并验证：${payload.length} 支队伍，但未检测到车辆信息列名：${requiredCols.join(" / ")}。`;
    }
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("PGRST205")) {
      return saveTeamsToAppSettings({ rows: state.rows, cols: state.cols, silent });
    }
    if (!silent && status) {
      status.textContent = msg.includes("PGRST205")
        ? `上传失败：Supabase 里还没有 ${state.supabase.teamTable} 表。已尝试旧版整表存储，但也不可用。`
        : `上传队伍数据失败：${msg}`;
    }
    return false;
  }
}

async function saveTeamsToLegacyDataset({ rows, cols, silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseDatasetConfig()) {
    if (!silent && status) status.textContent = "Supabase 旧版队伍表未配置，无法 fallback 上传。";
    return false;
  }

  const incomingTeamCol = pickTeamColumn(cols, state.config.teamIdColumnCandidates || DEFAULT_CONFIG.teamIdColumnCandidates);
  if (!incomingTeamCol) {
    if (!silent && status) status.textContent = "当前数据没有队号列，无法上传。";
    return false;
  }

  const table = encodeURIComponent(state.supabase.datasetTable);
  const name = encodeURIComponent(state.supabase.datasetName);
  const readUrl = supabaseRestUrl(`${table}?name=eq.${name}&select=cols,rows&limit=1`);

  try {
    if (!silent && status) status.textContent = "正在上传到 Supabase（兼容模式）…";

    let existingRows = [];
    let existingCols = [];
    const read = await fetch(readUrl, { headers: supabaseHeaders() });
    if (read.ok) {
      const data = await read.json();
      existingRows = Array.isArray(data?.[0]?.rows) ? data[0].rows : [];
      existingCols = Array.isArray(data?.[0]?.cols) ? data[0].cols : [];
    }

    const mergedByTeam = new Map();
    const existingTeamCol = pickTeamColumn(existingCols, state.config.teamIdColumnCandidates || DEFAULT_CONFIG.teamIdColumnCandidates);
    for (const row of existingRows) {
      const teamNumber = String(row?.[existingTeamCol] ?? row?.[incomingTeamCol] ?? "").trim();
      if (teamNumber) mergedByTeam.set(teamNumber, row);
    }
    for (const row of rows) {
      const teamNumber = String(row?.[incomingTeamCol] ?? "").trim();
      if (teamNumber) mergedByTeam.set(teamNumber, row);
    }

    const mergedRows = [...mergedByTeam.values()];
    const mergedCols = mergeColumns([...existingRows, ...rows]);
    const payload = {
      name: state.supabase.datasetName,
      cols: mergedCols,
      rows: mergedRows,
      updated_at: new Date().toISOString(),
    };

    const write = await fetch(supabaseRestUrl(`${table}?on_conflict=name`), {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(payload),
    });
    if (!write.ok) {
      let detail = "";
      try {
        detail = await write.text();
      } catch {
        // ignore
      }
      throw new Error(`Supabase HTTP ${write.status}${detail ? `: ${detail}` : ""}`);
    }

    setModel({ rows: mergedRows, cols: mergedCols });
    state.import.replaced = true;
    state.source = { kind: "supabase", label: state.supabase.datasetName };
    if (status) status.textContent = `已上传到 Supabase：${rows.length} 支队伍已更新，当前库内 ${mergedRows.length} 支队伍。`;
    onRoute();
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("PGRST205")) {
      return saveTeamsToAppSettings({ rows, cols, silent });
    }
    if (!silent && status) status.textContent = `上传队伍数据失败：${String(e?.message || e)}`;
    return false;
  }
}

async function saveTeamsToAppSettings({ rows, cols, silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseConfig()) {
    if (!silent && status) status.textContent = "请先填写并保存 Supabase 连接。";
    return false;
  }

  const incomingTeamCol = pickTeamColumn(cols, state.config.teamIdColumnCandidates || DEFAULT_CONFIG.teamIdColumnCandidates);
  if (!incomingTeamCol) {
    if (!silent && status) status.textContent = "当前数据没有队号列，无法上传。";
    return false;
  }

  const table = encodeURIComponent(state.supabase.table);
  const keyName = "prescout_team_data";
  const readUrl = supabaseRestUrl(`${table}?key=eq.${encodeURIComponent(keyName)}&select=value&limit=1`);

  try {
    if (!silent && status) status.textContent = "正在上传到 Supabase（兼容存储）…";

    let existingRows = [];
    let existingCols = [];
    const read = await fetch(readUrl, { headers: supabaseHeaders() });
    if (read.ok) {
      const data = await read.json();
      const raw = data?.[0]?.value;
      if (raw) {
        const parsed = JSON.parse(raw);
        existingRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
        existingCols = Array.isArray(parsed?.cols) ? parsed.cols : [];
      }
    }

    const mergedByTeam = new Map();
    const existingTeamCol = pickTeamColumn(existingCols, state.config.teamIdColumnCandidates || DEFAULT_CONFIG.teamIdColumnCandidates);
    for (const row of existingRows) {
      const teamNumber = String(row?.[existingTeamCol] ?? row?.[incomingTeamCol] ?? "").trim();
      if (teamNumber) mergedByTeam.set(teamNumber, row);
    }
    for (const row of rows) {
      const teamNumber = String(row?.[incomingTeamCol] ?? "").trim();
      if (teamNumber) mergedByTeam.set(teamNumber, row);
    }

    const mergedRows = [...mergedByTeam.values()];
    const mergedCols = mergeColumns([...existingRows, ...rows]);
    const payloadValue = JSON.stringify({
      cols: mergedCols,
      rows: mergedRows,
      updated_at: new Date().toISOString(),
    });

    const write = await fetch(supabaseRestUrl(table), {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ key: keyName, value: payloadValue }),
    });
    if (!write.ok) {
      let detail = "";
      try {
        detail = await write.text();
      } catch {
        // ignore
      }
      throw new Error(`Supabase HTTP ${write.status}${detail ? `: ${detail}` : ""}`);
    }

    setModel({ rows: mergedRows, cols: mergedCols });
    state.import.replaced = true;
    state.source = { kind: "supabase", label: keyName };
    if (status) status.textContent = `已上传到 Supabase：${rows.length} 支队伍已更新，当前库内 ${mergedRows.length} 支队伍。`;
    onRoute();
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!silent && status) {
      status.textContent = msg.includes("PGRST205")
        ? "Supabase 还没有初始化：缺少 app_settings 表。请先在 Supabase SQL Editor 运行 supabase-schema.sql。"
        : `上传队伍数据失败：${msg}`;
    }
    return false;
  }
}

async function loadTeamsFromSupabase({ silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseTeamConfig()) {
    if (!silent && status) status.textContent = "请先填写并保存 Supabase 连接。";
    return false;
  }

  const table = encodeURIComponent(state.supabase.teamTable);
  const url = supabaseRestUrl(`${table}?select=team_number,data,updated_at&order=team_number.asc&limit=5000`);

  try {
    if (!silent && status) status.textContent = "正在从 Supabase 读取队伍数据…";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      throw new Error(`Supabase HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data)
      ? data.map((record) => record?.data).filter((row) => row && typeof row === "object" && !Array.isArray(row))
      : [];
    if (!rows.length) {
      if (!silent && status) status.textContent = "Supabase 队伍数据为空。";
      return false;
    }
    const cols = mergeColumns(rows);
    setModel({ rows, cols });
    state.import.replaced = true;
    state.source = { kind: "supabase", label: state.supabase.teamTable };
    if (status) status.textContent = `已从 Supabase 读取队伍数据：${rows.length} 支队伍。`;
    onRoute();
    return true;
  } catch (e) {
    if (!silent && status) status.textContent = `读取队伍数据失败：${String(e?.message || e)}`;
    return loadTeamsFromAppSettings({ silent });
  }
}

async function loadTeamsFromLegacyDataset({ silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseDatasetConfig()) return false;

  const table = encodeURIComponent(state.supabase.datasetTable);
  const name = encodeURIComponent(state.supabase.datasetName);
  const url = supabaseRestUrl(`${table}?name=eq.${name}&select=cols,rows,updated_at&limit=1`);

  try {
    if (!silent && status) status.textContent = "正在读取旧版整表数据…";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    const data = await res.json();
    const dataset = data?.[0];
    if (!dataset) return false;
    const cols = Array.isArray(dataset.cols) ? dataset.cols : [];
    const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
    if (!cols.length || !rows.length) return false;
    setModel({ rows, cols });
    state.import.replaced = true;
    state.source = { kind: "supabase", label: state.supabase.datasetName };
    if (status) status.textContent = `已读取旧版队伍数据：${rows.length} 行。建议点“上传当前队伍数据”迁移为逐队存储。`;
    onRoute();
    return true;
  } catch {
    return loadTeamsFromAppSettings({ silent });
  }
}

async function loadTeamsFromAppSettings({ silent = false } = {}) {
  const status = $("#supabaseStatus");
  if (!hasSupabaseConfig()) return false;

  const table = encodeURIComponent(state.supabase.table);
  const keyName = "prescout_team_data";
  const url = supabaseRestUrl(`${table}?key=eq.${encodeURIComponent(keyName)}&select=value&limit=1`);

  try {
    if (!silent && status) status.textContent = "正在从 Supabase 读取队伍数据…";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    const data = await res.json();
    const raw = data?.[0]?.value;
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const cols = Array.isArray(parsed?.cols) ? parsed.cols : mergeColumns(rows);
    if (!rows.length || !cols.length) return false;
    setModel({ rows, cols });
    state.import.replaced = true;
    state.source = { kind: "supabase", label: keyName };
    if (status) status.textContent = `已从 Supabase 读取队伍数据：${rows.length} 支队伍。`;
    onRoute();
    return true;
  } catch (e) {
    if (!silent && status) status.textContent = `读取队伍数据失败：${String(e?.message || e)}`;
    return false;
  }
}

async function saveStatboticsMatchesToSupabase(eventKey, matches) {
  if (!hasSupabaseConfig() || !state.supabase.statboticsTable || !Array.isArray(matches) || !matches.length) return false;
  const table = encodeURIComponent(state.supabase.statboticsTable);
  const url = supabaseRestUrl(table);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        event_key: eventKey,
        matches,
        updated_at: new Date().toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadStatboticsMatchesFromSupabase(eventKey) {
  if (!hasSupabaseConfig() || !state.supabase.statboticsTable) return null;
  const table = encodeURIComponent(state.supabase.statboticsTable);
  const key = encodeURIComponent(eventKey);
  const url = supabaseRestUrl(`${table}?event_key=eq.${key}&select=matches&limit=1`);
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const matches = data?.[0]?.matches;
    return Array.isArray(matches) ? matches : null;
  } catch {
    return null;
  }
}

async function loadStatboticsMatch(matchKey) {
  const key = normalizeId(matchKey);
  if (!key) return null;
  const cached = state.schedule.statbotics.get(key);
  if (cached) return cached;

  const res = await fetch(`https://api.statbotics.io/v3/match/${encodeURIComponent(key)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Statbotics HTTP ${res.status}`);
  const data = await res.json();
  state.schedule.statbotics.set(key, data);
  return data;
}

async function loadStatboticsTeam(teamNumber) {
  const team = String(teamNumber || "").trim();
  if (!team) return null;
  const cached = state.schedule.statboticsTeams.get(team);
  if (cached) return cached;
  const res = await fetch(`https://api.statbotics.io/v3/team/${encodeURIComponent(team)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Statbotics HTTP ${res.status}`);
  const data = await res.json();
  state.schedule.statboticsTeams.set(team, data);
  return data;
}

function pickQualRank(status) {
  const rank =
    status?.qual?.ranking?.rank ??
    status?.qual?.ranking?.ranking ??
    status?.qual?.rank ??
    status?.qual_rank ??
    status?.ranking?.rank ??
    null;
  return Number.isFinite(Number(rank)) ? Number(rank) : null;
}

function pickPlayoffResult(status) {
  const playoff = status?.playoff;
  if (!playoff) return null;

  const level = String(playoff?.level || "").toLowerCase(); // f/sf/qf/ef...
  const st = String(playoff?.status || "").toLowerCase(); // won/eliminated/...

  if (level === "f") {
    if (st === "won") return "冠军";
    if (st === "eliminated") return "亚军";
    return "决赛";
  }
  if (level === "sf") return "四强";
  if (level === "qf") return "八强";
  if (level === "ef") return "十六强";
  if (level === "of") return "三十二强";

  // fallback: if they have a playoff object but unknown encoding
  return "季后赛";
}

function teamKeyToNumber(teamKey) {
  return String(teamKey || "").replace(/^frc/i, "");
}

function matchSortValue(match) {
  const order = { qm: 1, ef: 2, qf: 3, sf: 4, f: 5 };
  const level = order[String(match?.comp_level || "").toLowerCase()] || 99;
  return level * 100000 + (Number(match?.set_number) || 0) * 1000 + (Number(match?.match_number) || 0);
}

function matchLabel(match) {
  const level = String(match?.comp_level || "").toLowerCase();
  const num = Number(match?.match_number) || "";
  const set = Number(match?.set_number) || "";
  if (level === "qm") return `资格赛 ${num}`;
  if (level === "ef") return `十六强 ${set}-${num}`;
  if (level === "qf") return `八强 ${set}-${num}`;
  if (level === "sf") return `四强 ${set}-${num}`;
  if (level === "f") return `决赛 ${num}`;
  return `${level || "比赛"} ${num}`;
}

function allianceRows(teamKeys) {
  return [0, 1, 2].map((i) => teamKeyToNumber(teamKeys?.[i] || ""));
}

function teamEpa(teamNumber) {
  const row = getTeamRow(teamNumber);
  const raw = row?.EPA ?? row?.epa ?? row?.Epa;
  const epa = safeParseNumber(raw);
  return epa == null ? null : epa;
}

function teamEpaFromStatbotics(teamNumber) {
  const team = String(teamNumber || "").trim();
  const t = state.schedule.statboticsTeams.get(team);
  const epa = safeParseNumber(t?.norm_epa?.current ?? t?.norm_epa?.recent ?? t?.epa_end ?? t?.epa);
  return epa == null ? null : epa;
}

function allianceEpaTotal(teams) {
  const values = teams.map(teamEpa).filter((v) => v != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function formatEpa(epa) {
  return epa == null ? "-" : formatNumber(epa);
}

function formatTeamWithEpa(teamNumber) {
  if (!teamNumber) return "—";
  const local = teamEpa(teamNumber);
  const sb = teamEpaFromStatbotics(teamNumber);
  const epa = local ?? sb;
  const suffix = local != null ? "" : sb != null ? " (SB)" : "";
  const epaText = `EPA ${escapeHtml(formatEpa(epa))}${escapeHtml(suffix)}`;
  return `<a href="#team=${encodeURIComponent(teamNumber)}">${escapeHtml(teamNumber)}</a><span class="schedule-epa">${epaText}</span>`;
}

function predictionForMatch(red, blue) {
  const redTotal = allianceEpaTotal(red);
  const blueTotal = allianceEpaTotal(blue);
  if (redTotal == null || blueTotal == null || redTotal + blueTotal <= 0) {
    return { redTotal, blueTotal, redWin: 50, blueWin: 50 };
  }
  const redWin = Math.round((redTotal / (redTotal + blueTotal)) * 100);
  return { redTotal, blueTotal, redWin, blueWin: 100 - redWin };
}

function normalizeId(v) {
  return String(v || "").trim().toLowerCase();
}

function compositeMatchIds({ eventKey, compLevel, setNumber, matchNumber }) {
  const ek = normalizeId(eventKey);
  const cl = normalizeId(compLevel);
  const sn = Number(setNumber) || 0;
  const mn = Number(matchNumber) || 0;
  if (!ek || !cl || !mn) return [];
  // Common encodings seen in TBA/Statbotics:
  // - 2024cur_qm1
  // - 2024cur_qm1m1 (set+match)
  // - 2024cur_qm1m2 (set+match)
  // - 2024cur_qm1-1 (rare)
  return [
    `${ek}_${cl}${mn}`,
    `${ek}_${cl}${sn}m${mn}`,
    `${ek}_${cl}${sn}-${mn}`,
    `${ek}_${cl}${sn}_${mn}`,
  ];
}

function compositeMatchKey({ eventKey, compLevel, setNumber, matchNumber }) {
  const ek = normalizeId(eventKey);
  const cl = normalizeId(compLevel);
  const sn = Number(setNumber) || 0;
  const mn = Number(matchNumber) || 0;
  if (!ek || !cl || !mn) return "";
  // This matches Statbotics match `key` format.
  // Examples:
  // - 2019cur_qm1
  // - 2019cmptx_f1m3
  if (cl === "qm") return `${ek}_${cl}${mn}`;
  return `${ek}_${cl}${sn}m${mn}`;
}

function extractStatboticsIds(match) {
  const ids = new Set();
  const add = (v) => {
    const id = normalizeId(v);
    if (id) ids.add(id);
  };

  add(match?.match_id);
  add(match?.key);
  add(match?.id);

  // Also index composite ids.
  for (const cid of compositeMatchIds({
    eventKey: match?.event_key || match?.event || match?.eventKey,
    compLevel: match?.comp_level || match?.compLevel,
    setNumber: match?.set_number || match?.setNumber,
    matchNumber: match?.match_number || match?.matchNumber,
  })) {
    add(cid);
  }

  // And a stable composite key by components (more reliable than match_id formats).
  add(compositeMatchKey({
    eventKey: match?.event_key || match?.event || match?.eventKey,
    compLevel: match?.comp_level || match?.compLevel,
    setNumber: match?.set_number || match?.setNumber,
    matchNumber: match?.match_number || match?.matchNumber,
  }));

  return [...ids];
}

function extractTbaIds(match) {
  const ids = new Set();
  const add = (v) => {
    const id = normalizeId(v);
    if (id) ids.add(id);
  };
  add(match?.key);
  for (const cid of compositeMatchIds({
    eventKey: match?.event_key,
    compLevel: match?.comp_level,
    setNumber: match?.set_number,
    matchNumber: match?.match_number,
  })) {
    add(cid);
  }
  add(compositeMatchKey({
    eventKey: match?.event_key,
    compLevel: match?.comp_level,
    setNumber: match?.set_number,
    matchNumber: match?.match_number,
  }));
  return [...ids];
}

function indexStatboticsMatches(matches) {
  const map = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    for (const id of extractStatboticsIds(match)) map.set(id, match);
  }
  return map;
}

function statboticsPredictionForMatch(match, red, blue) {
  const key = compositeMatchKey({
    eventKey: match?.event_key,
    compLevel: match?.comp_level,
    setNumber: match?.set_number,
    matchNumber: match?.match_number,
  });
  const statMatch = key ? state.schedule.statbotics.get(normalizeId(key)) : null;
  if (!statMatch) return predictionForMatch(red, blue);

  const redWinRaw = statMatch?.pred?.red_win_prob ?? statMatch?.pred?.redWinProb ?? statMatch?.red_win_prob ?? statMatch?.redWinProb;
  const redScoreRaw = statMatch?.pred?.red_score ?? statMatch?.pred?.redScore ?? statMatch?.pred?.red_score_predicted ?? statMatch?.pred?.redScorePredicted;
  const blueScoreRaw = statMatch?.pred?.blue_score ?? statMatch?.pred?.blueScore ?? statMatch?.pred?.blue_score_predicted ?? statMatch?.pred?.blueScorePredicted;

  const redWinNumber = safeParseNumber(redWinRaw);
  const redScore = safeParseNumber(redScoreRaw);
  const blueScore = safeParseNumber(blueScoreRaw);
  const fallback = predictionForMatch(red, blue);
  const redWin = redWinNumber == null ? fallback.redWin : Math.round(redWinNumber <= 1 ? redWinNumber * 100 : redWinNumber);

  return {
    redTotal: redScore ?? fallback.redTotal,
    blueTotal: blueScore ?? fallback.blueTotal,
    redWin: Math.max(0, Math.min(100, redWin)),
    blueWin: Math.max(0, Math.min(100, 100 - redWin)),
    source: "Statbotics",
  };
}

function matchTeams(match) {
  return [
    ...allianceRows(match?.alliances?.red?.team_keys),
    ...allianceRows(match?.alliances?.blue?.team_keys),
  ].filter(Boolean);
}

function matchHasTeam(match, teamNumber) {
  const target = String(teamNumber || "").trim();
  if (!target) return true;
  return matchTeams(match).some((team) => team === target);
}

function renderScheduleMatches() {
  const panel = $("#schedulePanel");
  const event = state.schedule.event;
  const filter = String($("#scheduleTeamFilter")?.value || "").trim();
  if (!panel) return;

  const filtered = state.schedule.matches.filter((match) => matchHasTeam(match, filter));
  if (!state.schedule.matches.length) {
    panel.innerHTML = `<div class="pane"><div class="muted">这场比赛暂时没有赛程数据。</div></div>`;
    return;
  }
  if (!filtered.length) {
    panel.innerHTML = `<div class="pane"><div class="pane-title">${escapeHtml(event?.name || "赛程")}</div><div class="muted">没有找到队伍 ${escapeHtml(filter)} 的比赛。</div></div>`;
    return;
  }

  const hasEpaCol = state.cols.includes("EPA") || state.cols.includes("epa") || state.cols.includes("Epa");
  const noEpaHint = hasEpaCol ? "" : `<div class="muted" style="margin-top:6px">提示：当前未载入队伍 EPA 数据（先导入/从 Supabase 读取队伍数据），队号后 EPA 会显示为 -。</div>`;

  const rows = filtered.map((match) => {
    const red = allianceRows(match?.alliances?.red?.team_keys);
    const blue = allianceRows(match?.alliances?.blue?.team_keys);
    const time = match?.time ? new Date(Number(match.time) * 1000).toLocaleString() : "";
    const prediction = statboticsPredictionForMatch(match, red, blue);
    const summaryRed = red.filter(Boolean).map(escapeHtml).join(", ") || "—";
    const summaryBlue = blue.filter(Boolean).map(escapeHtml).join(", ") || "—";
    const expandedRows = red.map((r, i) => {
      const b = blue[i] || "";
      const middle = i === 1 ? `<div class="schedule-vs">vs</div>` : `<div></div>`;
      const redTeam = formatTeamWithEpa(r);
      const blueTeam = formatTeamWithEpa(b);
      return `<div class="schedule-row"><div class="schedule-red">${redTeam}</div>${middle}<div class="schedule-blue">${blueTeam}</div></div>`;
    }).join("");

    const actualScore =
      match?.alliances?.red?.score != null && match?.alliances?.blue?.score != null
        ? `<div class="schedule-actual">实际比分：${escapeHtml(match.alliances.red.score)} - ${escapeHtml(match.alliances.blue.score)}</div>`
        : "";

    const src = prediction?.source === "Statbotics" ? `<span class="schedule-badge">SB</span>` : "";
    return `<details class="schedule-match">
      <summary>
        <span class="schedule-match-label">${escapeHtml(matchLabel(match))}</span>
        <span class="schedule-summary-teams">${src}<b>${summaryRed}</b> <em>vs</em> <b>${summaryBlue}</b></span>
        <span class="schedule-summary-time">${escapeHtml(time)}</span>
      </summary>
      <div class="schedule-detail">
        <div class="schedule-detail-grid">
          <div class="schedule-alliance-lines">
            ${expandedRows}
          </div>
          <div class="schedule-predict">
            <div class="schedule-scoreline">
              <span>预测分：${escapeHtml(formatEpa(prediction.redTotal))}</span>
              <b>${escapeHtml(String(prediction.redWin))}%</b>
              <span>${escapeHtml(formatEpa(prediction.blueTotal))}：预测分</span>
            </div>
            <div class="schedule-prob">
              <div class="schedule-prob-red" style="width:${prediction.redWin}%"></div>
              <div class="schedule-prob-blue" style="width:${prediction.blueWin}%"></div>
            </div>
            <div class="schedule-scoreline muted">
              <span>红方胜率</span>
              <span></span>
              <span>蓝方胜率 ${escapeHtml(String(prediction.blueWin))}%</span>
            </div>
            ${actualScore}
          </div>
        </div>
      </div>
    </details>`;
  }).join("");

  const countLabel = filter ? `（队伍 ${escapeHtml(filter)}：${filtered.length}/${state.schedule.matches.length} 场）` : `（${filtered.length} 场）`;
  const sourceLabel = state.schedule.statboticsSource ? `<span class="schedule-source">预测来源：${escapeHtml(state.schedule.statboticsSource)}</span>` : "";
  panel.innerHTML = `<div class="pane">
    <div class="pane-title">${escapeHtml(event?.name || "赛程")} 赛程 ${countLabel} ${sourceLabel}</div>
    ${noEpaHint}
    <div class="schedule-list">${rows}</div>
  </div>`;
}

async function loadTbaEventsForSchedule() {
  const panel = $("#schedulePanel");
  const select = $("#scheduleEvent");
  const button = $("#btnLoadSchedule");
  if (!panel || !select || !button) return;

  const year = Number(($("#scheduleYear")?.value || "").trim());
  if (!Number.isFinite(year) || year < 1992) {
    panel.innerHTML = `<div class="pane"><div class="muted">年份不正确。</div></div>`;
    return;
  }
  if (!hasTbaAccess()) {
    panel.innerHTML = `<div class="pane"><div class="muted">请先在“导入”页填入 TBA Read API Key，或填写 TBA 本地代理地址。</div></div>`;
    return;
  }

  panel.innerHTML = `<div class="pane"><div class="muted">正在加载 ${year} 年比赛列表…</div></div>`;
  select.disabled = true;
  button.disabled = true;
  select.innerHTML = `<option value="">加载中…</option>`;

  try {
    const events = await tbaFetchJson(`/events/${year}/simple`);
    state.schedule.events = Array.isArray(events) ? events : [];
    state.schedule.events.sort((a, b) => {
      const aStart = String(a?.start_date || "");
      const bStart = String(b?.start_date || "");
      if (aStart !== bStart) return aStart.localeCompare(bStart);
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    });

    if (!state.schedule.events.length) {
      select.innerHTML = `<option value="">没有找到比赛</option>`;
      panel.innerHTML = `<div class="pane"><div class="muted">${year} 年没有可用比赛。</div></div>`;
      return;
    }

    select.innerHTML = `<option value="">选择一场比赛</option>` + state.schedule.events
      .map((event) => {
        const date = event.start_date ? `${event.start_date} · ` : "";
        const label = `${date}${event.name || event.key}`;
        return `<option value="${escapeHtml(event.key)}">${escapeHtml(label)}</option>`;
      })
      .join("");
    select.disabled = false;
    panel.innerHTML = `<div class="pane"><div class="muted">已加载 ${state.schedule.events.length} 场比赛，选择一场后点击“显示赛程”。</div></div>`;
  } catch (e) {
    select.innerHTML = `<option value="">加载失败</option>`;
    panel.innerHTML = `<div class="pane"><div class="muted">加载失败：${escapeHtml(String(e?.message || e))}</div></div>`;
  }
}

async function loadTbaEventSchedule() {
  const panel = $("#schedulePanel");
  const eventKey = ($("#scheduleEvent")?.value || "").trim();
  if (!panel) return;
  if (!eventKey) {
    panel.innerHTML = `<div class="pane"><div class="muted">请先选择一场比赛。</div></div>`;
    return;
  }
  if (!hasTbaAccess()) {
    panel.innerHTML = `<div class="pane"><div class="muted">请先在“导入”页填入 TBA Read API Key，或填写 TBA 本地代理地址。</div></div>`;
    return;
  }

  const event = state.schedule.events.find((e) => e.key === eventKey);
  panel.innerHTML = `<div class="pane"><div class="muted">正在加载赛程…</div></div>`;

  try {
    const matches = await tbaFetchJson(`/event/${eventKey}/matches/simple`);
    const sorted = (Array.isArray(matches) ? matches : []).slice().sort((a, b) => matchSortValue(a) - matchSortValue(b));
    if (!sorted.length) {
      state.schedule.event = event || null;
      state.schedule.matches = [];
      state.schedule.statbotics = new Map();
      panel.innerHTML = `<div class="pane"><div class="muted">这场比赛暂时没有赛程数据。</div></div>`;
      return;
    }

    state.schedule.event = event || { key: eventKey, name: eventKey };
    state.schedule.matches = sorted;
    state.schedule.statbotics = new Map();
    state.schedule.statboticsSource = "Statbotics";

    // Prefetch Statbotics match predictions by match key.
    panel.innerHTML = `<div class="pane"><div class="muted">正在加载赛程 + Statbotics 预测…</div></div>`;
    for (const m of sorted) {
      const key = compositeMatchKey({
        eventKey: m?.event_key,
        compLevel: m?.comp_level,
        setNumber: m?.set_number,
        matchNumber: m?.match_number,
      });
      if (!key) continue;
      try {
        await loadStatboticsMatch(key);
      } catch {
        // ignore per-match failures; render will fallback
      }
    }

    // If local EPA isn't loaded, try to fetch team EPA from Statbotics (best-effort).
    const teams = new Set();
    for (const m of sorted) for (const t of matchTeams(m)) teams.add(t);
    if (!state.cols.includes("EPA")) {
      for (const t of teams) {
        try {
          await loadStatboticsTeam(t);
        } catch {
          // ignore
        }
      }
    }
    renderScheduleMatches();
  } catch (e) {
    panel.innerHTML = `<div class="pane"><div class="muted">加载失败：${escapeHtml(String(e?.message || e))}</div></div>`;
  }
}

async function loadTbaQualRanks(teamNumber) {
  const out = $("#tbaResults");
  if (!out) return;

  const year = Number(($("#tbaYear")?.value || "").trim());
  if (!Number.isFinite(year) || year < 1992) {
    out.textContent = "年份不正确。";
    return;
  }
  if (!hasTbaAccess()) {
    out.textContent = "请先在“导入”页填入 TBA Read API Key，或填写 TBA 本地代理地址。";
    return;
  }

  out.textContent = "查询中…";
  try {
    const teamKey = `frc${teamNumber}`;
    const events = await tbaFetchJson(`/team/${teamKey}/events/${year}/simple`);
    if (!Array.isArray(events) || !events.length) {
      out.textContent = `该队在 ${year} 没有赛事记录（或 TBA 暂无数据）。`;
      return;
    }

    const results = [];
    for (const ev of events) {
      const key = ev?.key;
      if (!key) continue;
      let qualRank = null;
      let playoff = null;
      try {
        const status = await tbaFetchJson(`/team/${teamKey}/event/${key}/status`);
        qualRank = pickQualRank(status);
        playoff = pickPlayoffResult(status);
      } catch {
        // ignore per-event failures
      }
      results.push({
        key,
        name: ev?.short_name || ev?.name || key,
        qualRank,
        playoff,
      });
    }

    results.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    out.innerHTML = results
      .map((r) => {
        const q = r.qualRank != null ? `资格赛：<b>${escapeHtml(String(r.qualRank))}</b>` : `资格赛：<b>—</b>`;
        const p = r.playoff ? `，淘汰赛：<b>${escapeHtml(String(r.playoff))}</b>` : "";
        return `<div>${escapeHtml(r.name)}：${q}${p}</div>`;
      })
      .join("");
  } catch (e) {
    out.textContent =
      `查询失败：${String(e?.message || e)}。` +
      `如果提示 CORS，被浏览器拦截了：请在“导入”页填写 TBA 本地代理地址（运行仓库内 tba-proxy.mjs）。`;
  }
}

function renderCompareChips() {
  const wrap = $("#compareChips");
  wrap.innerHTML = "";
  for (const t of state.compare) {
    wrap.append(
      el("span", { class: "chip" }, [
        el("span", { html: `队伍 <b>${escapeHtml(t)}</b>` }),
        el("button", { title: "移除", onclick: () => removeCompare(t) }, [document.createTextNode("×")]),
      ])
    );
  }
  if (!state.compare.size) {
    wrap.append(el("div", { class: "muted", html: "添加 2-4 支队伍开始对比。" }));
  }
}

function renderComparePanel() {
  const panel = $("#comparePanel");
  panel.innerHTML = "";
  const teams = [...state.compare];
  if (teams.length < 2) {
    panel.append(el("div", { class: "pane", html: `<div class="muted">至少选择 2 支队伍进行对比。</div>` }));
    return;
  }

  const metricCols =
    (state.config.preferredMetricColumns || []).filter((c) => state.numericCols.includes(c)) ||
    [];
  const cols = metricCols.length ? metricCols : state.numericCols.slice(0, 10);

  // Compare table
  const t = el("table", { class: "table" });
  const thead = el("thead");
  const trh = el("tr");
  trh.append(el("th", { html: "指标" }));
  for (const team of teams) trh.append(el("th", { html: `#${escapeHtml(team)}` }));
  thead.append(trh);

  const tbody = el("tbody");
  for (const c of cols) {
    const tr = el("tr");
    tr.append(el("td", { html: escapeHtml(c) }));
    for (const team of teams) {
      const row = getTeamRow(team);
      const v = row ? row[c] : "";
      const nums = teams.map((t) => safeParseNumber(getTeamRow(t)?.[c])).filter((n) => n != null);
      const best = nums.length ? Math.max(...nums) : null;
      const isBest = best != null && safeParseNumber(v) === best;
      tr.append(el("td", { class: isBest ? "best-cell" : "", html: escapeHtml(v) }));
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);

  // Score pane
  const scoreBars = el("div", { class: "bars" });
  const entries = teams
    .map((team) => [team, state.stats.score.get(team) ?? 0])
    .sort((a, b) => b[1] - a[1]);
  const maxScore = Math.max(...entries.map(([, s]) => Number(s) || 0), 1);
  for (const [team, sc] of entries) {
    const pct = Math.round(((Number(sc) || 0) / maxScore) * 100);
    scoreBars.append(
      el("div", { class: "bar" }, [
        el("div", { class: "bar-label", html: `综合评分 #${escapeHtml(team)}` }),
        el("div", { class: "bar-track" }, [el("div", { class: "bar-fill", style: `width:${pct}%` })]),
        el("div", { class: "bar-val", html: escapeHtml(String(sc)) }),
      ])
    );
  }

  panel.append(
    el("div", { class: "pane" }, [el("div", { class: "pane-title", html: "对比总表" }), el("div", { class: "scroll" }, [t])]),
    el("div", { class: "pane" }, [el("div", { class: "pane-title", html: "综合评分对比" }), scoreBars])
  );
}

async function loadConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`config.json HTTP ${res.status}`);
    const cfg = await res.json();
    state.config = {
      ...DEFAULT_CONFIG,
      ...cfg,
      tba: { ...DEFAULT_CONFIG.tba, ...(cfg.tba || {}) },
      supabase: { ...DEFAULT_CONFIG.supabase, ...(cfg.supabase || {}) },
      ui: { ...DEFAULT_CONFIG.ui, ...(cfg.ui || {}) },
    };
  } catch {
    state.config = DEFAULT_CONFIG;
  }
  $("#configPreview").textContent = JSON.stringify(state.config, null, 2);
}

function rowsFromGrid(grid) {
  if (!grid.length) return { rows: [], cols: [] };
  const header = grid[0].map((h) => String(h ?? "").trim());
  const cols = header.filter(Boolean);
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const rr = {};
    const r = grid[i];
    if (!r || !r.length) continue;
    for (let j = 0; j < cols.length; j++) rr[cols[j]] = r[j] ?? "";
    // Skip empty rows
    if (Object.values(rr).every((v) => String(v ?? "").trim() === "")) continue;
    rows.push(rr);
  }
  return { rows, cols };
}

function mergeColumns(rows) {
  const cols = [];
  const seen = new Set();
  for (const row of rows) {
    for (const col of Object.keys(row || {})) {
      if (!seen.has(col)) {
        seen.add(col);
        cols.push(col);
      }
    }
  }

  const teamCol = pickTeamColumn(cols, state.config.teamIdColumnCandidates || DEFAULT_CONFIG.teamIdColumnCandidates);
  if (teamCol) {
    return [teamCol, ...cols.filter((col) => col !== teamCol)];
  }
  return cols;
}

async function loadDataFromPath() {
  const path = state.config.dataPath || DEFAULT_CONFIG.dataPath;
  state.source = { kind: "path", label: path };
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`data HTTP ${res.status}: ${path}`);
  const text = await res.text();
  const grid = parseCSV(text, detectDelimiter(text));
  return rowsFromGrid(grid);
}

async function loadSamplePreview() {
  try {
    const res = await fetch("./data/prescout.sample.csv", { cache: "no-store" });
    if (!res.ok) return;
    const text = await res.text();
    $("#samplePreview").textContent = text.trim();
  } catch {
    // ignore
  }
}

function setModel({ rows, cols }) {
  state.rows = rows;
  state.cols = cols;
  state.teamCol = pickTeamColumn(cols, state.config.teamIdColumnCandidates || DEFAULT_CONFIG.teamIdColumnCandidates);
  state.numericCols = inferNumericColumns(rows, cols).filter((c) => c !== state.teamCol);
  computeStats();
  state.table.sortCol = "Rank";
  state.table.sortDir = "asc";
  updateRankModeButton();
  updateSupabaseTeamUploadButton();
}

function clearModel() {
  state.rows = [];
  state.cols = [];
  state.teamCol = null;
  state.numericCols = [];
  state.stats.min.clear();
  state.stats.max.clear();
  state.stats.score.clear();
  state.stats.rank.clear();
  state.stats.epaRank.clear();
  state.stats.tierRank.clear();
  updateSupabaseTeamUploadButton();
}

function wireUI() {
  $("#tableSearch").addEventListener("input", (e) => {
    state.table.query = e.target.value || "";
    renderTable();
  });
  $("#rankMode").addEventListener("click", () => {
    state.table.rankMode = state.table.rankMode === "epa" ? "tier" : "epa";
    updateActiveRank();
    state.table.sortCol = "Rank";
    state.table.sortDir = "asc";
    updateRankModeButton();
    onRoute();
  });
  $("#btnReload").addEventListener("click", async () => {
    // In import-only mode, treat reload as clearing the current session data.
    clearModel();
    state.import.replaced = false;
    showStatus("已清空当前数据。请到“导入”页重新粘贴/导入。");
    onRoute();
  });
  $("#btnVizToggle")?.addEventListener("click", () => {
    state.viz.mode = state.viz.mode === "scatter" ? "dist" : "scatter";
    updateVizToggleButton();
    renderViz();
  });
  $("#scheduleYear")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btnLoadEvents")?.click();
  });
  $("#btnLoadEvents")?.addEventListener("click", loadTbaEventsForSchedule);
  $("#scheduleEvent")?.addEventListener("change", (e) => {
    $("#btnLoadSchedule").disabled = !String(e.target.value || "").trim();
    state.schedule.matches = [];
    state.schedule.event = null;
    state.schedule.statbotics = new Map();
    state.schedule.statboticsSource = "";
  });
  $("#btnLoadSchedule")?.addEventListener("click", loadTbaEventSchedule);
  $("#scheduleTeamFilter")?.addEventListener("input", () => {
    if (state.schedule.matches.length) renderScheduleMatches();
  });
  $("#btnGoTeam").addEventListener("click", () => {
    const team = ($("#teamQuery").value || "").trim();
    location.hash = `#team=${encodeURIComponent(team)}`;
  });
  $("#teamQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btnGoTeam").click();
  });

  $("#compareAdd").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const team = (e.target.value || "").trim();
    e.target.value = "";
    addCompare(team);
    location.hash = `#compare=${encodeURIComponent([...state.compare].join(","))}`;
  });
  $("#btnClearCompare").addEventListener("click", () => {
    state.compare.clear();
    renderCompareChips();
    renderComparePanel();
    location.hash = "#compare";
  });
  $("#btnShareLink").addEventListener("click", async () => {
    const hash = `#compare=${encodeURIComponent([...state.compare].join(","))}`;
    const url = `${location.origin}${location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      showStatus("已复制对比链接到剪贴板。");
      setTimeout(() => showStatus(""), 1200);
    } catch {
      showStatus("复制失败：浏览器不允许剪贴板。你可以手动复制地址栏链接。");
    }
  });

  $("#btnPasteClipboard").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      $("#clipboardCsv").value = text || "";
      showStatus(text ? "已从剪贴板粘贴 CSV。" : "剪贴板为空。");
      setTimeout(() => showStatus(""), 1200);
    } catch {
      showStatus("读取剪贴板失败：浏览器不允许。请手动粘贴到文本框。");
    }
  });

  $("#btnLoadClipboard").addEventListener("click", async () => {
    const text = ($("#clipboardCsv").value || "").trim();
    if (!text) {
      showStatus("请先粘贴 CSV 内容。");
      return;
    }
    const grid = parseCSV(text, detectDelimiter(text));
    const model = rowsFromGrid(grid);
    setModel(model);
    state.import.replaced = true;
    showStatus(`已从剪贴板载入（${model.rows.length} 行）。如需同步到 Supabase，请点击“上传当前队伍数据”。`);
    onRoute();
  });

  $("#fileInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const grid = parseCSV(text, detectDelimiter(text));
    const model = rowsFromGrid(grid);
    setModel(model);
    state.import.replaced = true;
    showStatus(`已从 CSV 文件载入：${f.name}（${model.rows.length} 行）。如需同步到 Supabase，请点击“上传当前队伍数据”。`);
    onRoute();
  });

  $("#tbaKey")?.addEventListener("input", (e) => {
    state.tba.key = String(e.target.value || "").trim();
    state.tba.cache.clear();
    updateTbaKeyUi();
    try {
      if (state.tba.key) localStorage.setItem(LS_TBA_KEY, state.tba.key);
      else localStorage.removeItem(LS_TBA_KEY);
    } catch {
      // ignore
    }
  });

  $("#tbaProxy")?.addEventListener("input", (e) => {
    state.tba.proxyBase = String(e.target.value || "").trim();
    state.tba.cache.clear();
  });

  $("#btnClearTbaKey")?.addEventListener("click", () => {
    state.tba.key = "";
    state.tba.cache.clear();
    const input = $("#tbaKey");
    if (input) input.value = "";
    try {
      localStorage.removeItem(LS_TBA_KEY);
    } catch {
      // ignore
    }
    updateTbaKeyUi();
    showStatus("已清除已保存的 TBA Key");
    setTimeout(() => showStatus(""), 1200);
  });

  $("#btnSaveSupabase")?.addEventListener("click", () => {
    setSupabaseConfig(supabaseConfigFromInputs());
    saveSupabaseConfigToLocalStorage();
    updateSupabaseUi();
    showStatus("已保存 Supabase 连接到本机浏览器。");
    setTimeout(() => showStatus(""), 1200);
  });

  $("#btnLoadTbaFromSupabase")?.addEventListener("click", () => {
    setSupabaseConfig(supabaseConfigFromInputs());
    saveSupabaseConfigToLocalStorage();
    updateSupabaseUi();
    loadTbaKeyFromSupabase();
  });

  $("#btnSaveTbaToSupabase")?.addEventListener("click", () => {
    setSupabaseConfig(supabaseConfigFromInputs());
    saveSupabaseConfigToLocalStorage();
    updateSupabaseUi();
    saveTbaKeyToSupabase();
  });

  $("#btnSaveTeamsToSupabase")?.addEventListener("click", () => {
    setSupabaseConfig(supabaseConfigFromInputs());
    saveSupabaseConfigToLocalStorage();
    updateSupabaseUi();
    saveTeamsToSupabase();
  });

  $("#btnLoadTeamsFromSupabase")?.addEventListener("click", () => {
    setSupabaseConfig(supabaseConfigFromInputs());
    saveSupabaseConfigToLocalStorage();
    updateSupabaseUi();
    loadTeamsFromSupabase();
  });

  window.addEventListener("hashchange", onRoute);
}

function updateRankModeButton() {
  const button = $("#rankMode");
  if (!button) return;
  button.textContent = state.table.rankMode === "tier" ? "Tier Rank" : "EPA Rank";
}

function updateVizToggleButton() {
  const button = $("#btnVizToggle");
  if (!button) return;
  button.textContent = state.viz.mode === "dist" ? "切换到 Dot Graph" : "切换到 Tier 分布";
}

function updateSupabaseTeamUploadButton() {
  const button = $("#btnSaveTeamsToSupabase");
  if (!button) return;
  button.disabled = !state.rows.length || !state.teamCol;
}

function onRoute() {
  const r = parseHash();
  showView(r.view);

  $("#viewTable").hidden = false; // ensure sections exist for render calls below
  $("#viewOverview").hidden = false;
  $("#viewViz").hidden = false;
  $("#viewTeam").hidden = false;
  $("#viewSchedule").hidden = false;
  $("#viewCompare").hidden = false;
  $("#viewImport").hidden = false;

  // Apply compare list from URL if provided
  if (r.view === "compare") {
    state.compare.clear();
    for (const t of r.compare) addCompare(t);
  }

  // Import mode: hide existing data until user loads new content.
  if (r.view === "import") {
    // Hide any currently loaded data while testing imports.
    if (!state.import.replaced && state.rows.length) {
      if (!state.import.backup) state.import.backup = { rows: state.rows, cols: state.cols };
      state.import.active = true;
      clearModel();
      showStatus("已进入导入模式：旧数据已暂时隐藏。粘贴/导入后会立即更新本页数据（不写入磁盘）。");
    } else {
      state.import.active = true;
    }
  }

  if (r.view === "overview") {
    renderOverview();
  } else if (r.view === "table") {
    renderTable();
  } else if (r.view === "viz") {
    updateVizToggleButton();
    renderViz();
  } else if (r.view === "team") {
    if (r.team != null) $("#teamQuery").value = r.team;
    renderTeam(r.team);
  } else if (r.view === "schedule") {
    if (!$("#scheduleYear").value) $("#scheduleYear").value = String(new Date().getFullYear());
    if (!$("#schedulePanel").children.length) {
      $("#schedulePanel").innerHTML = `<div class="pane"><div class="muted">选择年份并加载比赛列表。</div></div>`;
    }
  } else if (r.view === "compare") {
    renderCompareChips();
    renderComparePanel();
  } else if (r.view === "import") {
    // just show previews
  }

  // Finally hide non-active views.
  showView(r.view);
}

async function boot({ force = false } = {}) {
  showStatus("");
  await loadConfig();
  await loadSamplePreview();

  // Load TBA proxy base from config (preferred) before touching localStorage key.
  state.tba.proxyBase = String(state.config?.tba?.proxyBase || "").trim();
  const bundledTbaKey = String(state.config?.tba?.key || "").trim();

  const storedSupabase = loadSupabaseConfigFromLocalStorage();
  const bundledSupabase = mergeSupabaseConfig(DEFAULT_CONFIG.supabase, state.config.supabase);
  setSupabaseConfig(mergeSupabaseConfig(bundledSupabase, storedSupabase));
  updateSupabaseUi();

  // Restore TBA key from localStorage (best-effort; not secure).
  try {
    const stored = localStorage.getItem(LS_TBA_KEY) || "";
    // If a proxy is configured, don't auto-load a local key unless user explicitly types one.
    state.tba.key = bundledTbaKey || (state.tba.proxyBase ? "" : stored.trim());
  } catch {
    // ignore
  }
  updateTbaKeyUi();
  if (hasSupabaseConfig()) await loadTbaKeyFromSupabase({ silent: true });

  // Do not auto-load on startup: only show the current pasted/imported dataset.
  clearModel();
  state.source = { kind: "import", label: "未导入" };
  $("#viewTable").hidden = false;
  $("#viewOverview").hidden = false;
  $("#viewTeam").hidden = false;
  $("#viewSchedule").hidden = false;
  $("#viewCompare").hidden = false;
  $("#viewImport").hidden = false;
  showStatus("未载入数据：请到“导入”页粘贴表格或导入 CSV（本次浏览器会话生效）。");
  if (hasSupabaseDatasetConfig()) await loadTeamsFromSupabase({ silent: true });

  if (force) {
    const r = parseHash();
    location.hash = `#${r.view}`;
  }
  onRoute();
}

wireUI();
boot();
