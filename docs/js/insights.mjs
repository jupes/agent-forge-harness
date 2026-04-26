// Agent Forge Dashboard — Insights view.
// Chart.js + chartjs-chart-matrix are bundled (dynamic import) so the Vite dashboard
// runtime does not depend on third-party CDNs.

const COLOR_GREEN = "#3dff9c";
const COLOR_BLUE = "#6ec6ff";
const COLOR_YELLOW = "#ffe94d";
const COLOR_PINK = "#ff80d4";
const COLOR_AXIS = "#8aa4c8";
const COLOR_GRID = "rgba(138,164,200,0.14)";
const COLOR_TIP_BG = "#14203a";
const COLOR_TIP_BORDER = "#2a3a55";

/** @type {Promise<any> | null} */
let chartReady = null;
/** @type {Array<any>} */
let chartInstances = [];

function esc(s) {
  return String(s != null ? s : "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Lazy-load Chart.js + matrix plugin from the app bundle (Vite resolves bare specifiers).
 * @returns {Promise<any>}
 */
function ensureChartJs() {
  if (chartReady) return chartReady;
  chartReady = (async function () {
    const chartModule = await import("chart.js");
    const matrixModule = await import("chartjs-chart-matrix");
    const Chart = chartModule.Chart;
    Chart.register(
      ...chartModule.registerables,
      matrixModule.MatrixController,
      matrixModule.MatrixElement,
    );
    return Chart;
  })().catch(function (err) {
    chartReady = null;
    throw err;
  });
  return chartReady;
}

function dayKeyUTC(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function rangeDays(startKey, endKey) {
  const out = [];
  const start = new Date(startKey + "T00:00:00Z").getTime();
  const end = new Date(endKey + "T00:00:00Z").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function buildCounts(issues) {
  const list = Array.isArray(issues) ? issues : [];
  const closed = list.filter(function (i) {
    return i && i.status === "closed" && i.updatedAt;
  });
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const byType = new Map();
  closed.forEach(function (i) {
    const k = dayKeyUTC(i.updatedAt);
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + 1);
    const t = i.type || "other";
    let m = byType.get(k);
    if (!m) { m = new Map(); byType.set(k, m); }
    m.set(t, (m.get(t) || 0) + 1);
  });
  return { counts: counts, byType: byType, total: closed.length };
}

function buildDailySeries(counts, byType) {
  const keys = Array.from(counts.keys()).sort();
  if (!keys.length) return [];
  const days = rangeDays(keys[0], keys[keys.length - 1]);
  return days.map(function (k) {
    return { day: k, count: counts.get(k) || 0, byType: byType.get(k) || new Map() };
  });
}

/**
 * Stable-ordered list of issue types that actually appear in the data.
 * Known types first (in a friendly order), then any extras alphabetically.
 */
function typesPresent(byType) {
  const set = new Set();
  byType.forEach(function (m) {
    m.forEach(function (_n, t) { set.add(t); });
  });
  const known = ["task", "feature", "bug", "chore", "epic"];
  const ordered = [];
  known.forEach(function (t) {
    if (set.has(t)) { ordered.push(t); set.delete(t); }
  });
  Array.from(set).sort().forEach(function (t) { ordered.push(t); });
  return ordered;
}

const TYPE_COLORS = {
  task: "#6ec6ff",
  feature: "#3dff9c",
  bug: "#ff4757",
  chore: "#ffe94d",
  epic: "#ff80d4",
};
const TYPE_FALLBACK = ["#8aa4c8", "#9d7cff", "#c9ff7c", "#ff9d7c", "#7cffe0"];

function colorForType(type, fallbackIndex) {
  const known = /** @type {Record<string,string>} */ (TYPE_COLORS)[type];
  if (known) return known;
  return TYPE_FALLBACK[fallbackIndex % TYPE_FALLBACK.length];
}

/**
 * GitHub-style calendar grid: columns = ISO-weeks (oldest → today),
 * rows = weekday (0 = Sun … 6 = Sat). Anchored so the last column ends on today (UTC).
 */
function buildCalendarCells(counts, weeks) {
  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const totalDays = weeks * 7;
  const todayWeekday = new Date(todayUTC).getUTCDay();
  const padLeft = 6 - todayWeekday;
  const oldestUTC = todayUTC - (totalDays - 1 + (todayWeekday === 6 ? 0 : todayWeekday + 1)) * 86400000;
  const cells = [];
  let maxV = 0;
  let cursor = oldestUTC;
  const numCols = weeks + (padLeft > 0 ? 1 : 0);
  for (let col = 0; col < numCols; col++) {
    for (let row = 0; row < 7; row++) {
      if (cursor > todayUTC) break;
      const d = new Date(cursor);
      const key = d.toISOString().slice(0, 10);
      const weekday = d.getUTCDay();
      const v = counts.get(key) || 0;
      if (v > maxV) maxV = v;
      cells.push({ x: col, y: weekday, v: v, d: key });
      cursor += 86400000;
    }
    if (cursor > todayUTC) break;
  }
  return { cells: cells, maxV: maxV, numCols: numCols };
}

function summarize(series, counts, total) {
  const sevenAgoKey = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let last7 = 0;
  counts.forEach(function (v, k) {
    if (k > sevenAgoKey) last7 += v;
  });
  const avg = series.length ? total / series.length : 0;
  let best = { day: "", count: 0 };
  series.forEach(function (s) {
    if (s.count > best.count) best = s;
  });
  return { total: total, last7: last7, avg: avg, best: best, dayCount: series.length };
}

/**
 * @param {string} [filterHtml] Optional chrome (e.g. initiative dropdown) injected above the KPIs.
 */
export function renderInsightsHtml(filterHtml) {
  const chrome = filterHtml
    ? '<div class="filter-row" style="margin-bottom:1rem">' + filterHtml + "</div>"
    : "";
  return (
    '<div id="insights-root" data-loaded="0">' +
    chrome +
    '<div class="stat-row" id="insights-stats" style="margin-bottom:1.25rem"></div>' +
    "<h3>Beads closed over time</h3>" +
    '<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 0.75rem">' +
    "Daily count of closed beads. Bucketed by " +
    '<code style="font-size:0.9em">updatedAt</code> in UTC (close-time proxy).' +
    "</p>" +
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.75rem;height:280px;position:relative">' +
    '<canvas id="chart-closed-daily"></canvas>' +
    "</div>" +
    '<h3 style="margin-top:1.5rem">Activity calendar</h3>' +
    '<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 0.75rem">' +
    "Last 12 weeks, GitHub-style. Brighter = more beads closed that day (UTC)." +
    "</p>" +
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.75rem;height:220px;position:relative">' +
    '<canvas id="chart-calendar"></canvas>' +
    "</div>" +
    '<p id="insights-error" style="display:none;color:#ff4757;font-size:0.85rem;margin-top:0.75rem"></p>' +
    "</div>"
  );
}

function destroyCharts() {
  chartInstances.forEach(function (c) {
    try { c.destroy(); } catch { /* noop */ }
  });
  chartInstances = [];
}

function renderStatsCards(root, s) {
  const el = root.querySelector("#insights-stats");
  if (!el) return;
  const avgFmt = s.avg ? s.avg.toFixed(1) : "0";
  const bestLabel = s.best.count ? s.best.day + " (" + s.best.count + ")" : "—";
  el.innerHTML =
    '<div class="stat-card"><div class="stat-num" style="color:' + COLOR_GREEN + '">' + s.total +
    '</div><div class="stat-label">Total closed</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:' + COLOR_BLUE + '">' + s.last7 +
    '</div><div class="stat-label">Closed (last 7d)</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:' + COLOR_YELLOW + '">' + avgFmt +
    '</div><div class="stat-label">Avg / day</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:' + COLOR_PINK + ';font-size:1.4rem">' +
    esc(bestLabel) + '</div><div class="stat-label">Busiest day</div></div>';
}

function showError(root, err) {
  const errEl = root.querySelector("#insights-error");
  if (!errEl) return;
  errEl.style.display = "block";
  errEl.textContent =
    "Failed to load Chart.js: " + ((err && err.message) || String(err)) +
    ". The KPI cards above still reflect the current data.";
}

function buildDailyChartConfig(series, types) {
  const datasets = types.map(function (t, idx) {
    const color = colorForType(t, idx);
    return {
      label: t,
      data: series.map(function (s) { return s.byType.get(t) || 0; }),
      backgroundColor: color,
      borderColor: color,
      borderWidth: 0,
      borderRadius: 2,
      stack: "closed",
      hoverBackgroundColor: color,
    };
  });
  return {
    type: "bar",
    data: {
      labels: series.map(function (s) { return s.day; }),
      datasets: datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            color: COLOR_AXIS,
            boxWidth: 10,
            boxHeight: 10,
            font: { family: "ui-monospace, monospace", size: 11 },
            padding: 12,
          },
        },
        tooltip: {
          backgroundColor: COLOR_TIP_BG,
          borderColor: COLOR_TIP_BORDER,
          borderWidth: 1,
          titleColor: "#e6ecf5",
          bodyColor: "#e6ecf5",
          footerColor: "#e6ecf5",
          padding: 8,
          callbacks: {
            label: function (ctx) {
              if (!ctx.parsed || !ctx.parsed.y) return null;
              return ctx.dataset.label + ": " + ctx.parsed.y;
            },
            footer: function (items) {
              let total = 0;
              items.forEach(function (it) { total += it.parsed.y || 0; });
              return "Total: " + total;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            color: COLOR_AXIS,
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 14,
            font: { family: "ui-monospace, monospace", size: 10 },
          },
          grid: { display: false },
          border: { color: COLOR_GRID },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            color: COLOR_AXIS,
            precision: 0,
            font: { family: "ui-monospace, monospace", size: 10 },
          },
          grid: { color: COLOR_GRID },
          border: { display: false },
        },
      },
    },
  };
}

function buildCalendarChartConfig(cells, maxV, numCols) {
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    type: "matrix",
    data: {
      datasets: [{
        label: "closed/day",
        data: cells,
        parsing: false,
        backgroundColor: function (ctx) {
          const v = ctx.raw && typeof ctx.raw.v === "number" ? ctx.raw.v : 0;
          if (!v || !maxV) return "rgba(138,164,200,0.08)";
          const ratio = Math.min(1, v / maxV);
          const alpha = 0.22 + ratio * 0.78;
          return "rgba(61,255,156," + alpha.toFixed(3) + ")";
        },
        borderColor: "rgba(0,0,0,0)",
        borderWidth: 0,
        width: function (ctx) {
          const a = ctx.chart.chartArea;
          if (!a) return 10;
          return Math.max(6, (a.right - a.left) / numCols - 2);
        },
        height: function (ctx) {
          const a = ctx.chart.chartArea;
          if (!a) return 10;
          return Math.max(6, (a.bottom - a.top) / 7 - 2);
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: COLOR_TIP_BG,
          borderColor: COLOR_TIP_BORDER,
          borderWidth: 1,
          titleColor: "#e6ecf5",
          bodyColor: "#e6ecf5",
          padding: 8,
          displayColors: false,
          callbacks: {
            title: function (items) {
              return (items[0] && items[0].raw && items[0].raw.d) || "";
            },
            label: function (item) {
              return (item.raw && item.raw.v ? item.raw.v : 0) + " closed";
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: -0.5,
          max: numCols - 0.5,
          offset: false,
          ticks: { display: false },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          type: "linear",
          min: -0.5,
          max: 6.5,
          offset: false,
          ticks: {
            stepSize: 1,
            color: COLOR_AXIS,
            font: { family: "ui-monospace, monospace", size: 10 },
            callback: function (v) { return weekdayLabels[v] || ""; },
          },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
  };
}

/**
 * @param {HTMLElement} root Output of renderInsightsHtml, already in the DOM.
 * @param {{issues?: Array<object>} | null} data
 */
export async function wireInsights(root, data) {
  if (!root) return;
  destroyCharts();

  const issues = data && Array.isArray(data.issues) ? data.issues : [];
  const built = buildCounts(issues);
  const series = buildDailySeries(built.counts, built.byType);
  const types = typesPresent(built.byType);
  const s = summarize(series, built.counts, built.total);
  renderStatsCards(root, s);

  /** @type {any} */
  let Chart;
  try {
    Chart = await ensureChartJs();
  } catch (err) {
    showError(root, err);
    return;
  }

  const dailyCanvas = root.querySelector("#chart-closed-daily");
  if (dailyCanvas && series.length && types.length) {
    try {
      chartInstances.push(new Chart(dailyCanvas, buildDailyChartConfig(series, types)));
    } catch (err) {
      showError(root, err);
    }
  }

  const calCanvas = root.querySelector("#chart-calendar");
  if (calCanvas) {
    const cal = buildCalendarCells(built.counts, 12);
    try {
      chartInstances.push(new Chart(calCanvas, buildCalendarChartConfig(cal.cells, cal.maxV, cal.numCols)));
    } catch (err) {
      showError(root, err);
    }
  }

  root.setAttribute("data-loaded", "1");
}
