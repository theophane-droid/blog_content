import { state } from "./state.js";
import { el, log } from "./dom.js";
import { api, saveGraphMetadata } from "./api.js";
import { applyCaptions, applyStyle } from "./style.js";
import { updateSelection } from "./interactions.js";
import { currentTimeParams, expandNode, loadEventDetails, loadPairEvents } from "./event-graph.js";

const COLOR_PALETTE = ["#00f5d4", "#8b949e", "#6e7681", "#d29922", "#da3633", "#f0f6fc", "#30363d"];

function graphKind(ele) {
  return ele.isNode() ? "node" : "edge";
}

function graphId(ele) {
  const data = ele.data();
  return data.elementId || data.neo4jId || data.identity || data.id;
}

function contextMenu() {
  return el("graphContextMenu");
}

function colorInput() {
  return el("contextColorInput");
}

export function hideContextMenu() {
  contextMenu()?.classList.add("hidden");
  state.contextTarget = null;
}

function copyToClipboard(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  document.execCommand("copy");
  area.remove();
  return Promise.resolve();
}

async function updateMetadata(ele, patch) {
  const kind = graphKind(ele);
  const id = graphId(ele);
  if (!id) throw new Error("Missing graph element id.");
  await saveGraphMetadata(kind, id, patch);
  const props = { ...(ele.data("properties") || {}) };
  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    ele.data("note", patch.note || "");
    props.__graph_note = patch.note || "";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "color")) {
    ele.data("customColor", patch.color || "");
    props.__graph_color = patch.color || "";
  }
  ele.data("properties", props);
  applyCaptions();
  applyStyle();
  updateSelection(ele);
}

function openNoteModal(initialValue = "") {
  return new Promise((resolve) => {
    const existing = document.querySelector(".note-modal-backdrop");
    existing?.remove();

    const backdrop = document.createElement("div");
    backdrop.className = "note-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "note-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "noteModalTitle");

    const title = document.createElement("h3");
    title.id = "noteModalTitle";
    title.textContent = "Persistent note";

    const subtitle = document.createElement("p");
    subtitle.textContent = "Stored in Neo4j metadata for this graph element.";

    const textarea = document.createElement("textarea");
    textarea.className = "note-modal-textarea";
    textarea.value = initialValue;
    textarea.placeholder = "Write an investigation note…";

    const footer = document.createElement("div");
    footer.className = "note-modal-footer";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "note-modal-button";
    cancel.textContent = "Cancel";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "note-modal-button note-modal-save";
    save.textContent = "Save note";

    footer.append(cancel, save);
    modal.append(title, subtitle, textarea, footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = (value) => {
      document.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        close(null);
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        close(textarea.value);
      }
    };

    cancel.addEventListener("click", () => close(null));
    save.addEventListener("click", () => close(textarea.value));

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });

    document.addEventListener("keydown", onKeyDown);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  });
}
async function editNote() {
  const ele = state.contextTarget;

  if (!ele?.length) {
    log("No graph element selected", "error");
    return;
  }

  const current =
    ele.data("note") ||
    ele.data("properties")?.__graph_note ||
    "";

  const next = await openNoteModal(current);

  if (next === null) return;

  const note = next.trim();

  await updateMetadata(ele, { note });

  log(note ? "Note saved" : "Note cleared", "ok");
}

async function clearNote() {
  const ele = state.contextTarget;
  if (!ele?.length) return;
  await updateMetadata(ele, { note: "" });
  log("Note removed", "ok");
}

async function setNodeColor(color) {
  const ele = state.contextTarget;
  if (!ele?.length || !ele.isNode()) return;
  await updateMetadata(ele, { color });
  log("Node color saved", "ok");
}

async function copyElement() {
  const ele = state.contextTarget;
  if (!ele?.length) return;
  await copyToClipboard(ele.data());
  log(`${ele.isNode() ? "Node" : "Edge"} copied to clipboard`, "ok");
}

function hideNode() {
  const ele = state.contextTarget;
  if (!ele?.length || !ele.isNode()) return;
  const label = ele.data("caption") || ele.data("label") || ele.id();
  ele.hide();
  updateSelection(null);
  log(`Node hidden: ${label}`, "ok");
}

function showHiddenNodes() {
  if (!state.cy) return;
  const hidden = state.cy.elements(":hidden");
  hidden.show();
  log(`${hidden.length} hidden graph element(s) restored`, "ok");
}

function fmt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString("fr-FR") : String(value || "0");
}

function fmtDate(value) {
  if (!value) return "n/a";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toLocaleString("fr-FR");
}

function renderList(items, renderItem) {
  if (!items?.length) return `<div class="node-stats-empty">No data</div>`;
  return items.map(renderItem).join("");
}

function renderStaticTimeline(timeline = {}) {
  const buckets = timeline.buckets || [];
  if (!buckets.length) return `<div class="node-stats-empty">No timeline data</div>`;
  const max = buckets.reduce((m, b) => Math.max(m, Number(b.count || 0)), 1);
  const bars = buckets.map((bucket) => {
    const count = Number(bucket.count || 0);
    const height = count > 0 ? Math.max(4, Math.round((count / max) * 42)) : 0;
    const date = fmtDate(bucket.bucket);
    return `<span class="node-stats-timeline-bucket${count <= 0 ? " empty" : ""}" style="height:${height}px" title="${date} · ${fmt(count)} events"></span>`;
  }).join("");
  return `<div class="node-stats-timeline" aria-label="Node event timeline">${bars}</div>`;
}

function openNodeStatsModal(payload) {
  const existing = document.querySelector(".node-stats-backdrop");
  existing?.remove();

  const summary = payload.summary || {};
  const backdrop = document.createElement("div");
  backdrop.className = "node-stats-backdrop";
  backdrop.innerHTML = `
    <section class="node-stats-modal" role="dialog" aria-modal="true" aria-labelledby="nodeStatsTitle">
      <header class="node-stats-header">
        <div>
          <h3 id="nodeStatsTitle">Node statistics</h3>
          <p>${summary.node || "selected node"}</p>
        </div>
        <button type="button" class="node-stats-close" aria-label="Close">×</button>
      </header>

      <div class="node-stats-grid">
        <div><strong>${fmt(summary.total_events)}</strong><span>Total events</span></div>
        <div><strong>${fmt(summary.outbound_events)}</strong><span>Outbound</span></div>
        <div><strong>${fmt(summary.inbound_events)}</strong><span>Inbound</span></div>
        <div><strong>${fmt(summary.total_neighbors)}</strong><span>Neighbors</span></div>
      </div>

      <div class="node-stats-meta">
        <div><span>First seen</span><strong>${fmtDate(summary.first_seen)}</strong></div>
        <div><span>Last seen</span><strong>${fmtDate(summary.last_seen)}</strong></div>
      </div>

      <section class="node-stats-timeline-section">
        <h4>Event timeline</h4>
        ${renderStaticTimeline(payload.timeline)}
      </section>

      <div class="node-stats-columns">
        <section>
          <h4>Top neighbors</h4>
          ${renderList(payload.topNeighbors, (item) => `
            <article class="node-stats-row">
              <strong>${item.neighbor}</strong>
              <span>${item.direction} · ${fmt(item.events)} events · ${fmt(item.bytes)} bytes</span>
              <small>${[...(item.services || []), ...(item.ports || [])].filter(Boolean).join(" · ") || "n/a"}</small>
            </article>`)}
        </section>
        <section>
          <h4>Top ports / services</h4>
          ${renderList(payload.topPorts, (item) => `
            <article class="node-stats-row">
              <strong>${item.port ?? "unknown"}</strong>
              <span>${item.service || "unknown service"} · ${item.proto || "unknown proto"}</span>
              <small>${fmt(item.events)} events</small>
            </article>`)}
        </section>
      </div>
    </section>
  `;

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    backdrop.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };

  backdrop.querySelector(".node-stats-close")?.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKeyDown);
  document.body.appendChild(backdrop);
}

async function showNodeStats() {
  const ele = state.contextTarget;
  if (!ele?.length || !ele.isNode()) return;
  const query = currentTimeParams();
  const payload = await api(`/api/graph/node/${encodeURIComponent(ele.id())}/stats?${query}`);
  openNodeStatsModal(payload);
}

function renderColorButtons(menu) {
  const wrap = menu.querySelector("[data-context-colors]");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const color of COLOR_PALETTE) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-color-swatch";
    button.style.backgroundColor = color;
    button.title = color;
    button.addEventListener("click", async () => {
      try { await setNodeColor(color); hideContextMenu(); }
      catch (e) { log(e.message, "error"); }
    });
    wrap.appendChild(button);
  }
}

export function createContextMenu() {
  if (contextMenu()) return;
  const menu = document.createElement("div");
  menu.id = "graphContextMenu";
  menu.className = "graph-context-menu hidden";
  menu.innerHTML = `
    <div class="context-section context-background-only">
      <div class="context-section-title">Map</div>
      <button type="button" data-context-action="show-hidden">Show hidden nodes</button>
    </div>

    <div class="context-section context-node-only">
      <div class="context-section-title">Investigate</div>
      <button type="button" data-context-action="node-stats">Statistics</button>
      <button type="button" class="context-entity-only" data-context-action="expand-neighbors">Expand neighbors</button>
      <button type="button" class="context-entity-only" data-context-action="outbound-events">Outbound events</button>
      <button type="button" class="context-entity-only" data-context-action="inbound-events">Inbound events</button>
      <button type="button" class="context-event-only" data-context-action="event-details">Event details</button>
    </div>

    <div class="context-section context-edge-only">
      <div class="context-section-title">Edge</div>
      <button type="button" data-context-action="underlying-events">Underlying events</button>
    </div>

    <div class="context-section context-element-only">
      <div class="context-section-title">Annotate</div>
      <button type="button" data-context-action="note">Add / edit note</button>
      <button type="button" data-context-action="clear-note">Clear note</button>
    </div>

    <div class="context-section context-node-only">
      <div class="context-section-title">Visual</div>
      <div class="context-color-grid" data-context-colors></div>
      <button type="button" data-context-action="custom-color">Custom color…</button>
      <button type="button" data-context-action="reset-color">Reset color</button>
      <button type="button" data-context-action="hide-node">Hide node</button>
    </div>

    <div class="context-section context-element-only">
      <div class="context-section-title">Data</div>
      <button type="button" data-context-action="copy">Copy JSON</button>
    </div>
  `;
  document.body.appendChild(menu);

  const input = document.createElement("input");
  input.id = "contextColorInput";
  input.type = "color";
  input.className = "context-color-input";
  document.body.appendChild(input);

  renderColorButtons(menu);

  menu.addEventListener("click", async (e) => {
    e.stopPropagation();

    const action = e.target.closest("[data-context-action]")?.dataset.contextAction;
    if (!action) return;

    try {
      if (action === "copy") await copyElement();
      if (action === "expand-neighbors") await expandNode(state.contextTarget, "both");
      if (action === "outbound-events") await expandNode(state.contextTarget, "outbound");
      if (action === "inbound-events") await expandNode(state.contextTarget, "inbound");
      if (action === "event-details") await loadEventDetails(state.contextTarget);
      if (action === "underlying-events") await loadPairEvents(state.contextTarget);
      if (action === "node-stats") await showNodeStats();
      if (action === "hide-node") hideNode();
      if (action === "show-hidden") showHiddenNodes();
      if (action === "note") await editNote();
      if (action === "clear-note") await clearNote();
      if (action === "custom-color") colorInput().click();
      if (action === "reset-color") await setNodeColor("");

      if (action !== "custom-color") hideContextMenu();
    } catch (err) {
      log(err.message, "error");
    }
  });

  input.addEventListener("input", async () => {
    try { await setNodeColor(input.value); hideContextMenu(); }
    catch (err) { log(err.message, "error"); }
  });

  window.addEventListener("click", (e) => {
    if (e.target.closest(".note-modal-backdrop") || e.target.closest(".node-stats-backdrop")) return;
    if (!contextMenu()?.contains(e.target)) hideContextMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
}

function positionContextMenu(menu, renderedPosition) {
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 240, renderedPosition.x + 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - 320, renderedPosition.y + 12))}px`;
  menu.classList.remove("hidden");
}

export function showCanvasContextMenu(renderedPosition) {
  createContextMenu();
  state.contextTarget = null;
  const menu = contextMenu();
  menu.querySelectorAll(".context-background-only").forEach((item) => item.classList.remove("hidden"));
  menu.querySelectorAll(".context-element-only, .context-node-only, .context-entity-only, .context-event-only, .context-edge-only").forEach((item) => item.classList.add("hidden"));
  menu.setAttribute("aria-label", "Map context menu");
  positionContextMenu(menu, renderedPosition);
}

export function showContextMenu(ele, renderedPosition) {
  createContextMenu();
  state.contextTarget = ele;
  updateSelection(ele);

  const menu = contextMenu();
  const isNode = ele.isNode();
  const isEvent = isNode && ele.hasClass("event");
  const isVirtualEdge = ele.isEdge() && ele.data("isVirtual");
  menu.querySelectorAll(".context-background-only").forEach((item) => item.classList.add("hidden"));
  menu.querySelectorAll(".context-element-only").forEach((item) => item.classList.remove("hidden"));
  menu.querySelectorAll(".context-node-only").forEach((item) => item.classList.toggle("hidden", !isNode));
  menu.querySelectorAll(".context-entity-only").forEach((item) => item.classList.toggle("hidden", !isNode || isEvent));
  menu.querySelectorAll(".context-event-only").forEach((item) => item.classList.toggle("hidden", !isEvent));
  menu.querySelectorAll(".context-edge-only").forEach((item) => item.classList.toggle("hidden", !isVirtualEdge));
  const data = ele.data();
  const title = `${isNode ? "Node" : "Edge"} · ${data.caption || data.type || data.id}`;
  menu.setAttribute("aria-label", title);
  positionContextMenu(menu, renderedPosition);
}
