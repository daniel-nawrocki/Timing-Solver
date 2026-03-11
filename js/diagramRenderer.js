const palette = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#0ea5e9", "#22c55e", "#f97316"];

function rowColor(rowId) {
  if (rowId === null || rowId === undefined) return "#334155";
  return palette[Math.abs(Number(rowId)) % palette.length];
}

export class DiagramRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onHoleClick = options.onHoleClick || (() => {});
    this.onHoleHover = options.onHoleHover || (() => {});
    this.onPointerUp = options.onPointerUp || (() => {});
    this.stateRef = options.stateRef;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.dragging = false;
    this.lastMouse = null;
    this.holeRadius = 5;

    this.resize();
    this.attachEvents();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(400, Math.floor(rect.width));
    this.canvas.height = Math.max(300, Math.floor(rect.height));
    this.render();
  }

  worldToScreen(x, y) {
    return {
      x: x * this.zoom + this.panX,
      y: this.canvas.height - (y * this.zoom + this.panY),
    };
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.panX) / this.zoom,
      y: (this.canvas.height - y - this.panY) / this.zoom,
    };
  }

  fitToData() {
    const holes = this.stateRef.holes;
    if (!holes.length) return;
    const xs = holes.map((h) => h.x);
    const ys = holes.map((h) => h.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const margin = 80;
    const scaleX = (this.canvas.width - margin) / width;
    const scaleY = (this.canvas.height - margin) / height;
    this.zoom = Math.max(0.02, Math.min(scaleX, scaleY));
    this.panX = -minX * this.zoom + margin / 2;
    this.panY = -minY * this.zoom + margin / 2;
    this.render();
  }

  drawGrid() {
    if (!this.stateRef.ui.showGrid) return;
    const ctx = this.ctx;
    const stepPx = 50;
    ctx.save();
    ctx.strokeStyle = "#edf2f7";
    ctx.lineWidth = 1;
    for (let x = this.panX % stepPx; x < this.canvas.width; x += stepPx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.canvas.height);
      ctx.stroke();
    }
    for (let y = this.panY % stepPx; y < this.canvas.height; y += stepPx) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.canvas.width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawNorthArrow() {
    const ctx = this.ctx;
    const x = this.canvas.width - 50;
    const y = 65;
    ctx.save();
    ctx.fillStyle = "#0f172a";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 20);
    ctx.lineTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y - 20);
    ctx.lineTo(x, y + 22);
    ctx.stroke();
    ctx.font = "bold 13px Segoe UI";
    ctx.fillText("N", x - 5, y + 38);
    ctx.restore();
  }

  drawInitiationLines() {
    const ctx = this.ctx;
    for (const path of this.stateRef.initiation.paths) {
      if (!path.holeIds || path.holeIds.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = path.direction === "reverse" ? "#b91c1c" : "#0b8f6d";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      path.holeIds.forEach((holeId, idx) => {
        const hole = this.stateRef.holesById.get(holeId);
        if (!hole) return;
        const p = this.worldToScreen(hole.x, hole.y);
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.restore();
    }
  }

  drawRowReferenceLinks() {
    const ctx = this.ctx;
    Object.values(this.stateRef.rows).forEach((row) => {
      if (!row.startReference) return;
      const refRow = this.stateRef.rows[row.startReference.referenceRow];
      const toHoleId = row.holeIds[0];
      const fromHoleId = refRow?.holeIds[row.startReference.referenceHoleIndex - 1];
      const fromHole = this.stateRef.holesById.get(fromHoleId);
      const toHole = this.stateRef.holesById.get(toHoleId);
      if (!fromHole || !toHole) return;
      const a = this.worldToScreen(fromHole.x, fromHole.y);
      const b = this.worldToScreen(toHole.x, toHole.y);
      ctx.save();
      ctx.strokeStyle = "#7c3aed";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    });
  }

  drawCenterPullHint() {
    const cp = this.stateRef.centerPull;
    if (!cp.enabled) return;
    const centerRow = this.stateRef.rows[cp.centerRowId];
    if (!centerRow?.holeIds?.length) return;

    const centerHole = this.stateRef.holesById.get(centerRow.holeIds[0]);
    if (!centerHole) return;

    const c = this.worldToScreen(centerHole.x, centerHole.y);
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#111827";
    ctx.font = "12px Segoe UI";
    ctx.fillText(`Center Pull: L ${cp.leftDelayMs}ms | R ${cp.rightDelayMs}ms`, 14, 22);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(c.x - 28, c.y);
    ctx.lineTo(c.x + 28, c.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawHoles() {
    const ctx = this.ctx;
    for (const hole of this.stateRef.holes) {
      const p = this.worldToScreen(hole.x, hole.y);
      const selected = this.stateRef.selection.has(hole.id);
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.holeRadius, 0, Math.PI * 2);
      ctx.fillStyle = rowColor(hole.rowId);
      ctx.fill();
      ctx.lineWidth = selected ? 3 : 1;
      ctx.strokeStyle = selected ? "#0f172a" : "#dbe4ee";
      ctx.stroke();

      const label = (hole.rowId !== null && hole.orderInRow !== null)
        ? `${hole.rowId}-${hole.orderInRow}`
        : (hole.holeNumber || hole.id);
      ctx.fillStyle = "#111827";
      ctx.font = selected ? "bold 11px Segoe UI" : "11px Segoe UI";
      ctx.fillText(label, p.x + 8, p.y - 6);
    }
  }

  drawRowLabels() {
    const ctx = this.ctx;
    Object.values(this.stateRef.rows).forEach((row) => {
      if (!row.holeIds?.length) return;
      let sx = 0;
      let sy = 0;
      let count = 0;
      row.holeIds.forEach((id) => {
        const h = this.stateRef.holesById.get(id);
        if (!h) return;
        sx += h.x;
        sy += h.y;
        count += 1;
      });
      if (!count) return;
      const c = this.worldToScreen(sx / count, sy / count);
      ctx.save();
      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 12px Segoe UI";
      ctx.fillText(`Row ${row.id}`, c.x - 18, c.y - 12);
      ctx.restore();
    });
  }

  drawRowAssignPath() {
    const ids = this.stateRef.ui.rowAssignPath || [];
    if (ids.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "#0369a1";
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ids.forEach((id, idx) => {
      const hole = this.stateRef.holesById.get(id);
      if (!hole) return;
      const p = this.worldToScreen(hole.x, hole.y);
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render() {
    this.clear();
    this.drawGrid();
    this.drawRowReferenceLinks();
    this.drawInitiationLines();
    this.drawRowAssignPath();
    this.drawHoles();
    this.drawRowLabels();
    this.drawCenterPullHint();
    this.drawNorthArrow();
  }

  findHoleAtScreen(x, y) {
    for (const hole of this.stateRef.holes) {
      const p = this.worldToScreen(hole.x, hole.y);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= this.holeRadius + 4) return hole;
    }
    return null;
  }

  attachEvents() {
    this.canvas.addEventListener("mousedown", (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const hole = this.findHoleAtScreen(x, y);

      if (hole) {
        this.onHoleClick(hole, ev);
      } else {
        this.dragging = true;
        this.lastMouse = { x: ev.clientX, y: ev.clientY };
      }
    });

    window.addEventListener("mousemove", (ev) => {
      if (!this.dragging || !this.lastMouse) return;
      const dx = ev.clientX - this.lastMouse.x;
      const dy = ev.clientY - this.lastMouse.y;
      this.panX += dx;
      this.panY -= dy;
      this.lastMouse = { x: ev.clientX, y: ev.clientY };
      this.render();
    });

    window.addEventListener("mouseup", () => {
      this.dragging = false;
      this.lastMouse = null;
      this.onPointerUp();
    });

    this.canvas.addEventListener("mousemove", (ev) => {
      if ((ev.buttons & 1) !== 1) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const hole = this.findHoleAtScreen(x, y);
      if (hole) this.onHoleHover(hole, ev);
    });

    this.canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = ev.clientX - rect.left;
      const mouseY = ev.clientY - rect.top;
      const worldBefore = this.screenToWorld(mouseX, mouseY);
      const factor = ev.deltaY < 0 ? 1.1 : 0.9;
      this.zoom = Math.max(0.01, Math.min(300, this.zoom * factor));
      const worldAfter = this.screenToWorld(mouseX, mouseY);
      this.panX += (worldAfter.x - worldBefore.x) * this.zoom;
      this.panY += (worldAfter.y - worldBefore.y) * this.zoom;
      this.render();
    }, { passive: false });
  }
}
