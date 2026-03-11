import { parseCsvText, buildHolesFromMapping } from "./csvParser.js";
import { DiagramRenderer } from "./diagramRenderer.js";
import { ensureRow, assignHolesToRow, assignOrderedHolesToRow, clearHolesFromRows, deleteRow, renumberRow, setRowStartReference, rowSummary } from "./rowManager.js";
import { initTimingControls } from "./timingControls.js";
import { startNewPath, addHoleToActivePath, clearPaths, setDirectionForActivePath } from "./initiationTools.js";
import { saveProject, loadProjectFile, hydrateStateFromProject } from "./projectStorage.js";
import { solveTimingCombinations, formatTimingResult } from "./timingSolver.js";

const state = {
  holes: [],
  holesById: new Map(),
  rows: {},
  selection: new Set(),
  ui: { showGrid: true, toolMode: "rowAssign", rowAssignPath: [] },
  timing: {
    holeToHole: { min: 0, max: 0 },
    rowToRow: { min: 0, max: 0 },
  },
  initiation: { paths: [], activePathId: null },
  centerPull: { enabled: false, centerRowId: 1, leftDelayMs: 0, rightDelayMs: 0 },
  csvCache: null,
  timingResults: [],
};

const els = {
  csvInput: document.getElementById("csvInput"),
  mappingPanel: document.getElementById("mappingPanel"),
  coordTypeSelect: document.getElementById("coordTypeSelect"),
  xColumnSelect: document.getElementById("xColumnSelect"),
  yColumnSelect: document.getElementById("yColumnSelect"),
  idColumnSelect: document.getElementById("idColumnSelect"),
  importMappedBtn: document.getElementById("importMappedBtn"),
  gridToggle: document.getElementById("gridToggle"),
  fitViewBtn: document.getElementById("fitViewBtn"),
  rotateLeftBtn: document.getElementById("rotateLeftBtn"),
  rotateRightBtn: document.getElementById("rotateRightBtn"),
  rotateResetBtn: document.getElementById("rotateResetBtn"),
  activeRowIdInput: document.getElementById("activeRowIdInput"),
  assignRowBtn: document.getElementById("assignRowBtn"),
  removeFromRowBtn: document.getElementById("removeFromRowBtn"),
  renumberRowBtn: document.getElementById("renumberRowBtn"),
  deleteRowBtn: document.getElementById("deleteRowBtn"),
  referenceRowSelect: document.getElementById("referenceRowSelect"),
  referenceHoleIndexInput: document.getElementById("referenceHoleIndexInput"),
  setStartReferenceBtn: document.getElementById("setStartReferenceBtn"),
  rowList: document.getElementById("rowList"),
  toolModeSelect: document.getElementById("toolModeSelect"),
  firingDirectionSelect: document.getElementById("firingDirectionSelect"),
  newPathBtn: document.getElementById("newPathBtn"),
  clearPathsBtn: document.getElementById("clearPathsBtn"),
  centerPullToggle: document.getElementById("centerPullToggle"),
  centerRowInput: document.getElementById("centerRowInput"),
  leftDelayInput: document.getElementById("leftDelayInput"),
  rightDelayInput: document.getElementById("rightDelayInput"),
  holeDelayMin: document.getElementById("holeDelayMinInput"),
  holeDelayMax: document.getElementById("holeDelayMaxInput"),
  rowDelayMin: document.getElementById("rowDelayMinInput"),
  rowDelayMax: document.getElementById("rowDelayMaxInput"),
  solveTimingBtn: document.getElementById("solveTimingBtn"),
  timingResults: document.getElementById("timingResults"),
  saveProjectBtn: document.getElementById("saveProjectBtn"),
  loadProjectInput: document.getElementById("loadProjectInput"),
};

const renderer = new DiagramRenderer(document.getElementById("diagramCanvas"), {
  stateRef: state,
  onHoleClick: handleHoleClick,
  onHoleHover: handleHoleHover,
  onPointerUp: endRowAssignStroke,
});

const timingBinding = initTimingControls(state, els, () => {
  state.timingResults = [];
  renderTimingResults();
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
  [els.xColumnSelect, els.yColumnSelect, els.idColumnSelect].forEach((select) => {
    select.innerHTML = "";
    if (select === els.idColumnSelect) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "(Auto)";
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
  const idGuess = inferHeaderByPriority(headers, [["hole"], ["id"]]);

  if (xGuess) els.xColumnSelect.value = xGuess;
  if (yGuess) els.yColumnSelect.value = yGuess;
  if (idGuess) els.idColumnSelect.value = idGuess;

  const lower = headers.map((h) => h.toLowerCase());
  if (lower.some((h) => h.includes("lat")) && lower.some((h) => h.includes("lon"))) {
    els.coordTypeSelect.value = "latlon";
  }
}

function rebuildHolesById() {
  state.holesById = new Map(state.holes.map((h) => [h.id, h]));
}

function refreshRowUi() {
  const summaries = rowSummary(state);
  els.rowList.innerHTML = summaries.length ? summaries.map((s) => `<div>${s}</div>`).join("") : "<div>No rows assigned</div>";

  const rowIds = Object.keys(state.rows).map(Number).sort((a, b) => a - b);
  els.referenceRowSelect.innerHTML = rowIds.map((id) => `<option value="${id}">Row ${id}</option>`).join("");
}

function renderTimingResults() {
  if (!state.timingResults.length) {
    els.timingResults.innerHTML = "<div>Run solver to see best delay combinations.</div>";
    return;
  }
  els.timingResults.innerHTML = state.timingResults.map((r, i) => `<div>${formatTimingResult(r, i)}</div>`).join("");
}

function fullRefresh({ fit = false } = {}) {
  refreshRowUi();
  renderTimingResults();
  renderer.render();
  if (fit) renderer.fitToData();
}

function applyImportedHoles(holes) {
  state.holes = holes;
  state.rows = {};
  state.selection = new Set();
  state.initiation = { paths: [], activePathId: null };
  state.ui.rowAssignPath = [];
  state.timingResults = [];
  rebuildHolesById();
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
    renderer.render();
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
  const holes = buildHolesFromMapping({
    records,
    coordType: els.coordTypeSelect.value,
    xColumn: els.xColumnSelect.value,
    yColumn: els.yColumnSelect.value,
    idColumn,
  });

  const rowHeader = inferHeaderByPriority(headers, [["row"]]);
  uniqueHoleIds(holes, records, idColumn, rowHeader);
  applyImportedHoles(holes);
  autoAssignRowsFromCsv(records);
  fullRefresh({ fit: true });
});

els.gridToggle.addEventListener("change", () => {
  state.ui.showGrid = els.gridToggle.checked;
  renderer.render();
});

els.fitViewBtn.addEventListener("click", () => renderer.fitToData());
els.rotateLeftBtn.addEventListener("click", () => renderer.rotateBy(-15));
els.rotateRightBtn.addEventListener("click", () => renderer.rotateBy(15));
els.rotateResetBtn.addEventListener("click", () => renderer.resetRotation());

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

els.renumberRowBtn.addEventListener("click", () => {
  const fromId = Number(els.activeRowIdInput.value);
  const toRaw = window.prompt("New row number:");
  if (!toRaw) return;
  renumberRow(state, fromId, Number(toRaw));
  fullRefresh();
});

els.deleteRowBtn.addEventListener("click", () => {
  const rowId = Number(els.activeRowIdInput.value);
  deleteRow(state, rowId);
  fullRefresh();
});

els.setStartReferenceBtn.addEventListener("click", () => {
  const rowId = Number(els.activeRowIdInput.value);
  const referenceRow = Number(els.referenceRowSelect.value);
  const referenceHoleIndex = Number(els.referenceHoleIndexInput.value);
  setRowStartReference(state, rowId, referenceRow, referenceHoleIndex);
  fullRefresh();
});

els.toolModeSelect.addEventListener("change", () => {
  state.ui.toolMode = els.toolModeSelect.value;
  state.ui.rowAssignPath = [];
  renderer.render();
});

els.firingDirectionSelect.addEventListener("change", () => {
  setDirectionForActivePath(state, els.firingDirectionSelect.value);
  renderer.render();
});

els.newPathBtn.addEventListener("click", () => {
  const path = startNewPath(state, els.firingDirectionSelect.value);
  state.initiation.activePathId = path.id;
  renderer.render();
});

els.clearPathsBtn.addEventListener("click", () => {
  clearPaths(state);
  renderer.render();
});

[els.centerPullToggle, els.centerRowInput, els.leftDelayInput, els.rightDelayInput].forEach((input) => {
  input.addEventListener("input", () => {
    state.centerPull.enabled = els.centerPullToggle.checked;
    state.centerPull.centerRowId = Number(els.centerRowInput.value) || 1;
    state.centerPull.leftDelayMs = Number(els.leftDelayInput.value) || 0;
    state.centerPull.rightDelayMs = Number(els.rightDelayInput.value) || 0;
    renderer.render();
  });
});

els.solveTimingBtn.addEventListener("click", () => {
  state.timingResults = solveTimingCombinations(state);
  renderTimingResults();
});

els.saveProjectBtn.addEventListener("click", () => saveProject(state));

els.loadProjectInput.addEventListener("change", async () => {
  const file = els.loadProjectInput.files[0];
  if (!file) return;
  const project = await loadProjectFile(file);
  hydrateStateFromProject(state, project);
  timingBinding.syncFromState();
  els.centerPullToggle.checked = Boolean(state.centerPull.enabled);
  els.centerRowInput.value = state.centerPull.centerRowId;
  els.leftDelayInput.value = state.centerPull.leftDelayMs;
  els.rightDelayInput.value = state.centerPull.rightDelayMs;
  fullRefresh({ fit: true });
});

ensureRow(state, 1);
els.toolModeSelect.value = state.ui.toolMode;
renderTimingResults();
refreshRowUi();
renderer.render();
