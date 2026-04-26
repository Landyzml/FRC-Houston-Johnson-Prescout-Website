// FRC Prescouting - zero-dependency static app (CSV -> table/team/compare).
// Designed for GitHub Pages: reads `config.json` and `data/prescout.csv` from same origin.

const DEFAULT_CONFIG = {
  dataPath: "./data/prescout.csv",
  sourceUrl: "",
  teamIdColumnCandidates: ["Team", "team", "队号", "队伍", "队伍编号", "Team Number", "TeamNumber"],
  preferredMetricColumns: [],
  maxCompareTeams: 4,
  topInsightCount: 3,
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
  stats: {
    min: new Map(),
    max: new Map(),
    score: new Map(), // teamId -> score 0..100
    rank: new Map(), // teamId -> 1..N
    epaRank: new Map(),
    tierRank: new Map(),
  },
  table: { sortCol: "Rank", sortDir: "asc", query: "", rankMode: "epa" },
  compare: new Set(),
};

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

// Minimal CSV parser with quote support.
function parseCSV(text) {
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
    if (ch === ",") {
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
  const fuzzy = normCols.find(([, n]) => n.includes("team") && n.includes("number"));
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
  if (["overview", "table", "import"].includes(view)) return { view, team: null, compare: [] };
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
  $("#viewTeam").hidden = viewId !== "team";
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
            html: `还没有真实数据。请从腾讯文档导出 CSV，覆盖 <code>data/prescout.csv</code>，然后刷新页面。`,
          }),
        ]),
      ])
    );
    return;
  }

  const q = (state.table.query || "").trim().toLowerCase();
  const dataCols = ["Team Name", "EPA", "Tier"].filter((c) => state.cols.includes(c));
  const showCols = [
    teamCol,
    ...dataCols,
    "Rank",
  ];

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
    const label = c === "Tier" ? "T" : c;
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
  const tier = String(row.Tier ?? row["排行（t0-4）"] ?? "").trim() || "-";
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

  const extraFieldLabels = {
    "Robot Type": "机器类型",
    Playstyle: "打法",
    "Robot Status": "机器状态",
    备注: "备注",
  };
  const extraFields = Object.keys(extraFieldLabels);
  const extraRows = extraFields
    .map((field) => [field, String(row[field] ?? "").trim()])
    .filter(([, value]) => value);

  const insightPane = el("div", { class: "pane" }, [
    el("div", { class: "pane-title", html: "其他数据" }),
    el("div", {
      class: "analysis-list",
      html: extraRows.length
        ? extraRows.map(([field, value]) => `<div><b>${escapeHtml(extraFieldLabels[field] || field)}：</b>${escapeHtml(value)}</div>`).join("")
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

  panel.append(statsPane, insightPane, analysisPane, rawPane);

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
    state.config = { ...DEFAULT_CONFIG, ...cfg, ui: { ...DEFAULT_CONFIG.ui, ...(cfg.ui || {}) } };
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

async function loadDataFromPath() {
  const path = state.config.dataPath || DEFAULT_CONFIG.dataPath;
  state.source = { kind: "path", label: path };
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`data HTTP ${res.status}: ${path}`);
  const text = await res.text();
  const grid = parseCSV(text);
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
    await boot({ force: true });
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

  $("#fileInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const grid = parseCSV(text);
    const model = rowsFromGrid(grid);
    setModel(model);
    showStatus(`已从上传文件载入：${f.name}（${model.rows.length} 行）`);
    // Re-render current view
    onRoute();
  });

  window.addEventListener("hashchange", onRoute);
}

function updateRankModeButton() {
  const button = $("#rankMode");
  if (!button) return;
  button.textContent = state.table.rankMode === "tier" ? "Tier Rank" : "EPA Rank";
}

function onRoute() {
  const r = parseHash();
  showView(r.view);

  $("#viewTable").hidden = false; // ensure sections exist for render calls below
  $("#viewOverview").hidden = false;
  $("#viewTeam").hidden = false;
  $("#viewCompare").hidden = false;
  $("#viewImport").hidden = false;

  // Apply compare list from URL if provided
  if (r.view === "compare") {
    state.compare.clear();
    for (const t of r.compare) addCompare(t);
  }

  if (r.view === "overview") {
    renderOverview();
  } else if (r.view === "table") {
    renderTable();
  } else if (r.view === "team") {
    if (r.team != null) $("#teamQuery").value = r.team;
    renderTeam(r.team);
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

  try {
    const model = await loadDataFromPath();
    setModel(model);
    $("#viewTable").hidden = false;
    $("#viewOverview").hidden = false;
    $("#viewTeam").hidden = false;
    $("#viewCompare").hidden = false;
    $("#viewImport").hidden = false;
    if (state.rows.length) {
      showStatus(`已加载：${state.source.label}（${state.rows.length} 行，队号列：${state.teamCol}）`);
    } else {
      showStatus(`已加载空模板：${state.source.label}。请从腾讯文档导出 CSV 后覆盖这个文件。`);
    }
  } catch (err) {
    // If opened via file://, fetch will often fail. Provide a clear hint.
    const hint =
      location.protocol === "file:"
        ? "你正在用 file:// 打开页面，浏览器会拦截 fetch。本地预览请用本地静态服务器（或直接部署到 GitHub Pages）。"
        : "请确认 `config.json` 的 dataPath 指向可访问的 CSV。";
    showStatus(`数据加载失败：${String(err?.message || err)}。${hint}`);
    // Still show import view so user can upload CSV.
    showView("import");
  }

  if (force) {
    const r = parseHash();
    location.hash = `#${r.view}`;
  }
  onRoute();
}

wireUI();
boot();
