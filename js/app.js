import { parseCsvText, buildHolesFromMapping } from "./csvParser.js";
import { DiagramRenderer } from "./diagramRenderer.js";
import { ensureRow, assignHolesToRow, assignOrderedHolesToRow, clearHolesFromRows, deleteRow, setHoleOrderNumber, applyRowOrderNumbers, rowSummary } from "./rowManager.js";
import { initTimingControls } from "./timingControls.js";
import { addHoleToActivePath, clearPaths } from "./initiationTools.js";
import { solveTimingCombinations, formatTimingResult } from "./timingSolver.js";
import { exportTimingPdfFromCanvas } from "./pdfExport.js";

const state = {
  holes: [],
  holesById: new Map(),
  rows: {},
  selection: new Set(),
  ui: { showGrid: true, showOverlayText: true, toolMode: "rowAssign", coordView: "collar", rowAssignPath: [], activeTimingPreviewIndex: -1 },
  timing: {
    holeToHole: { min: 16, max: 34 },
    rowToRow: { min: 84, max: 142 },
  },
  initiation: { paths: [], activePathId: null },
  centerPull: {
    enabled: false,
    side: "left",
    offsetMinMs: 17,
    offsetMaxMs: 42,
    initiationAnchorsByRow: {},
  },
  csvCache: null,
  timingResults: [],
};

const els = {
  csvInput: document.getElementById("csvInput"),
  mappingPanel: document.getElementById("mappingPanel"),
  coordTypeSelect: document.getElementById("coordTypeSelect"),
  xColumnSelect: document.getElementById("xColumnSelect"),
  yColumnSelect: document.getElementById("yColumnSelect"),
  toeXColumnSelect: document.getElementById("toeXColumnSelect"),
  toeYColumnSelect: document.getElementById("toeYColumnSelect"),
  idColumnSelect: document.getElementById("idColumnSelect"),
  importMappedBtn: document.getElementById("importMappedBtn"),
  gridToggle: document.getElementById("gridToggle"),
  fitViewBtn: document.getElementById("fitViewBtn"),
  coordViewSelect: document.getElementById("coordViewSelect"),
  rotateLeftBtn: document.getElementById("rotateLeftBtn"),
  rotateRightBtn: document.getElementById("rotateRightBtn"),
  rotateFineLeftBtn: document.getElementById("rotateFineLeftBtn"),
  rotateFineRightBtn: document.getElementById("rotateFineRightBtn"),
  rotateResetBtn: document.getElementById("rotateResetBtn"),
  activeRowIdInput: document.getElementById("activeRowIdInput"),
  assignRowBtn: document.getElementById("assignRowBtn"),
  removeFromRowBtn: document.getElementById("removeFromRowBtn"),
  deleteRowBtn: document.getElementById("deleteRowBtn"),
  clearAllRowsBtn: document.getElementById("clearAllRowsBtn"),
  rowStepDownBtn: document.getElementById("rowStepDownBtn"),
  rowStepUpBtn: document.getElementById("rowStepUpBtn"),
  rowMiniValue: document.getElementById("rowMiniValue"),
  rowList: document.getElementById("rowList"),
  rowPaintToolBtn: document.getElementById("rowPaintToolBtn"),
  initiationToolBtn: document.getElementById("initiationToolBtn"),
  clearPathsBtn: document.getElementById("clearPathsBtn"),
  centerPullToggle: document.getElementById("centerPullToggle"),
  offsetSideSelect: document.getElementById("offsetSideSelect"),
  offsetMinInput: document.getElementById("offsetMinInput"),
  offsetMaxInput: document.getElementById("offsetMaxInput"),
  clearInitiationAnchorsBtn: document.getElementById("clearInitiationAnchorsBtn"),
  initiationAnchorList: document.getElementById("initiationAnchorList"),
  holeDelayMin: document.getElementById("holeDelayMinInput"),
  holeDelayMax: document.getElementById("holeDelayMaxInput"),
  rowDelayMin: document.getElementById("rowDelayMinInput"),
  rowDelayMax: document.getElementById("rowDelayMaxInput"),
  solveTimingBtn: document.getElementById("solveTimingBtn"),
  timingResults: document.getElementById("timingResults"),
  exportPdfBtn: document.getElementById("exportPdfBtn"),
};

const renderer = new DiagramRenderer(document.getElementById("diagramCanvas"), {
  stateRef: state,
  onHoleClick: handleHoleClick,
  onHoleHover: handleHoleHover,
  onPointerUp: endRowAssignStroke,
  onHoleContextMenu: handleHoleContextMenu,
});

const timingBinding = initTimingControls(state, els, () => {
  state.timingResults = [];
  state.ui.activeTimingPreviewIndex = -1;
  renderTimingResults();
  renderer.render();
});

function uniqueHoleIds(holes, records, idColumn, rowColumn) {
  const seen = new Set();
  holes.forEach((hole) => {
    let id = String(hole.id);
    if (rowColumn && records[hole.sourceIndex]?.[rowColumn]) {
      const r = records[hole.sourceIndex][rowColumn];
      if (seen.has(id)) id = `R${r}-H${id}`;
    }
    while (seen.has(id)) id = `${id}_dup`;
    hole.id = id;
    seen.add(id);
  });
}

function inferHeaderByPriority(headers, priorityGroups) {
  const lower = headers.map((h) => ({ raw: h, low: h.toLowerCase() }));
  for (const group of priorityGroups) {
    const match = lower.find((entry) => group.every((needle) => entry.low.includes(needle)));
    if (match) return match.raw;
  }
  return "";
}

function setColumnOptions(headers) {
  [els.xColumnSelect, els.yColumnSelect, els.toeXColumnSelect, els.toeYColumnSelect, els.idColumnSelect].forEach((select) => {
    select.innerHTML = "";
    if (select === els.idColumnSelect || select === els.toeXColumnSelect || select === els.toeYColumnSelect) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = select === els.idColumnSelect ? "(Auto)" : "(None)";
      select.appendChild(none);
    }
    headers.forEach((header) => {
      const option = document.createElement("option");
      option.value = header;
      option.textContent = header;
      select.appendChild(option);
    });
  });

  const xGuess = inferHeaderByPriority(headers, [
    ["start", "point", "easting"],
    ["start", "easting"],
    ["easting"],
    ["start", "point", "longitude"],
    ["longitude"],
    ["x"],
  ]);
  const yGuess = inferHeaderByPriority(headers, [
    ["start", "point", "northing"],
    ["start", "northing"],
    ["northing"],
    ["start", "point", "latitude"],
    ["latitude"],
    ["y"],
  ]);
  const toeXGuess = inferHeaderByPriority(headers, [
    ["toe", "easting"],
    ["end", "point", "easting"],
    ["toe", "longitude"],
    ["end", "point", "longitude"],
    ["toe", "x"],
  ]);
  const toeYGuess = inferHeaderByPriority(headers, [
    ["toe", "northing"],
    ["end", "point", "northing"],
    ["toe", "latitude"],
    ["end", "point", "latitude"],
    ["toe", "y"],
  ]);
  const idGuess = inferHeaderByPriority(headers, [["hole"], ["id"]]);

  if (xGuess) els.xColumnSelect.value = xGuess;
  if (yGuess) els.yColumnSelect.value = yGuess;
  if (toeXGuess) els.toeXColumnSelect.value = toeXGuess;
  if (toeYGuess) els.toeYColumnSelect.value = toeYGuess;
  if (idGuess) els.idColumnSelect.value = idGuess;

  const lower = headers.map((h) => h.toLowerCase());
  if (lower.some((h) => h.includes("lat")) && lower.some((h) => h.includes("lon"))) {
    els.coordTypeSelect.value = "latlon";
  }
}

function rebuildHolesById() {
  state.holesById = new Map(state.holes.map((h) => [h.id, h]));
}

function normalizeHoleCoordinateSets(hole) {
  if (!hole.collar || !Number.isFinite(hole.collar.x) || !Number.isFinite(hole.collar.y)) {
    hole.collar = {
      x: Number.isFinite(hole.x) ? hole.x : 0,
      y: Number.isFinite(hole.y) ? hole.y : 0,
      original: hole.original || null,
    };
  }
  if (hole.toe && (!Number.isFinite(hole.toe.x) || !Number.isFinite(hole.toe.y))) {
    hole.toe = null;
  }
}

function hasAnyToeCoordinates() {
  return state.holes.some((hole) => hole.toe && Number.isFinite(hole.toe.x) && Number.isFinite(hole.toe.y));
}

function applyCoordinateView(view, { fit = false } = {}) {
  const hasToe = hasAnyToeCoordinates();
  const targetView = view === "toe" && hasToe ? "toe" : "collar";
  state.ui.coordView = targetView;

  state.holes.forEach((hole) => {
    normalizeHoleCoordinateSets(hole);
    const target = targetView === "toe" && hole.toe ? hole.toe : hole.collar;
    hole.x = target.x;
    hole.y = target.y;
  });

  els.coordViewSelect.disabled = !hasToe;
  els.coordViewSelect.value = state.ui.coordView;
  renderer.render();
  if (fit) renderer.fitToData();
}

function sanitizeInitiationAnchors() {
  const next = {};
  Object.entries(state.centerPull.initiationAnchorsByRow || {}).forEach(([rowId, holeId]) => {
    const hole = state.holesById.get(holeId);
    if (!hole) return;
    if (String(hole.rowId) !== String(rowId)) return;
    next[rowId] = holeId;
  });
  state.centerPull.initiationAnchorsByRow = next;
}

function renderInitiationAnchorList() {
  sanitizeInitiationAnchors();
  const rows = Object.keys(state.centerPull.initiationAnchorsByRow).map(Number).sort((a, b) => a - b);
  if (!rows.length) {
    els.initiationAnchorList.innerHTML = "<div>No initiation anchors set</div>";
    return;
  }
  const lines = rows.map((rowId) => {
    const holeId = state.centerPull.initiationAnchorsByRow[rowId];
    const hole = state.holesById.get(holeId);
    if (!hole) return null;
    const label = (hole.rowId !== null && hole.orderInRow !== null) ? `${hole.rowId}-${hole.orderInRow}` : hole.id;
    return `<div>Row ${rowId} anchor: ${label}</div>`;
  }).filter(Boolean);
  els.initiationAnchorList.innerHTML = lines.join("");
}

function refreshRowUi() {
  const summaries = rowSummary(state);
  els.rowList.innerHTML = summaries.length ? summaries.map((s) => `<div>${s}</div>`).join("") : "<div>No rows assigned</div>";
  renderInitiationAnchorList();
}

function normalizeToolMode(value) {
  return value === "initiation" ? "initiation" : "rowAssign";
}

function syncToolkitUi() {
  const mode = normalizeToolMode(state.ui.toolMode);
  state.ui.toolMode = mode;
  els.rowPaintToolBtn.classList.toggle("active", mode === "rowAssign");
  els.initiationToolBtn.classList.toggle("active", mode === "initiation");
}

function setToolMode(mode) {
  state.ui.toolMode = normalizeToolMode(mode);
  state.ui.rowAssignPath = [];
  syncToolkitUi();
  renderer.render();
}

function getActiveRowId() {
  const n = Math.floor(Number(els.activeRowIdInput.value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function setActiveRowId(rowId) {
  const next = Math.max(1, Math.floor(Number(rowId) || 1));
  els.activeRowIdInput.value = String(next);
  els.rowMiniValue.textContent = String(next);
}

function normalizeRowNumbering() {
  Object.values(state.rows).forEach((row) => {
    if (!Number.isFinite(Number(row.numberingStart)) || Number(row.numberingStart) < 1) {
      row.numberingStart = 1;
    }
    applyRowOrderNumbers(state, row.id);
  });
}

function renderTimingResults() {
  if (!state.timingResults.length) {
    els.timingResults.innerHTML = "<div>Run solver to see best delay combinations.</div>";
    return;
  }
  els.timingResults.innerHTML = state.timingResults.map((r, i) => {
    const active = i === state.ui.activeTimingPreviewIndex ? "active" : "";
    return `<button class="timing-item ${active}" data-timing-index="${i}">${formatTimingResult(r, i)}</button>`;
  }).join("");
}

function fullRefresh({ fit = false } = {}) {
  refreshRowUi();
  renderTimingResults();
  renderer.render();
  if (fit) renderer.fitToData();
}

function applyImportedHoles(holes) {
  holes.forEach((hole) => normalizeHoleCoordinateSets(hole));
  state.holes = holes;
  state.rows = {};
  state.selection = new Set();
  state.initiation = { paths: [], activePathId: null };
  state.centerPull.initiationAnchorsByRow = {};
  state.ui.coordView = "collar";
  state.ui.rowAssignPath = [];
  state.ui.activeTimingPreviewIndex = -1;
  state.timingResults = [];
  rebuildHolesById();
  applyCoordinateView("collar");
}

function autoAssignRowsFromCsv(records) {
  if (!records.length) return;
  const rowHeader = Object.keys(records[0]).find((h) => h.toLowerCase() === "row" || h.toLowerCase().includes("row"));
  if (!rowHeader) return;

  const rowsToHoles = {};
  state.holes.forEach((hole) => {
    const rowRaw = records[hole.sourceIndex]?.[rowHeader];
    const rowId = Number(rowRaw);
    if (!Number.isFinite(rowId)) return;
    if (!rowsToHoles[rowId]) rowsToHoles[rowId] = [];
    rowsToHoles[rowId].push(hole.id);
  });

  Object.entries(rowsToHoles).forEach(([rowId, holeIds]) => {
    assignHolesToRow(state, Number(rowId), holeIds);
  });
}

function setInitiationAnchorFromHole(hole) {
  if (hole.rowId === null) return;
  state.centerPull.initiationAnchorsByRow[hole.rowId] = hole.id;
}

function handleHoleClick(hole, ev) {
  if (state.ui.toolMode === "rowAssign") {
    const rowId = Number(els.activeRowIdInput.value);
    if (hole.rowId !== null && hole.rowId !== rowId) return;
    state.ui.rowAssignPath = [hole.id];
    assignOrderedHolesToRow(state, rowId, [hole.id], { append: true, preventCrossRow: true });
    fullRefresh();
    return;
  }

  if (state.ui.toolMode === "initiation") {
    addHoleToActivePath(state, hole.id);
    setInitiationAnchorFromHole(hole);
    fullRefresh();
    return;
  }

  if (!ev.shiftKey) {
    if (state.selection.size === 1 && state.selection.has(hole.id)) state.selection.clear();
    else state.selection = new Set([hole.id]);
  } else {
    if (state.selection.has(hole.id)) state.selection.delete(hole.id);
    else state.selection.add(hole.id);
  }
  renderer.render();
}

function handleHoleHover(hole) {
  if (state.ui.toolMode !== "rowAssign") return;
  if (!state.ui.rowAssignPath.length) return;
  if (state.ui.rowAssignPath[state.ui.rowAssignPath.length - 1] === hole.id) return;
  const rowId = Number(els.activeRowIdInput.value);
  if (hole.rowId !== null && hole.rowId !== rowId) return;

  state.ui.rowAssignPath.push(hole.id);
  assignOrderedHolesToRow(state, rowId, [hole.id], { append: true, preventCrossRow: true });
  fullRefresh();
}

function endRowAssignStroke() {
  if (!state.ui.rowAssignPath.length) return;
  state.ui.rowAssignPath = [];
  renderer.render();
}

function handleHoleContextMenu(hole) {
  if (hole.rowId === null) return;
  const row = state.rows[hole.rowId];
  if (!row) return;
  const current = Number.isFinite(Number(hole.orderInRow)) ? String(hole.orderInRow) : "";
  const input = window.prompt(
    `Set hole number for Row ${row.id} (blank = auto numbering):`,
    current
  );
  if (input === null) return;
  const trimmed = input.trim();
  const nextOrder = trimmed === "" ? null : Number(trimmed);
  if (!setHoleOrderNumber(state, row.id, hole.id, nextOrder)) return;
  fullRefresh();
}

els.csvInput.addEventListener("change", async () => {
  const file = els.csvInput.files[0];
  if (!file) return;
  const text = await file.text();
  const parsed = parseCsvText(text);
  state.csvCache = parsed;
  setColumnOptions(parsed.headers);
  els.mappingPanel.classList.remove("hidden");
});

els.importMappedBtn.addEventListener("click", () => {
  if (!state.csvCache) return;
  const { headers, records } = state.csvCache;
  if (!headers.length || !records.length) return;

  const idColumn = els.idColumnSelect.value || null;
  const toeXColumn = els.toeXColumnSelect.value || null;
  const toeYColumn = els.toeYColumnSelect.value || null;
  if ((toeXColumn && !toeYColumn) || (!toeXColumn && toeYColumn)) {
    window.alert("Select both Toe X and Toe Y columns, or leave both empty.");
    return;
  }

  const holes = buildHolesFromMapping({
    records,
    coordType: els.coordTypeSelect.value,
    xColumn: els.xColumnSelect.value,
    yColumn: els.yColumnSelect.value,
    idColumn,
  });
  if (!holes.length) {
    window.alert("No valid collar coordinates found for selected columns.");
    return;
  }

  let toeBySource = new Map();
  if (toeXColumn && toeYColumn) {
    const toeHoles = buildHolesFromMapping({
      records,
      coordType: els.coordTypeSelect.value,
      xColumn: toeXColumn,
      yColumn: toeYColumn,
      idColumn,
    });
    toeBySource = new Map(
      toeHoles.map((hole) => [hole.sourceIndex, { x: hole.x, y: hole.y, original: hole.original }])
    );
  }

  holes.forEach((hole) => {
    hole.collar = { x: hole.x, y: hole.y, original: hole.original };
    hole.toe = toeBySource.get(hole.sourceIndex) || null;
  });

  const rowHeader = inferHeaderByPriority(headers, [["row"]]);
  uniqueHoleIds(holes, records, idColumn, rowHeader);
  applyImportedHoles(holes);
  normalizeRowNumbering();
  fullRefresh({ fit: true });
});

els.gridToggle.addEventListener("change", () => {
  state.ui.showGrid = els.gridToggle.checked;
  renderer.render();
});

els.fitViewBtn.addEventListener("click", () => renderer.fitToData());
els.coordViewSelect.addEventListener("change", () => {
  applyCoordinateView(els.coordViewSelect.value, { fit: true });
});

els.rotateLeftBtn.addEventListener("click", () => {
  renderer.rotateBy(-15);
});
els.rotateRightBtn.addEventListener("click", () => {
  renderer.rotateBy(15);
});
els.rotateFineLeftBtn.addEventListener("click", () => {
  renderer.rotateBy(-1);
});
els.rotateFineRightBtn.addEventListener("click", () => {
  renderer.rotateBy(1);
});
els.rotateResetBtn.addEventListener("click", () => {
  renderer.resetRotation();
});

els.assignRowBtn.addEventListener("click", () => {
  const rowId = Number(els.activeRowIdInput.value);
  if (!state.selection.size) return;
  assignHolesToRow(state, rowId, [...state.selection]);
  fullRefresh();
});

els.removeFromRowBtn.addEventListener("click", () => {
  clearHolesFromRows(state, [...state.selection]);
  fullRefresh();
});

els.deleteRowBtn.addEventListener("click", () => {
  const rowId = Number(els.activeRowIdInput.value);
  deleteRow(state, rowId);
  sanitizeInitiationAnchors();
  fullRefresh();
});

els.clearAllRowsBtn.addEventListener("click", () => {
  state.rows = {};
  state.holes.forEach((hole) => {
    hole.rowId = null;
    hole.orderInRow = null;
  });
  state.selection = new Set();
  state.centerPull.initiationAnchorsByRow = {};
  fullRefresh();
});

els.rowStepDownBtn.addEventListener("click", () => {
  setActiveRowId(getActiveRowId() - 1);
});

els.rowStepUpBtn.addEventListener("click", () => {
  setActiveRowId(getActiveRowId() + 1);
});

els.activeRowIdInput.addEventListener("input", () => {
  setActiveRowId(getActiveRowId());
});

els.rowPaintToolBtn.addEventListener("click", () => {
  setToolMode("rowAssign");
});

els.initiationToolBtn.addEventListener("click", () => {
  setToolMode("initiation");
});

els.clearPathsBtn.addEventListener("click", () => {
  clearPaths(state);
  renderer.render();
});

[els.centerPullToggle, els.offsetSideSelect, els.offsetMinInput, els.offsetMaxInput].forEach((input) => {
  input.addEventListener("input", () => {
    state.centerPull.enabled = els.centerPullToggle.checked;
    state.centerPull.side = els.offsetSideSelect.value || "left";
    state.centerPull.offsetMinMs = Number(els.offsetMinInput.value) || 0;
    state.centerPull.offsetMaxMs = Number(els.offsetMaxInput.value) || 0;
    renderer.render();
  });
});

els.clearInitiationAnchorsBtn.addEventListener("click", () => {
  state.centerPull.initiationAnchorsByRow = {};
  fullRefresh();
});

els.solveTimingBtn.addEventListener("click", () => {
  sanitizeInitiationAnchors();
  state.timingResults = solveTimingCombinations(state);
  state.ui.activeTimingPreviewIndex = state.timingResults.length ? 0 : -1;
  renderTimingResults();
  renderer.render();
});

els.timingResults.addEventListener("click", (ev) => {
  const target = ev.target.closest("[data-timing-index]");
  if (!target) return;
  const idx = Number(target.getAttribute("data-timing-index"));
  if (!Number.isFinite(idx)) return;
  state.ui.activeTimingPreviewIndex = idx;
  renderTimingResults();
  renderer.render();
});

els.exportPdfBtn.addEventListener("click", () => {
  const selectedTiming = state.timingResults[state.ui.activeTimingPreviewIndex] || null;
  const prevShowGrid = state.ui.showGrid;
  const prevShowOverlayText = state.ui.showOverlayText;
  state.ui.showGrid = false;
  state.ui.showOverlayText = false;
  renderer.render();
  exportTimingPdfFromCanvas({
    canvas: renderer.canvas,
    selectedTiming,
  });
  state.ui.showGrid = prevShowGrid;
  state.ui.showOverlayText = prevShowOverlayText;
  renderer.render();
});

function syncCenterPullUi() {
  els.centerPullToggle.checked = Boolean(state.centerPull.enabled);
  els.offsetSideSelect.value = state.centerPull.side || "left";
  els.offsetMinInput.value = Number(state.centerPull.offsetMinMs || 0);
  els.offsetMaxInput.value = Number(state.centerPull.offsetMaxMs || 0);
}

ensureRow(state, 1);
setActiveRowId(getActiveRowId());
setToolMode(state.ui.toolMode);
syncCenterPullUi();
els.coordViewSelect.value = state.ui.coordView;
els.coordViewSelect.disabled = true;
renderTimingResults();
refreshRowUi();
renderer.render();
