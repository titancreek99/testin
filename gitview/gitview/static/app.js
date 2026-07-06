"use strict";

/* GitView single-page app.
 * Fetches repository data from the JSON API and renders an interactive
 * commit graph (rail-based lane layout with merge/branch curves), plus
 * branch/remote/tag panels, hover tooltips, search, and themes. */

/* Categorical lane palettes, one set per theme (stepped for each surface,
 * validated for CVD separation and surface contrast). Lane identity is also
 * carried by column position and per-row text labels, never color alone. */
const THEME_LANES = {
  dark: ["#3987e5", "#199e70", "#c98500", "#008300",
         "#9085e9", "#e66767", "#d55181", "#d95926"],
  light: ["#2a78d6", "#1baf7a", "#eda100", "#008300",
          "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"],
};

const LANE_W = 22;
const LEFT_PAD = 20;
const DOT_R = 5.5;
const ROW_COMFY = 46;
const ROW_COMPACT = 30;
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const state = {
  commits: [],
  branches: [],
  remotes: [],
  tags: [],
  info: null,
  selected: null,
  hashToRow: new Map(),
  rowGroups: new Map(),   // hash -> <g> wrapping row bg + node (for dim/select)
  rowRects: new Map(),    // hash -> background <rect>
  rowH: ROW_COMFY,
  filter: "",
  matches: [],
  matchIdx: -1,
  reflog: [],
  diffCache: new Map(),   // commit hash -> parsed diff payload
  lastToken: null,
  liveEnabled: true,
};

/* -- api / errors -------------------------------------------------------- */
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

/* -- theme --------------------------------------------------------------- */
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("gitview-theme", theme); } catch (e) { /* ok */ }
  document.getElementById("theme-toggle").textContent =
    theme === "dark" ? "☀ Light" : "☾ Dark";
}
function laneColor(col) {
  const set = THEME_LANES[currentTheme()];
  return set[col % set.length];
}

/* -- lane assignment ------------------------------------------------------ */
/* Assigns each commit a column and records, for every child→parent edge,
 * the lane the connection travels in. First-parent edges continue in the
 * child's lane; extra parents reuse a lane already flowing toward that
 * parent or claim a free one. */
function assignColumns(commits) {
  const active = []; // lane index -> hash the lane is flowing toward
  let maxCol = 0;

  const firstFree = () => {
    for (let i = 0; i < active.length; i++) {
      if (active[i] == null) return i;
    }
    active.push(null);
    return active.length - 1;
  };

  commits.forEach((c) => {
    const claiming = [];
    for (let i = 0; i < active.length; i++) {
      if (active[i] === c.hash) claiming.push(i);
    }

    const col = claiming.length ? claiming[0] : firstFree();
    for (let k = 1; k < claiming.length; k++) active[claiming[k]] = null;
    c.column = col;
    maxCol = Math.max(maxCol, col);

    c.edges = [];
    const parents = c.parents || [];
    if (parents.length === 0) {
      active[col] = null;
      return;
    }
    // First parent flows on in this lane.
    active[col] = parents[0];
    c.edges.push({ parent: parents[0], lane: col });
    // Remaining parents (merge sources).
    for (let k = 1; k < parents.length; k++) {
      let lane = active.indexOf(parents[k]);
      if (lane < 0) lane = firstFree();
      active[lane] = parents[k];
      c.edges.push({ parent: parents[k], lane });
      maxCol = Math.max(maxCol, lane);
    }
  });

  return maxCol;
}

/* -- svg helpers ----------------------------------------------------------- */
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function laneX(col) { return LEFT_PAD + col * LANE_W; }
function rowY(row) { return row * state.rowH + state.rowH / 2; }

let _measureCtx = null;
function textWidth(text, font) {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

/* Rail-style edge: leave the child, swing into the travel lane within one
 * row, run vertically, then swing into the parent within one row. */
function edgePath(x1, y1, x2, y2, xL) {
  const R = state.rowH;
  if (y2 - y1 <= R + 0.5) { // adjacent rows: single smooth curve
    if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
  }
  let d = `M ${x1} ${y1}`;
  let cy = y1;
  if (xL !== x1) {           // swing out below the child
    const yTurn = y1 + R;
    const my = (y1 + yTurn) / 2;
    d += ` C ${x1} ${my} ${xL} ${my} ${xL} ${yTurn}`;
    cy = yTurn;
  }
  const yEnd = (xL !== x2) ? y2 - R : y2;
  if (yEnd > cy) { d += ` L ${xL} ${yEnd}`; cy = yEnd; }
  if (xL !== x2) {           // swing in above the parent
    const my = (cy + y2) / 2;
    d += ` C ${xL} ${my} ${x2} ${my} ${x2} ${y2}`;
  }
  return d;
}

/* -- graph rendering -------------------------------------------------------- */
function renderGraph() {
  const commits = state.commits;
  const svg = document.getElementById("graph-svg");
  const empty = document.getElementById("graph-empty");
  svg.innerHTML = "";
  state.rowGroups = new Map();
  state.rowRects = new Map();

  if (commits.length === 0) {
    empty.classList.remove("hidden");
    svg.setAttribute("height", 0);
    return;
  }
  empty.classList.add("hidden");

  const maxCol = assignColumns(commits);
  state.hashToRow = new Map();
  commits.forEach((c, i) => state.hashToRow.set(c.hash, i));

  const compact = state.rowH === ROW_COMPACT;
  const graphWidth = LEFT_PAD + (maxCol + 1) * LANE_W;
  const textX = graphWidth + 10;
  const wrap = document.getElementById("graph-wrap");
  const totalW = Math.max(wrap.clientWidth - 2, textX + 460);
  const totalH = commits.length * state.rowH + 10;
  svg.setAttribute("width", totalW);
  svg.setAttribute("height", totalH);
  svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);

  const rowLayer = svgEl("g", {});
  const edgeLayer = svgEl("g", {});
  const nodeLayer = svgEl("g", {});
  svg.appendChild(rowLayer);
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  // Edges (under nodes). Travel-lane color keeps rails visually continuous.
  commits.forEach((c, i) => {
    const x1 = laneX(c.column), y1 = rowY(i);
    (c.edges || []).forEach((e) => {
      const pRow = state.hashToRow.get(e.parent);
      const color = laneColor(e.lane);
      if (pRow === undefined) { // truncated history: dashed stub
        edgeLayer.appendChild(svgEl("path", {
          d: `M ${x1} ${y1} L ${laneX(e.lane)} ${y1 + state.rowH * 0.7}`,
          fill: "none", stroke: color, "stroke-width": 2,
          "stroke-dasharray": "3 3", "stroke-opacity": 0.55,
        }));
        return;
      }
      const parent = commits[pRow];
      edgeLayer.appendChild(svgEl("path", {
        d: edgePath(x1, y1, laneX(parent.column), rowY(pRow), laneX(e.lane)),
        fill: "none", stroke: color, "stroke-width": 2,
        "stroke-linecap": "round", class: "edge",
      }));
    });
  });

  // Rows: background + node + labels, grouped so dim/select applies once.
  const labelFont = `600 10px ${SANS}`;
  commits.forEach((c, i) => {
    const cx = laneX(c.column), cy = rowY(i);
    const color = laneColor(c.column);
    const isMerge = (c.parents || []).length > 1;
    const isHead = (c.refs || []).includes("HEAD");

    const g = svgEl("g", { class: "row" });
    g.dataset.hash = c.hash;

    const bg = svgEl("rect", {
      x: 0, y: i * state.rowH, width: totalW, height: state.rowH,
      class: "row-bg", fill: "transparent",
    });
    g.appendChild(bg);
    state.rowRects.set(c.hash, bg);

    // Node dot: merges render as rings, HEAD gets a halo.
    if (isHead) {
      g.appendChild(svgEl("circle", {
        cx, cy, r: DOT_R + 4.5, fill: "none",
        stroke: color, "stroke-width": 1.5, "stroke-opacity": 0.45,
      }));
    }
    if (isMerge) {
      g.appendChild(svgEl("circle", {
        cx, cy, r: DOT_R - 0.5, fill: "none",
        stroke: color, "stroke-width": 2.5, class: "node-ring",
      }));
    } else {
      g.appendChild(svgEl("circle", {
        cx, cy, r: DOT_R, fill: color, class: "node-dot",
      }));
    }

    // Ref chips: measured widths, ink text, colored border/wash.
    let tx = textX;
    (c.refs || []).forEach((ref) => {
      if (ref === "HEAD") return;
      const isTag = ref.startsWith("tag:");
      const isRemote = !isTag && ref.includes("/");
      const label = isTag ? ref.slice(4).trim() : ref;
      const w = Math.ceil(textWidth(label, labelFont)) + 12;
      const cls = isTag ? "chip-tag" : (isRemote ? "chip-remote" : "chip-branch");
      g.appendChild(svgEl("rect", {
        x: tx, y: cy - 9, width: w, height: 18, rx: 9, class: `chip ${cls}`,
      }));
      const t = svgEl("text", {
        x: tx + 6, y: cy + 3.5, class: `ref-label ${cls}-text`,
      });
      t.textContent = label;
      g.appendChild(t);
      tx += w + 6;
    });

    if (compact) {
      const line = svgEl("text", { x: tx, y: cy + 4, class: "commit-subject" });
      const hashSpan = svgEl("tspan", { class: "commit-hash-inline" });
      hashSpan.textContent = c.short + "  ";
      const subjSpan = svgEl("tspan", {});
      subjSpan.textContent = c.subject || "(no message)";
      line.appendChild(hashSpan);
      line.appendChild(subjSpan);
      g.appendChild(line);
    } else {
      const subj = svgEl("text", { x: tx, y: cy - 2, class: "commit-subject" });
      subj.textContent = c.subject || "(no message)";
      g.appendChild(subj);
      const meta = svgEl("text", { x: tx, y: cy + 13, class: "commit-meta" });
      meta.textContent =
        `${c.short}  ·  ${c.author_name}  ·  ${relTime(c.author_date)}`;
      g.appendChild(meta);
    }

    g.addEventListener("click", () => selectCommit(c.hash));
    g.addEventListener("mouseenter", (ev) => showTooltip(c, ev));
    g.addEventListener("mousemove", moveTooltip);
    g.addEventListener("mouseleave", hideTooltip);

    state.rowGroups.set(c.hash, g);
    rowLayer.appendChild(g);
  });

  applySelection();
  applyFilterDim();
}

/* -- selection ------------------------------------------------------------- */
function applySelection() {
  state.rowRects.forEach((rect, hash) => {
    rect.classList.toggle("row-selected", hash === state.selected);
  });
}

async function selectCommit(hash, scroll) {
  state.selected = hash;
  applySelection();
  if (scroll) {
    const rect = state.rowRects.get(hash);
    if (rect) rect.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const panel = document.getElementById("details");
  panel.innerHTML = '<div class="loading">Loading commit…</div>';
  try {
    renderDetails(await api(`/api/commit/${hash}`));
  } catch (e) {
    panel.innerHTML = `<div class="details-empty">${escapeHtml(e.message)}</div>`;
  }
}

/* -- tooltip ---------------------------------------------------------------- */
function showTooltip(c, ev) {
  const tip = document.getElementById("tooltip");
  const refs = (c.refs || []).filter((r) => r !== "HEAD")
    .map((r) => `<span class="tip-ref">${escapeHtml(r)}</span>`).join(" ");
  tip.innerHTML = `
    <div class="tip-subject">${escapeHtml(c.subject || "(no message)")}</div>
    <div class="tip-line mono">${escapeHtml(c.short)}${c.parents.length > 1 ? "  ·  merge" : ""}</div>
    <div class="tip-line">${escapeHtml(c.author_name)} &lt;${escapeHtml(c.author_email)}&gt;</div>
    <div class="tip-line">${fmtDateTime(c.author_date)} (${relTime(c.author_date)})</div>
    ${refs ? `<div class="tip-line">${refs}</div>` : ""}`;
  tip.classList.remove("hidden");
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const tip = document.getElementById("tooltip");
  if (tip.classList.contains("hidden")) return;
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTooltip() {
  document.getElementById("tooltip").classList.add("hidden");
}

/* -- search / filter --------------------------------------------------------- */
function runFilter() {
  const q = state.filter.trim().toLowerCase();
  state.matches = [];
  if (q) {
    state.commits.forEach((c, i) => {
      const hay = `${c.subject} ${c.author_name} ${c.author_email} ${c.hash} ${(c.refs || []).join(" ")}`.toLowerCase();
      if (hay.includes(q)) state.matches.push(i);
    });
  }
  state.matchIdx = -1;
  applyFilterDim();
  const count = document.getElementById("search-count");
  count.textContent = q ? `${state.matches.length} / ${state.commits.length}` : "";
}

function applyFilterDim() {
  const q = state.filter.trim();
  const matchSet = new Set(state.matches.map((i) => state.commits[i].hash));
  state.rowGroups.forEach((g, hash) => {
    g.classList.toggle("row-dim", !!q && !matchSet.has(hash));
  });
}

function jumpToMatch(dir) {
  if (!state.matches.length) return;
  state.matchIdx = (state.matchIdx + dir + state.matches.length) % state.matches.length;
  const c = state.commits[state.matches[state.matchIdx]];
  selectCommit(c.hash, true);
}

/* -- details panel ------------------------------------------------------------ */
function renderDetails(d) {
  const panel = document.getElementById("details");
  const refs = (d.refs || []).filter((r) => r !== "HEAD").map((r) => {
    const isTag = r.startsWith("tag:");
    const label = isTag ? r.slice(4).trim() : r;
    return `<span class="ref-chip ${isTag ? "chip-tag" : "chip-branch"}">${escapeHtml(label)}</span>`;
  }).join("");

  const parents = (d.parents || []).map((p) =>
    `<a class="parent-link mono" data-hash="${p}" href="#">${p.slice(0, 8)}</a>`
  ).join(", ") || "— (root commit)";

  const maxChange = Math.max(1, ...(d.files || []).map((f) => (f.added || 0) + (f.removed || 0)));
  const files = (d.files || []).map((f, idx) => {
    let line;
    if (f.binary) {
      line = `<span class="file-bin">BIN</span>
        <span class="path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`;
    } else {
      const total = (f.added || 0) + (f.removed || 0);
      const w = Math.max(4, Math.round((total / maxChange) * 56));
      const aw = total ? Math.round((f.added / total) * w) : 0;
      line = `<span class="add">+${f.added}</span><span class="del">−${f.removed}</span>
        <span class="diffbar" style="width:${w}px">
          <i class="bar-add" style="width:${aw}px"></i><i class="bar-del" style="width:${w - aw}px"></i>
        </span>
        <span class="path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`;
    }
    return `<li class="file-row" data-path="${escapeHtml(f.path)}" data-idx="${idx}">
      <div class="file-line"><span class="caret">▸</span>${line}</div>
      <div class="filediff hidden"></div>
    </li>`;
  }).join("");

  const committerRow = d.committer_name && d.committer_name !== d.author_name
    ? `<span class="k">Committer</span><span class="v">${escapeHtml(d.committer_name)}</span>
       <span class="k">Committed</span><span class="v">${fmtDateTime(d.committer_date)}</span>`
    : "";

  panel.innerHTML = `
    <h2>${escapeHtml(d.subject || "(no message)")}</h2>
    <div class="hash-row">
      <span class="hash mono">${escapeHtml(d.hash)}</span>
      <button class="btn btn-sm" id="copy-hash" title="Copy full hash">⧉ Copy</button>
    </div>
    ${refs ? `<div class="detail-refs">${refs}</div>` : ""}
    <div class="kv">
      <span class="k">Author</span><span class="v">${escapeHtml(d.author_name)} &lt;${escapeHtml(d.author_email)}&gt;</span>
      <span class="k">Authored</span><span class="v">${fmtDateTime(d.author_date)} <span class="dim">(${relTime(d.author_date)})</span></span>
      ${committerRow}
      <span class="k">Parents</span><span class="v">${parents}</span>
      <span class="k">Changes</span><span class="v">${d.stats.files} file${d.stats.files === 1 ? "" : "s"} changed,
        <span class="add">+${d.stats.added}</span> <span class="del">−${d.stats.removed}</span></span>
    </div>
    ${d.body ? `<div class="body">${escapeHtml(d.body)}</div>` : ""}
    <h3 class="section-h">Files changed</h3>
    <ul class="files">${files || '<li class="dim">No file changes.</li>'}</ul>
  `;

  const copyBtn = document.getElementById("copy-hash");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(d.hash);
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => { copyBtn.textContent = "⧉ Copy"; }, 1500);
    } catch (e) {
      copyBtn.textContent = d.hash.slice(0, 12);
    }
  });
  panel.querySelectorAll(".parent-link").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      selectCommit(a.dataset.hash, true);
    });
  });
  panel.querySelectorAll(".file-row").forEach((li) => {
    li.querySelector(".file-line").addEventListener("click", () =>
      toggleFileDiff(d.hash, li));
  });
}

/* -- diff viewer ------------------------------------------------------------- */
async function fetchDiff(hash) {
  if (state.diffCache.has(hash)) return state.diffCache.get(hash);
  const promise = api(`/api/diff/${hash}`);
  state.diffCache.set(hash, promise);
  try {
    const data = await promise;
    state.diffCache.set(hash, data);
    return data;
  } catch (e) {
    state.diffCache.delete(hash);
    throw e;
  }
}

async function toggleFileDiff(hash, li) {
  const box = li.querySelector(".filediff");
  const caret = li.querySelector(".caret");
  const open = !box.classList.contains("hidden");
  if (open) {
    box.classList.add("hidden");
    caret.textContent = "▸";
    return;
  }
  caret.textContent = "▾";
  box.classList.remove("hidden");
  if (!box.dataset.loaded) {
    box.innerHTML = '<div class="diff-note">Loading diff…</div>';
    try {
      const diff = await fetchDiff(hash);
      const path = li.dataset.path;
      const file = (diff.files || []).find(
        (f) => f.path === path || f.old_path === path);
      renderFileDiff(box, file, diff.truncated);
      box.dataset.loaded = "1";
    } catch (e) {
      box.innerHTML = `<div class="diff-note">${escapeHtml(e.message)}</div>`;
    }
  }
}

function renderFileDiff(box, file, truncated) {
  if (!file) {
    box.innerHTML = '<div class="diff-note">No diff available for this file'
      + (truncated ? " (diff truncated — commit too large)." : ".") + "</div>";
    return;
  }
  if (file.binary) {
    box.innerHTML = '<div class="diff-note">Binary file — no text diff.</div>';
    return;
  }
  if (!file.hunks.length) {
    box.innerHTML = '<div class="diff-note">No content changes (mode change or rename only).</div>';
    return;
  }
  const rows = [];
  const status = file.status !== "modified"
    ? `<div class="diff-note">${escapeHtml(file.status)}${file.old_path
        ? ` from ${escapeHtml(file.old_path)}` : ""}</div>` : "";
  file.hunks.forEach((h) => {
    rows.push(`<tr class="diff-hunk"><td class="ln"></td><td class="ln"></td>
      <td class="code">${escapeHtml(h.header)}</td></tr>`);
    h.lines.forEach((l) => {
      const cls = l.t === "add" ? "diff-add" : l.t === "del" ? "diff-del"
        : l.t === "meta" ? "diff-metaline" : "diff-ctx";
      const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
      rows.push(`<tr class="${cls}">
        <td class="ln">${l.o == null ? "" : l.o}</td>
        <td class="ln">${l.n == null ? "" : l.n}</td>
        <td class="code"><span class="sign">${sign}</span>${escapeHtml(l.s)}</td></tr>`);
    });
  });
  box.innerHTML = status
    + `<div class="diff-scroll"><table class="diff-table">${rows.join("")}</table></div>`
    + (truncated ? '<div class="diff-note">⚠ Diff truncated — commit too large to show fully.</div>' : "");
}

/* -- sidebar panels ------------------------------------------------------------- */
function renderStats() {
  const info = state.info;
  const c = info.counts;
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="num">${c.commits}</div><div class="lbl">Commits</div></div>
    <div class="stat"><div class="num">${c.branches}</div><div class="lbl">Branches</div></div>
    <div class="stat"><div class="num">${c.remotes}</div><div class="lbl">Remotes</div></div>
    <div class="stat"><div class="num">${c.tags}</div><div class="lbl">Tags</div></div>`;
  const head = info.current_branch
    ? `on ${info.current_branch}` : (info.head_detached ? "detached HEAD" : "");
  document.getElementById("repo-meta").textContent = `${info.path}   ${head}`;
}

function renderBranches() {
  const local = state.branches.filter((b) => !b.is_remote);
  const remote = state.branches.filter((b) => b.is_remote);
  const list = document.getElementById("branch-list");
  const item = (b) => `<li data-hash="${b.commit}" title="${escapeHtml(b.name)} → ${b.short}">
      <span class="dot" style="background:${laneColorForCommit(b.commit)}"></span>
      ${b.is_head ? '<span class="head-star" title="current branch">●</span>' : ""}
      <span class="branch-name">${escapeHtml(b.name)}
        ${b.upstream ? `<div class="sub">⇢ ${escapeHtml(b.upstream)}</div>` : ""}</span>
      <span class="mono badge">${escapeHtml(b.short)}</span>
    </li>`;
  list.innerHTML =
    (local.length ? '<li class="list-h">Local</li>' : "") + local.map(item).join("") +
    (remote.length ? '<li class="list-h">Remote</li>' : "") + remote.map(item).join("");
  list.querySelectorAll("li[data-hash]").forEach((li) => {
    li.addEventListener("click", () => selectCommit(li.dataset.hash, true));
    li.addEventListener("mouseenter", () => highlightRow(li.dataset.hash, true));
    li.addEventListener("mouseleave", () => highlightRow(li.dataset.hash, false));
  });
}

function highlightRow(hash, on) {
  const rect = state.rowRects.get(hash);
  if (rect) rect.classList.toggle("row-hint", on);
}

function renderRemotes() {
  const list = document.getElementById("remote-list");
  if (!state.remotes.length) {
    list.innerHTML = '<li class="dim" style="cursor:default">No remotes configured.</li>';
    return;
  }
  list.innerHTML = state.remotes.map((r) => `
    <li class="remote-item">
      <div class="remote-name">${escapeHtml(r.name)}</div>
      ${r.fetch ? `<div class="remote-url" title="fetch URL">↓ ${escapeHtml(r.fetch)}</div>` : ""}
      ${r.push && r.push !== r.fetch ? `<div class="remote-url" title="push URL">↑ ${escapeHtml(r.push)}</div>` : ""}
    </li>`).join("");
}

function renderTags() {
  const list = document.getElementById("tag-list");
  if (!state.tags.length) {
    list.innerHTML = '<li class="dim" style="cursor:default">No tags.</li>';
    return;
  }
  list.innerHTML = state.tags.map((t) => `
    <li data-hash="${t.commit}" title="${escapeHtml(t.subject || "")}">
      <span class="tag-icon">⌂</span>
      <span class="branch-name">${escapeHtml(t.name)}
        <div class="sub">${relTime(t.date)}</div></span>
      <span class="mono badge">${(t.commit || "").slice(0, 7)}</span>
    </li>`).join("");
  list.querySelectorAll("li[data-hash]").forEach((li) => {
    li.addEventListener("click", () => selectCommit(li.dataset.hash, true));
    li.addEventListener("mouseenter", () => highlightRow(li.dataset.hash, true));
    li.addEventListener("mouseleave", () => highlightRow(li.dataset.hash, false));
  });
}

function renderReflog() {
  const list = document.getElementById("reflog-list");
  if (!state.reflog.length) {
    list.innerHTML = '<li class="dim" style="cursor:default">No reflog entries.</li>';
    return;
  }
  list.innerHTML = state.reflog.map((r) => {
    const [kind, rest] = splitAction(r.action);
    return `<li data-hash="${r.hash}" class="reflog-item" title="${escapeHtml(r.action)}">
      <span class="reflog-kind">${escapeHtml(kind)}</span>
      <span class="branch-name">${escapeHtml(rest)}
        <div class="sub">${escapeHtml(r.selector)} · ${relTime(r.date)}</div></span>
      <span class="mono badge">${escapeHtml(r.short)}</span>
    </li>`;
  }).join("");
  list.querySelectorAll("li[data-hash]").forEach((li) => {
    li.addEventListener("click", () => selectCommit(li.dataset.hash, true));
    li.addEventListener("mouseenter", () => highlightRow(li.dataset.hash, true));
    li.addEventListener("mouseleave", () => highlightRow(li.dataset.hash, false));
  });
}

function splitAction(action) {
  const i = action.indexOf(":");
  if (i < 0) return [action, ""];
  return [action.slice(0, i), action.slice(i + 1).trim()];
}

function renderWtCard(status) {
  const card = document.getElementById("wt-card");
  if (!status) { card.innerHTML = ""; return; }
  if (status.clean) {
    card.innerHTML = `<span class="wt-clean">✓ Working tree clean</span>`;
    card.classList.remove("wt-dirty");
    return;
  }
  card.classList.add("wt-dirty");
  const bit = (n, label) => n
    ? `<span class="wt-bit"><b>${n}</b> ${label}</span>` : "";
  card.innerHTML = `<span class="wt-title">Working tree</span>
    ${bit(status.staged, "staged")}
    ${bit(status.unstaged, "modified")}
    ${bit(status.untracked, "untracked")}`;
}

function laneColorForCommit(hash) {
  const row = state.hashToRow.get(hash);
  if (row === undefined) return "var(--text-dim)";
  return laneColor(state.commits[row].column || 0);
}

/* -- tabs ----------------------------------------------------------------------- */
function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      const panels = {
        branches: "panel-branches", remotes: "panel-remotes",
        tags: "panel-tags", reflog: "panel-reflog",
      };
      Object.entries(panels).forEach(([key, id]) => {
        // "All" shows everything except the (long) reflog.
        const hide = which === "graph" ? key === "reflog" : key !== which;
        document.getElementById(id).classList.toggle("hidden", hide);
      });
    });
  });
}

/* -- keyboard nav ------------------------------------------------------------------ */
function setupKeyboard() {
  window.addEventListener("keydown", (ev) => {
    const inInput = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (ev.key === "/" && !inInput) {
      ev.preventDefault();
      document.getElementById("search").focus();
      return;
    }
    if (inInput) return;
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    if (!state.commits.length) return;
    let row = state.selected != null ? state.hashToRow.get(state.selected) : -1;
    if (row === undefined) row = -1;
    row += ev.key === "ArrowDown" ? 1 : -1;
    row = Math.min(Math.max(row, 0), state.commits.length - 1);
    selectCommit(state.commits[row].hash, true);
  });
}

/* -- utils ----------------------------------------------------------------------------- */
function relTime(ts) {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}
function fmtDateTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* -- live updates -------------------------------------------------------------------------- */
const LIVE_POLL_MS = 2500;

function setLive(enabled) {
  state.liveEnabled = enabled;
  const btn = document.getElementById("live-toggle");
  btn.classList.toggle("live-on", enabled);
  btn.classList.toggle("live-off", !enabled);
  btn.innerHTML = `<span class="live-dot"></span> ${enabled ? "Live" : "Paused"}`;
  btn.title = enabled
    ? "Live updates: watching the repository for changes (click to pause)"
    : "Live updates paused (click to resume)";
}

async function pollState() {
  if (!state.liveEnabled || document.hidden) return;
  try {
    const s = await api("/api/state");
    renderWtCard(s.status);
    if (state.lastToken !== null && s.token !== state.lastToken) {
      await loadAll(); // loadAll refreshes the token itself
      toast("Repository changed — view refreshed");
    } else {
      state.lastToken = s.token;
    }
  } catch (e) { /* server briefly unreachable; retry next tick */ }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

/* -- boot ---------------------------------------------------------------------------------- */
async function loadAll() {
  clearError();
  try {
    const [info, commits, branches, remotes, tags, reflog, st] = await Promise.all([
      api("/api/info"),
      api("/api/commits?limit=1000"),
      api("/api/branches"),
      api("/api/remotes"),
      api("/api/tags"),
      api("/api/reflog?limit=200"),
      api("/api/state"),
    ]);
    // Baseline the change token here so edits made between page load and
    // the first poll are not silently absorbed.
    state.lastToken = st.token;
    state.info = info;
    state.commits = commits.commits;
    state.branches = branches.branches;
    state.remotes = remotes.remotes;
    state.tags = tags.tags;
    state.reflog = reflog.reflog;
    if (state.diffCache.size > 50) state.diffCache.clear();

    const content = document.querySelector(".content");
    const scrollTop = content.scrollTop;

    renderStats();
    renderWtCard(st.status);
    renderGraph();
    renderBranches();
    renderRemotes();
    renderTags();
    renderReflog();
    runFilter();

    content.scrollTop = scrollTop;
    // Keep the details pane in sync if the selected commit vanished
    // (e.g. it was amended or its branch was deleted).
    if (state.selected && !state.hashToRow.has(state.selected)) {
      state.selected = null;
      document.getElementById("details").innerHTML =
        '<div class="details-empty">The selected commit is no longer reachable.</div>';
    }
  } catch (e) {
    showError(e.message);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  let theme = "dark";
  try { theme = localStorage.getItem("gitview-theme") || "dark"; } catch (e) { /* ok */ }
  applyTheme(theme);

  setupTabs();
  setupKeyboard();

  document.getElementById("refresh").addEventListener("click", loadAll);
  document.getElementById("live-toggle").addEventListener("click", () =>
    setLive(!state.liveEnabled));
  setLive(true);
  setInterval(pollState, LIVE_POLL_MS);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
    renderGraph();
    renderBranches();
  });
  document.getElementById("density-toggle").addEventListener("click", (ev) => {
    state.rowH = state.rowH === ROW_COMFY ? ROW_COMPACT : ROW_COMFY;
    ev.target.textContent = state.rowH === ROW_COMFY ? "▤ Compact" : "▥ Comfortable";
    renderGraph();
  });

  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    state.filter = search.value;
    runFilter();
  });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") jumpToMatch(ev.shiftKey ? -1 : 1);
    if (ev.key === "Escape") { search.value = ""; state.filter = ""; runFilter(); search.blur(); }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.commits.length) renderGraph(); }, 150);
  });

  loadAll();
});
