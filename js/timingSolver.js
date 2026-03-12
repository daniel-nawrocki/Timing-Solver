function generateValues(min, max, maxSamples = 15) {
  const a = Math.max(0, Math.floor(min));
  const b = Math.max(a, Math.floor(max));
  if (a === b) return [a];
  const span = b - a;
  const step = Math.max(1, Math.ceil(span / (maxSamples - 1)));
  const values = [];
  for (let v = a; v <= b; v += step) values.push(v);
  if (values[values.length - 1] !== b) values.push(b);
  return values;
}

function maxHolesInWindow(times, windowMs = 8) {
  if (!times.length) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  let i = 0;
  let maxCount = 1;

  for (let j = 0; j < sorted.length; j += 1) {
    while (sorted[j] - sorted[i] > windowMs) i += 1;
    maxCount = Math.max(maxCount, j - i + 1);
  }
  return maxCount;
}

function rowHoleOrderMap(row, state) {
  const fallbackStart = Number.isFinite(Number(row?.numberingStart)) && Number(row.numberingStart) > 0
    ? Math.floor(Number(row.numberingStart))
    : 1;
  const ordered = row.holeIds.map((holeId, idx) => {
    const hole = state.holesById.get(holeId);
    const fallbackOrder = fallbackStart + idx;
    const order = Number.isFinite(Number(hole?.orderInRow)) ? Math.floor(Number(hole.orderInRow)) : fallbackOrder;
    return { holeId, order };
  });
  ordered.sort((a, b) => a.order - b.order);
  return ordered;
}

function rowAnchorIndex(row, state) {
  const anchorId = state.centerPull?.initiationAnchorsByRow?.[row.id];
  if (!anchorId || !row.holeIds.length) return 0;
  const ordered = rowHoleOrderMap(row, state);
  const anchorIdx = ordered.findIndex((entry) => entry.holeId === anchorId);
  return anchorIdx >= 0 ? anchorIdx : 0;
}

function relativeHoleTime(holeOrder, anchorOrder, holeDelay, side, sideOffset) {
  if (holeOrder === anchorOrder) return 0;

  if (holeOrder < anchorOrder) {
    const distance = anchorOrder - holeOrder;
    if (side === "left") return sideOffset + (distance - 1) * holeDelay;
    return distance * holeDelay;
  }

  const distance = holeOrder - anchorOrder;
  if (side === "right") return sideOffset + (distance - 1) * holeDelay;
  return distance * holeDelay;
}

function buildSchedule(state, holeDelay, rowDelay, sideOffset) {
  const rowList = Object.values(state.rows).sort((a, b) => a.rowOrder - b.rowOrder);
  const holeTimes = new Map();

  rowList.forEach((row, idx) => {
    const baseNominal = idx * rowDelay;
    const ordered = rowHoleOrderMap(row, state);
    const anchorIdx = rowAnchorIndex(row, state);
    const anchorOrder = ordered[anchorIdx]?.order ?? ordered[0]?.order ?? 1;
    ordered.forEach(({ holeId, order: holeOrder }) => {
      const rel = relativeHoleTime(
        holeOrder,
        anchorOrder,
        holeDelay,
        state.centerPull.side,
        sideOffset
      );
      holeTimes.set(holeId, baseNominal + rel);
    });
  });

  state.holes.filter((h) => h.rowId === null).forEach((h, i) => {
    holeTimes.set(h.id, (rowList.length + 1) * rowDelay + i * holeDelay);
  });

  const times = [...holeTimes.values()];
  const endTime = times.length ? Math.max(...times) : 0;
  const density8ms = maxHolesInWindow(times, 8);

  return { holeDelay, rowDelay, sideOffset, side: state.centerPull.side, holeTimes, times, endTime, density8ms };
}

export function solveTimingCombinations(state) {
  const holeValues = generateValues(state.timing.holeToHole.min, state.timing.holeToHole.max);
  const rowValues = generateValues(state.timing.rowToRow.min, state.timing.rowToRow.max);
  const sideValues = state.centerPull?.enabled
    ? generateValues(state.centerPull.offsetMinMs, state.centerPull.offsetMaxMs)
    : [0];

  const candidates = [];
  holeValues.forEach((hDelay) => {
    rowValues.forEach((rDelay) => {
      sideValues.forEach((sOffset) => {
        candidates.push(buildSchedule(state, hDelay, rDelay, sOffset));
      });
    });
  });

  candidates.sort((a, b) => {
    if (a.density8ms !== b.density8ms) return a.density8ms - b.density8ms;
    if (a.endTime !== b.endTime) return a.endTime - b.endTime;
    return (a.holeDelay + a.rowDelay + a.sideOffset) - (b.holeDelay + b.rowDelay + b.sideOffset);
  });

  return candidates.slice(0, 12);
}

export function formatTimingResult(result, index) {
  const sideText = result.sideOffset > 0 ? ` | ${result.side || "left"} offset ${result.sideOffset}ms` : "";
  return `${index + 1}. H2H ${result.holeDelay}ms | R2R ${result.rowDelay}ms${sideText} | peak in 8ms: ${result.density8ms} holes | total duration: ${result.endTime.toFixed(1)}ms`;
}
