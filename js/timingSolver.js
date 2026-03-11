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

function rowBaseTime(row, rowsById, rowBases, holeTimes, rowDelay) {
  if (row.startReference) {
    const refRow = rowsById[row.startReference.referenceRow];
    if (refRow?.holeIds?.length) {
      const refHoleId = refRow.holeIds[row.startReference.referenceHoleIndex - 1] || refRow.holeIds[0];
      const refTime = holeTimes.get(refHoleId) ?? 0;
      return refTime + rowDelay;
    }
  }
  const previousBases = [...rowBases.values()];
  if (!previousBases.length) return 0;
  return Math.max(...previousBases) + rowDelay;
}

function centerPullOffset(centerPull, rowId) {
  if (!centerPull?.enabled) return 0;
  const diff = Number(rowId) - Number(centerPull.centerRowId);
  if (diff < 0) return Math.abs(diff) * Number(centerPull.leftDelayMs || 0);
  if (diff > 0) return Math.abs(diff) * Number(centerPull.rightDelayMs || 0);
  return 0;
}

function buildSchedule(state, holeDelay, rowDelay) {
  const rowList = Object.values(state.rows).sort((a, b) => a.rowOrder - b.rowOrder);
  const rowBases = new Map();
  const holeTimes = new Map();

  rowList.forEach((row) => {
    const base = rowBaseTime(row, state.rows, rowBases, holeTimes, rowDelay) + centerPullOffset(state.centerPull, row.id);
    rowBases.set(row.id, base);
    row.holeIds.forEach((holeId, idx) => {
      holeTimes.set(holeId, base + idx * holeDelay);
    });
  });

  // Unassigned holes still get a late fallback so they are included in density calculations.
  state.holes.filter((h) => h.rowId === null).forEach((h, i) => {
    holeTimes.set(h.id, (rowList.length + 1) * rowDelay + i * holeDelay);
  });

  const times = [...holeTimes.values()];
  const endTime = times.length ? Math.max(...times) : 0;
  const density8ms = maxHolesInWindow(times, 8);

  return { holeDelay, rowDelay, holeTimes, times, endTime, density8ms };
}

export function solveTimingCombinations(state) {
  const holeValues = generateValues(state.timing.holeToHole.min, state.timing.holeToHole.max);
  const rowValues = generateValues(state.timing.rowToRow.min, state.timing.rowToRow.max);
  const candidates = [];

  holeValues.forEach((hDelay) => {
    rowValues.forEach((rDelay) => {
      candidates.push(buildSchedule(state, hDelay, rDelay));
    });
  });

  candidates.sort((a, b) => {
    if (a.density8ms !== b.density8ms) return a.density8ms - b.density8ms;
    if (a.endTime !== b.endTime) return a.endTime - b.endTime;
    return (a.holeDelay + a.rowDelay) - (b.holeDelay + b.rowDelay);
  });

  return candidates.slice(0, 12);
}

export function formatTimingResult(result, index) {
  return `${index + 1}. H2H ${result.holeDelay}ms | R2R ${result.rowDelay}ms | peak in 8ms: ${result.density8ms} holes | total duration: ${result.endTime.toFixed(1)}ms`;
}