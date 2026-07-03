"use strict";

/* GitView single-page app.
 * Fetches repository data from the JSON API and renders an interactive
 * commit graph (with lane assignment) plus branch/remote/tag panels. */

const LANE_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f85149", "#39c5cf", "#db61a2", "#a5d6ff",
];
const ROW_H = 44;
const LANE_W = 22;
const LEFT_PAD = 20;
const DOT_R = 6;

const state = {
  commits: [],
  branches: [],
  remotes: [],
  tags: [],
  info: null,
  selected: null,
  hashToRow: new Map(),
};

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

function showError(msg) {
  const el = document.getElementById("error-banner");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearError() {
  document.getElementById("error-banner").classList.add("hidden");
}

/* -- lane assignment ---------------------------------------------------- */
/* Assigns each commit a column so that branch lines stay separated and
 * merges converge. Edges are then drawn directly between node centers. */
function assignColumns(commits) {
  const activeLanes = []; // lane -> hash it currently flows toward, or null
  let maxCol = 0;

  const firstFree = () => {
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null || activeLanes[i] === undefined) return i;
    }
    activeLanes.push(null);
    return activeLanes.length - 1;
  };

  commits.forEach((c) => {
    // Find lanes expecting this commit.
    const claiming = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === c.hash) claiming.push(i);
    }

    let col;
    if (claiming.length > 0) {
      col = claiming[0];
      // Merge: free the extra lanes that pointed here.
      for (let k = 1; k < claiming.length; k++) activeLanes[claiming[k]] = null;
    } else {
      col = firstFree();
    }
    c.column = col;
    maxCol = Math.max(maxCol, col);

    // Route lanes toward parents.
    const parents = c.parents || [];
    if (parents.length === 0) {
      activeLanes[col] = null; // root commit
    } else {
      activeLanes[col] = parents[0]; // first parent continues in this lane
      for (let k = 1; k < parents.length; k++) {
        // Reuse a lane already heading to this parent, else take a free one.
        let existing = activeLanes.indexOf(parents[k]);
        const lane = existing >= 0 ? existing : firstFree();
        activeLanes[lane] = parents[k];
        maxCol = Math.max(maxCol, lane);
      }
    }
  });

  return maxCol;
}

/* -- graph rendering ---------------------------------------------------- */
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function laneX(col) { return LEFT_PAD + col * LANE_W; }
function rowY(row) { return row * ROW_H + ROW_H / 2; }
function laneColor(col) { return LANE_COLORS[col % LANE_COLORS.length]; }

function renderGraph() {
  const commits = state.commits;
  const svg = document.getElementById("graph-svg");
  svg.innerHTML = "";

  if (commits.length === 0) {
    const wrap = document.getElementById("graph-wrap");
    wrap.innerHTML = '<div class="loading">No commits yet in this repository.</div>';
    return;
  }

  const maxCol = assignColumns(commits);
  state.hashToRow = new Map();
  commits.forEach((c, i) => state.hashToRow.set(c.hash, i));

  const graphWidth = LEFT_PAD + (maxCol + 1) * LANE_W;
  const textX = graphWidth + 8;
  const wrap = document.getElementById("graph-wrap");
  const totalW = Math.max(wrap.clientWidth, textX + 400);
  const totalH = commits.length * ROW_H + 10;
  svg.setAttribute("width", totalW);
  svg.setAttribute("height", totalH);
  svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);

  // Row backgrounds (for selection + hover targets).
  commits.forEach((c, i) => {
    const bg = svgEl("rect", {
      x: 0, y: i * ROW_H, width: totalW, height: ROW_H,
      class: "node-hit", fill: "transparent",
    });
    bg.dataset.hash = c.hash;
    if (state.selected === c.hash) bg.classList.add("row-selected");
    bg.addEventListener("click", () => selectCommit(c.hash));
    svg.appendChild(bg);
  });

  // Edges first (drawn under nodes).
  commits.forEach((c, i) => {
    (c.parents || []).forEach((p) => {
      const pRow = state.hashToRow.get(p);
      const x1 = laneX(c.column), y1 = rowY(i);
      if (pRow === undefined) {
        // Parent not loaded (truncated history): short stub downward.
        const stub = svgEl("line", {
          x1, y1, x2: x1, y2: y1 + ROW_H * 0.6,
          stroke: laneColor(c.column), "stroke-width": 2,
          "stroke-dasharray": "3 3", "stroke-opacity": .6,
        });
        svg.appendChild(stub);
        return;
      }
      const parent = commits[pRow];
      const x2 = laneX(parent.column), y2 = rowY(pRow);
      const color = laneColor(Math.max(c.column, parent.column));
      let d;
      if (x1 === x2) {
        d = `M ${x1} ${y1} L ${x2} ${y2}`;
      } else {
        const my = (y1 + y2) / 2;
        d = `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
      }
      svg.appendChild(svgEl("path", {
        d, fill: "none", stroke: color, "stroke-width": 2,
      }));
    });
  });

  // Nodes + text.
  commits.forEach((c, i) => {
    const cx = laneX(c.column), cy = rowY(i);
    const color = laneColor(c.column);
    const g = svgEl("g", { class: "node" });
    g.dataset.hash = c.hash;

    const circle = svgEl("circle", {
      cx, cy, r: DOT_R, fill: color, stroke: "#0d1117", "stroke-width": 2,
    });
    if (c.parents && c.parents.length > 1) {
      circle.setAttribute("r", DOT_R + 1); // merge commits slightly larger
    }
    g.appendChild(circle);

    // Ref labels (branches/tags) then subject.
    let tx = textX;
    (c.refs || []).forEach((ref) => {
      if (ref === "HEAD") return;
      const isTag = ref.startsWith("tag:");
      const label = isTag ? ref.slice(4).trim() : ref;
      const w = 8 + label.length * 6.6;
      const bg = svgEl("rect", {
        x: tx, y: cy - 9, width: w, height: 18, rx: 4,
        fill: isTag ? "rgba(210,153,34,.18)" : "rgba(88,166,255,.18)",
        stroke: isTag ? "#d29922" : "#58a6ff",
      });
      const t = svgEl("text", {
        x: tx + 5, y: cy + 4, class: "ref-label",
        fill: isTag ? "#d29922" : "#58a6ff",
      });
      t.textContent = label;
      g.appendChild(bg);
      g.appendChild(t);
      tx += w + 6;
    });

    const subj = svgEl("text", { x: tx, y: cy - 2, class: "commit-subject" });
    subj.textContent = c.subject || "(no message)";
    g.appendChild(subj);

    const meta = svgEl("text", { x: tx, y: cy + 12, class: "commit-meta" });
    meta.textContent = `${c.short} · ${c.author_name} · ${fmtDate(c.author_date)}`;
    g.appendChild(meta);

    g.addEventListener("click", () => selectCommit(c.hash));
    svg.appendChild(g);
  });
}

/* -- details panel ------------------------------------------------------ */
async function selectCommit(hash) {
  state.selected = hash;
  renderGraph();
  const panel = document.getElementById("details");
  panel.innerHTML = '<div class="loading">Loading commit…</div>';
  try {
    const d = await api(`/api/commit/${hash}`);
    renderDetails(d);
  } catch (e) {
    panel.innerHTML = `<div class="details-empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderDetails(d) {
  const panel = document.getElementById("details");
  const refs = (d.refs || []).filter((r) => r !== "HEAD").map((r) => {
    const isTag = r.startsWith("tag:");
    const label = isTag ? r.slice(4).trim() : r;
    const color = isTag ? "#d29922" : "#58a6ff";
    return `<span class="ref-chip" style="color:${color};border-color:${color}">${escapeHtml(label)}</span>`;
  }).join("");

  const files = (d.files || []).map((f) => {
    const add = f.added === null ? "-" : f.added;
    const del = f.removed === null ? "-" : f.removed;
    return `<li><span class="add">+${add}</span><span class="del">-${del}</span>
      <span class="path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span></li>`;
  }).join("");

  panel.innerHTML = `
    <h2>${escapeHtml(d.subject || "(no message)")}</h2>
    <div class="hash">${escapeHtml(d.hash)}</div>
    ${refs ? `<div style="margin-top:8px">${refs}</div>` : ""}
    <div class="kv">
      <span class="k">Author</span><span class="v">${escapeHtml(d.author_name)} &lt;${escapeHtml(d.author_email)}&gt;</span>
      <span class="k">Date</span><span class="v">${fmtDateTime(d.author_date)}</span>
      <span class="k">Parents</span><span class="v mono">${(d.parents || []).map(p => p.slice(0,8)).join(", ") || "—"}</span>
      <span class="k">Changes</span><span class="v">${d.stats.files} files, <span class="add">+${d.stats.added}</span> <span class="del">-${d.stats.removed}</span></span>
    </div>
    ${d.body ? `<div class="body">${escapeHtml(d.body)}</div>` : ""}
    <h3 style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px">Files changed</h3>
    <ul class="files">${files || '<li class="mono" style="color:var(--text-dim)">No file changes.</li>'}</ul>
  `;
}

/* -- sidebar panels ----------------------------------------------------- */
function renderStats() {
  const info = state.info;
  const stats = document.getElementById("stats");
  const c = info.counts;
  stats.innerHTML = `
    <div class="stat"><div class="num">${c.commits}</div><div class="lbl">Commits</div></div>
    <div class="stat"><div class="num">${c.branches}</div><div class="lbl">Branches</div></div>
    <div class="stat"><div class="num">${c.remotes}</div><div class="lbl">Remotes</div></div>
    <div class="stat"><div class="num">${c.tags}</div><div class="lbl">Tags</div></div>
  `;
  const meta = document.getElementById("repo-meta");
  const head = info.current_branch
    ? `on ${info.current_branch}`
    : (info.head_detached ? "detached HEAD" : "");
  meta.textContent = `${info.path}   ${head}`;
}

function renderBranches() {
  const local = state.branches.filter((b) => !b.is_remote);
  const remote = state.branches.filter((b) => b.is_remote);
  const list = document.getElementById("branch-list");
  const item = (b) => {
    const color = laneColorForCommit(b.commit);
    return `<li data-hash="${b.commit}">
      <span class="dot" style="background:${color}"></span>
      ${b.is_head ? '<span class="head-star">●</span>' : ""}
      <span class="branch-name">${escapeHtml(b.name)}</span>
      <span class="mono badge">${escapeHtml(b.short)}</span>
    </li>`;
  };
  list.innerHTML =
    (local.length ? `<li style="cursor:default;color:var(--text-dim);font-size:11px;text-transform:uppercase">Local</li>` : "") +
    local.map(item).join("") +
    (remote.length ? `<li style="cursor:default;color:var(--text-dim);font-size:11px;text-transform:uppercase;margin-top:6px">Remote</li>` : "") +
    remote.map(item).join("");
  list.querySelectorAll("li[data-hash]").forEach((li) => {
    li.addEventListener("click", () => selectCommit(li.dataset.hash));
  });
}

function renderRemotes() {
  const list = document.getElementById("remote-list");
  if (state.remotes.length === 0) {
    list.innerHTML = '<li style="cursor:default;color:var(--text-dim)">No remotes configured.</li>';
    return;
  }
  list.innerHTML = state.remotes.map((r) => `
    <li style="flex-direction:column;align-items:flex-start;cursor:default">
      <div><span class="dot" style="background:var(--purple)"></span> <b>${escapeHtml(r.name)}</b></div>
      ${r.fetch ? `<div class="remote-url">↓ ${escapeHtml(r.fetch)}</div>` : ""}
      ${r.push && r.push !== r.fetch ? `<div class="remote-url">↑ ${escapeHtml(r.push)}</div>` : ""}
    </li>`).join("");
}

function renderTags() {
  const list = document.getElementById("tag-list");
  if (state.tags.length === 0) {
    list.innerHTML = '<li style="cursor:default;color:var(--text-dim)">No tags.</li>';
    return;
  }
  list.innerHTML = state.tags.map((t) => `
    <li data-hash="${t.commit}">
      <span class="dot" style="background:var(--orange)"></span>
      <span class="branch-name">${escapeHtml(t.name)}</span>
      <span class="mono badge">${(t.commit || "").slice(0,7)}</span>
    </li>`).join("");
  list.querySelectorAll("li[data-hash]").forEach((li) => {
    li.addEventListener("click", () => selectCommit(li.dataset.hash));
  });
}

function laneColorForCommit(hash) {
  const row = state.hashToRow.get(hash);
  if (row === undefined) return "#8b949e";
  return laneColor(state.commits[row].column || 0);
}

/* -- tabs --------------------------------------------------------------- */
function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      // The graph tab just keeps all panels visible; others emphasize one.
      const panels = { branches: "panel-branches", remotes: "panel-remotes", tags: "panel-tags" };
      Object.values(panels).forEach((id) =>
        document.getElementById(id).classList.remove("hidden"));
      if (which !== "graph") {
        Object.entries(panels).forEach(([key, id]) => {
          document.getElementById(id).classList.toggle("hidden", key !== which);
        });
      }
    });
  });
}

/* -- utils -------------------------------------------------------------- */
function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
function fmtDateTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* -- boot --------------------------------------------------------------- */
async function loadAll() {
  clearError();
  try {
    const [info, commits, branches, remotes, tags] = await Promise.all([
      api("/api/info"),
      api("/api/commits?limit=1000"),
      api("/api/branches"),
      api("/api/remotes"),
      api("/api/tags"),
    ]);
    state.info = info;
    state.commits = commits.commits;
    state.branches = branches.branches;
    state.remotes = remotes.remotes;
    state.tags = tags.tags;

    renderStats();
    renderGraph();
    renderBranches();
    renderRemotes();
    renderTags();
  } catch (e) {
    showError(e.message);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  document.getElementById("refresh").addEventListener("click", loadAll);
  window.addEventListener("resize", () => { if (state.commits.length) renderGraph(); });
  loadAll();
});
