import express from "express";
import neo4j from "neo4j-driver";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.PORT || 3000);
const neo4jUri = process.env.NEO4J_URI || "bolt://neo4j:7687";
const neo4jUser = process.env.NEO4J_USERNAME || "neo4j";
const neo4jPassword = process.env.NEO4J_PASSWORD || "change-me-strong-password";
const neo4jDatabase = process.env.NEO4J_DATABASE || "neo4j";

const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));

const GRAPH_NOTE_PROPERTY = "__graph_note";
const GRAPH_COLOR_PROPERTY = "__graph_color";
const TIMELINE_TARGET_BUCKETS = Math.max(30, Math.min(500, Number(process.env.GRAPH_TIMELINE_TARGET_BUCKETS || 100)));

const presets = [
  {
    id: "event_aggregate",
    name: "Network event aggregate view",
    cypher: "Use the event explorer toolbar: Aggregate",
    params: { limit: 500 }
  },
  {
    id: "event_detailed_recent",
    name: "Network detailed events",
    cypher: "MATCH p=(src)-[:SRC_OF]->(e)-[:DST_TO]->(dst) WHERE e.ts_datetime IS NOT NULL RETURN p ORDER BY e.ts_datetime DESC LIMIT $limit",
    params: { limit: 150 }
  },
  {
    id: "manual_sample",
    name: "Manual sample graph",
    cypher: "MATCH p=(n)-[r]->(m) RETURN p LIMIT $limit",
    params: { limit: 200 }
  }
];

const graphConfig = {
  entityLabel: process.env.GRAPH_ENTITY_LABEL || "",
  eventLabel: process.env.GRAPH_EVENT_LABEL || "",
  aggregateModes: [
    { id: "pair", label: "Source → Destination", groupFields: ["source", "target"] },
    { id: "hour", label: "Source → Destination + hour bucket", groupFields: ["source", "target", "hour"] }
  ],
  widthMetrics: [
    { id: "event_count", label: "event count" },
    { id: "total_bytes", label: "total bytes" },
    { id: "total_duration", label: "total duration" },
    { id: "unique_services", label: "unique services" },
    { id: "unique_ports", label: "unique destination ports" }
  ]
};

function toNative(value) {
  if (neo4j.isInt(value)) {
    const asNumber = value.toNumber();
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toNative);
  }
  if (value && typeof value === "object") {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (["DateTime", "LocalDateTime", "Date", "Time", "LocalTime", "Duration"].includes(value.constructor?.name) && typeof value.toString === "function") {
      return value.toString();
    }
    const converted = {};
    for (const [key, item] of Object.entries(value)) {
      converted[key] = toNative(item);
    }
    return converted;
  }
  return value;
}

function toCypherParam(value) {
  if (Number.isInteger(value)) {
    return neo4j.int(value);
  }
  if (Array.isArray(value)) {
    return value.map(toCypherParam);
  }
  if (value && typeof value === "object") {
    const converted = {};
    for (const [key, item] of Object.entries(value)) {
      converted[key] = toCypherParam(item);
    }
    return converted;
  }
  return value;
}

function entityId(entity) {
  if (!entity) return "";
  if (entity.elementId) return entity.elementId;
  if (entity.identity) return entity.identity.toString();
  return "";
}

function isNode(value) {
  return value && Array.isArray(value.labels) && value.properties;
}

function isRelationship(value) {
  return value && typeof value.type === "string" && value.properties;
}

function isPath(value) {
  return value && Array.isArray(value.segments);
}

function nodeCaption(properties, labels) {
  return (
    properties.caption ||
    properties.display ||
    properties.name ||
    properties.value ||
    properties.id ||
    labels.join(":") ||
    "node"
  );
}

function edgeCaption(properties, type) {
  return properties.caption || properties.display || properties.name || properties.count || type;
}

function safeLabel(label, fallback = "") {
  const value = String(label || fallback || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid Neo4j label: ${value}`);
  return value;
}

function asLimit(value, fallback = 500, max = 2000) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

function dateWhere(alias, params, clauses) {
  if (params.from) clauses.push(`${alias}.ts_datetime >= datetime($from)`);
  if (params.to) clauses.push(`${alias}.ts_datetime <= datetime($to)`);
}

function labelPattern(alias, label) {
  const value = String(label || "").trim();
  if (!value || value === "__any") return alias;
  return `${alias}:${safeLabel(value)}`;
}

function safePropertyKey(key, fallback = "") {
  const value = String(key || fallback || "").trim();
  if (!value) return "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid property key: ${value}`);
  return value;
}

function parseJsonObject(value, label = "JSON") {
  const raw = String(value || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function assertReadOnlyWhereFragment(fragment) {
  const value = String(fragment || "").trim();
  if (!value) return "";
  if (value.length > 2000) throw new Error("Custom event filter is too long.");
  if (/[;]/.test(value)) throw new Error("Custom event filter must be a WHERE expression, not a full Cypher statement.");
  if (/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|CALL|LOAD\s+CSV|UNWIND|RETURN|MATCH|WITH|LIMIT|ORDER\s+BY|SKIP|UNION)\b/i.test(value)) {
    throw new Error("Custom event filter must contain only a boolean WHERE expression using src, dst and e.");
  }
  return value;
}

function eventFilters(reqQuery, params, clauses) {
  const field = safePropertyKey(reqQuery.filterField || "");
  const value = String(reqQuery.filterValue || "").trim();
  if (field && value) {
    clauses.push(`toString(e.${field}) = $filterValue`);
    params.filterValue = value;
  }
  const search = String(reqQuery.eventSearch || "").trim();
  if (search) {
    clauses.push(`any(k IN keys(e) WHERE toString(e[k]) CONTAINS $eventSearch)`);
    params.eventSearch = search;
  }
  const customWhere = assertReadOnlyWhereFragment(reqQuery.eventWhere || reqQuery.cypherFilter || "");
  if (customWhere) {
    clauses.push(`(${customWhere})`);
  }
}

function cyNodeId(label, value) {
  return `${label}:${String(value)}`;
}

function cyEventId(eventId) {
  return `EVENT:${String(eventId)}`;
}

function eventType(labels = []) {
  return labels.find((label) => /Event$/i.test(label)) || labels[0] || "Event";
}

function isPrivateIp(value = "") {
  const v = String(value);
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(v) || v === "127.0.0.1" || v === "::1";
}

function bytesLabel(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

function virtualWidth(value, maxValue) {
  const v = Number(value || 0);
  const max = Math.max(1, Number(maxValue || 1));
  return Math.max(1.2, Math.min(11, 1.2 + Math.log1p(v) / Math.log1p(max) * 9.8));
}

function mapEntityNode(label, value, role = "", options = {}) {
  const id = cyNodeId(label, value);
  const properties = { value, role, ...(options.properties || {}) };
  const classes = ["entity", String(label).toLowerCase(), role, isPrivateIp(value) ? "internal" : "external"].filter(Boolean).join(" ");
  return {
    data: {
      id,
      elementId: options.elementId || "",
      label: String(value),
      caption: String(value),
      type: label,
      value: String(value),
      note: options.note || properties[GRAPH_NOTE_PROPERTY] || "",
      customColor: options.color || properties[GRAPH_COLOR_PROPERTY] || "",
      properties
    },
    classes
  };
}

function aggregateMode(mode) {
  return graphConfig.aggregateModes.find((item) => item.id === mode) || graphConfig.aggregateModes[0];
}

function widthMetric(metric) {
  return graphConfig.widthMetrics.some((item) => item.id === metric) ? metric : "event_count";
}

function selectEventLabel(labels = []) {
  return labels.find((label) => /Event$/i.test(label)) || labels[0] || "Event";
}

function serializeDateTime(value) {
  return toNative(value);
}

function addNode(nodes, node) {
  const id = entityId(node);
  if (!id || nodes.has(id)) return id;
  const properties = toNative(node.properties || {});
  nodes.set(id, {
    data: {
      id,
      elementId: id,
      labels: node.labels,
      label: node.labels[0] || "Node",
      caption: String(nodeCaption(properties, node.labels)),
      note: properties[GRAPH_NOTE_PROPERTY] || "",
      customColor: properties[GRAPH_COLOR_PROPERTY] || "",
      properties
    }
  });
  return id;
}

function addRelationship(edges, relationship, sourceId, targetId) {
  const id = entityId(relationship);
  if (!id || edges.has(id) || !sourceId || !targetId) return;
  const properties = toNative(relationship.properties || {});
  edges.set(id, {
    data: {
      id,
      elementId: id,
      source: sourceId,
      target: targetId,
      type: relationship.type,
      caption: String(edgeCaption(properties, relationship.type)),
      note: properties[GRAPH_NOTE_PROPERTY] || "",
      properties
    }
  });
}

function extractGraph(value, nodes, edges) {
  if (!value) return;
  if (isPath(value)) {
    for (const segment of value.segments) {
      const sourceId = addNode(nodes, segment.start);
      const targetId = addNode(nodes, segment.end);
      addRelationship(edges, segment.relationship, sourceId, targetId);
    }
    return;
  }
  if (isNode(value)) {
    addNode(nodes, value);
    return;
  }
  if (isRelationship(value)) {
    const sourceId = value.startNodeElementId || value.start?.toString?.();
    const targetId = value.endNodeElementId || value.end?.toString?.();
    addRelationship(edges, value, sourceId, targetId);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractGraph(item, nodes, edges);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) extractGraph(item, nodes, edges);
  }
}

function recordToObject(record) {
  const row = {};
  for (const key of record.keys) {
    row[key] = toNative(record.get(key));
  }
  return row;
}

async function readQuery(cypher, params = {}) {
  const session = driver.session({ database: neo4jDatabase, defaultAccessMode: neo4j.session.READ });
  try {
    return await session.executeRead((tx) => tx.run(cypher, toCypherParam(params)));
  } finally {
    await session.close();
  }
}

async function writeQuery(cypher, params = {}) {
  const session = driver.session({ database: neo4jDatabase, defaultAccessMode: neo4j.session.WRITE });
  try {
    return await session.executeWrite((tx) => tx.run(cypher, toCypherParam(params)));
  } finally {
    await session.close();
  }
}

function chooseRoundedTimeStep(fromValue, toValue, targetBuckets = TIMELINE_TARGET_BUCKETS) {
  const from = new Date(String(fromValue || ""));
  const to = new Date(String(toValue || ""));
  const fallback = { ms: 60 * 60 * 1000, label: "1h" };
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || to <= from) return fallback;
  const bucketTarget = Math.max(30, Math.min(500, Number(targetBuckets || TIMELINE_TARGET_BUCKETS)));
  const target = (to.getTime() - from.getTime()) / bucketTarget;
  const steps = [
    [1000, "1s"], [5000, "5s"], [10000, "10s"], [30000, "30s"],
    [60000, "1m"], [5 * 60000, "5m"], [15 * 60000, "15m"], [30 * 60000, "30m"],
    [60 * 60000, "1h"], [3 * 60 * 60000, "3h"], [6 * 60 * 60000, "6h"], [12 * 60 * 60000, "12h"],
    [24 * 60 * 60000, "1d"], [7 * 24 * 60 * 60000, "7d"], [30 * 24 * 60 * 60000, "30d"]
  ];
  const minBuckets = 30;
  const maxStepForMinimumBars = (to.getTime() - from.getTime()) / minBuckets;
  const candidates = steps.filter(([ms]) => ms <= maxStepForMinimumBars);
  const selected = (candidates.find(([ms]) => ms >= target) || candidates[candidates.length - 1] || steps[0]);
  return { ms: selected[0], label: selected[1] };
}

function relationKeyFromRecord(row) {
  return `${row.source_label || "Entity"}:${row.source}->${row.target_label || row.source_label || "Entity"}:${row.target}`;
}

async function readAnnotations(kind, ids) {
  const cleanIds = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!cleanIds.length) return new Map();
  const result = await readQuery(`
    MATCH (a:GraphUiAnnotation)
    WHERE a.kind = $kind AND a.id IN $ids
    RETURN a.id AS id, a.note AS note, a.color AS color
  `, { kind, ids: cleanIds });
  const map = new Map();
  for (const row of result.records.map(recordToObject)) map.set(String(row.id), row);
  return map;
}

async function applyGraphAnnotations(graph) {
  const nodeIds = graph.nodes.map((item) => item.data?.elementId || item.data?.id).filter(Boolean);
  const edgeIds = graph.edges.map((item) => item.data?.elementId || item.data?.id).filter(Boolean);
  const [nodeAnnotations, edgeAnnotations] = await Promise.all([
    readAnnotations("node", nodeIds),
    readAnnotations("edge", edgeIds)
  ]);
  for (const item of graph.nodes) {
    const data = item.data || {};
    const ann = nodeAnnotations.get(String(data.elementId || data.id));
    if (!ann) continue;
    data.note = ann.note || data.note || "";
    data.customColor = ann.color || data.customColor || "";
    data.properties = { ...(data.properties || {}), __graph_note: data.note, __graph_color: data.customColor };
  }
  for (const item of graph.edges) {
    const data = item.data || {};
    const ann = edgeAnnotations.get(String(data.elementId || data.id));
    if (!ann) continue;
    data.note = ann.note || data.note || "";
    data.customColor = ann.color || data.customColor || "";
    data.properties = { ...(data.properties || {}), __graph_note: data.note, __graph_color: data.customColor };
  }
  return graph;
}

async function writeAnnotation(kind, id, body) {
  const sets = ["a.updated_at = datetime()"];
  const removes = [];
  const params = { kind, id };
  if (Object.prototype.hasOwnProperty.call(body, "note")) {
    const note = String(body.note || "").trim();
    if (note) { sets.push("a.note = $note"); params.note = note; }
    else removes.push("a.note");
  }
  if (Object.prototype.hasOwnProperty.call(body, "color")) {
    const color = String(body.color || "").trim();
    if (color) {
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid color. Expected #RRGGBB.");
      sets.push("a.color = $color"); params.color = color;
    } else removes.push("a.color");
  }
  if (sets.length === 1 && !removes.length) throw new Error("No metadata field provided.");
  const removeClause = removes.length ? ` REMOVE ${removes.join(", ")}` : "";
  await writeQuery(`
    MERGE (a:GraphUiAnnotation {kind: $kind, id: $id})
    ON CREATE SET a.created_at = datetime()
    SET ${sets.join(", ")}
    ${removeClause}
    RETURN a.id AS id
  `, params);
}

function metadataSetClauses(alias, body) {
  const sets = [];
  const removes = [];
  const params = {};

  if (Object.prototype.hasOwnProperty.call(body, "note")) {
    const note = String(body.note || "").trim();
    if (note) {
      sets.push(`${alias}.${GRAPH_NOTE_PROPERTY} = $note`);
      params.note = note;
    } else {
      removes.push(`${alias}.${GRAPH_NOTE_PROPERTY}`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "color")) {
    const color = String(body.color || "").trim();
    if (color) {
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid color. Expected #RRGGBB.");
      sets.push(`${alias}.${GRAPH_COLOR_PROPERTY} = $color`);
      params.color = color;
    } else {
      removes.push(`${alias}.${GRAPH_COLOR_PROPERTY}`);
    }
  }

  if (!sets.length && !removes.length) throw new Error("No metadata field provided.");
  const cypher = [
    sets.length ? `SET ${sets.join(", ")}` : "",
    removes.length ? `REMOVE ${removes.join(", ")}` : ""
  ].filter(Boolean).join(" ");
  return { cypher, params };
}

app.use("/vendor/cytoscape", express.static(path.join(__dirname, "node_modules/cytoscape/dist")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ ok: true, neo4jUri, database: neo4jDatabase });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/api/presets", (_req, res) => {
  res.json({ presets });
});

app.get("/api/schema", async (_req, res) => {
  try {
    const [labels, relationships, properties] = await Promise.all([
      readQuery("CALL db.labels() YIELD label RETURN collect(label) AS values"),
      readQuery("CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS values"),
      readQuery("CALL db.propertyKeys() YIELD propertyKey RETURN collect(propertyKey) AS values")
    ]);
    res.json({
      labels: labels.records[0]?.get("values") || [],
      relationshipTypes: relationships.records[0]?.get("values") || [],
      propertyKeys: properties.records[0]?.get("values") || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/query", async (req, res) => {
  const cypher = String(req.body.cypher || "").trim();
  const params = req.body.params && typeof req.body.params === "object" ? req.body.params : {};
  if (!cypher) {
    res.status(400).json({ error: "Cypher query is required." });
    return;
  }

  try {
    const result = await readQuery(cypher, params);
    const nodes = new Map();
    const edges = new Map();
    for (const record of result.records) {
      for (const key of record.keys) {
        extractGraph(record.get(key), nodes, edges);
      }
    }
    res.json({
      graph: {
        nodes: [...nodes.values()],
        edges: [...edges.values()]
      },
      table: {
        columns: result.records[0]?.keys || [],
        rows: result.records.map(recordToObject)
      },
      summary: {
        nodes: nodes.size,
        edges: edges.size,
        rows: result.records.length
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


app.get("/api/graph/config", async (_req, res) => {
  try {
    const discovery = await discoverGraphShape();
    res.json({ ...graphConfig, ...discovery });
  } catch (error) {
    res.json({ ...graphConfig, discoveryError: error.message });
  }
});

async function discoverGraphShape() {
  const [entityLabels, eventLabels, eventFields, bounds, samples] = await Promise.all([
    readQuery(`
      MATCH (src)-[:SRC_OF]->(e)-[:DST_TO]->(dst)
      WITH labels(src) + labels(dst) AS labelLists
      UNWIND labelLists AS label
      RETURN label, count(*) AS count
      ORDER BY count DESC, label ASC
      LIMIT 40
    `),
    readQuery(`
      MATCH ()-[:SRC_OF]->(e)-[:DST_TO]->()
      UNWIND labels(e) AS label
      RETURN label, count(*) AS count
      ORDER BY count DESC, label ASC
      LIMIT 40
    `),
    readQuery(`
      MATCH ()-[:SRC_OF]->(e)-[:DST_TO]->()
      WITH e LIMIT 1000
      UNWIND keys(e) AS field
      RETURN field, count(*) AS seen
      ORDER BY seen DESC, field ASC
      LIMIT 120
    `),
    readQuery(`
      MATCH ()-[:SRC_OF]->(e)-[:DST_TO]->()
      WHERE e.ts_datetime IS NOT NULL
      RETURN min(e.ts_datetime) AS from, max(e.ts_datetime) AS to, count(e) AS timed_events
    `),
    readQuery(`
      MATCH (src)-[:SRC_OF]->(e)-[:DST_TO]->(dst)
      RETURN coalesce(src.value, src.name, src.display, elementId(src)) AS source,
             coalesce(dst.value, dst.name, dst.display, elementId(dst)) AS target,
             labels(src) AS source_labels,
             labels(e) AS event_labels,
             labels(dst) AS target_labels,
             e.ts_datetime AS ts_datetime
      LIMIT 10
    `)
  ]);

  const fields = eventFields.records.map(recordToObject).map((r) => r.field).filter(Boolean);
  const preferredGroupFields = ["service", "proto", "id_resp_p", "id_orig_p", "conn_state", "log_type", "uid", "source_file"].filter((f) => fields.includes(f));
  const aggregateModes = [
    { id: "pair", label: "Source → Destination", groupFields: ["source", "target"] },
    ...preferredGroupFields.map((field) => ({ id: `event:${field}`, field, label: `Source → Destination + ${field}`, groupFields: ["source", "target", field] })),
    { id: "hour", label: "Source → Destination + hour bucket", groupFields: ["source", "target", "hour"] }
  ];

  return {
    entityLabel: process.env.GRAPH_ENTITY_LABEL || "__any",
    eventLabel: process.env.GRAPH_EVENT_LABEL || "__any",
    entityLabels: entityLabels.records.map(recordToObject),
    eventLabels: eventLabels.records.map(recordToObject),
    eventFields: fields,
    aggregateModes,
    timeBounds: bounds.records[0] ? recordToObject(bounds.records[0]) : null,
    samplePaths: samples.records.map(recordToObject)
  };
}

app.get("/api/graph/aggregate", async (req, res) => {
  try {
    const entityLabel = String(req.query.entityLabel || graphConfig.entityLabel || "__any").trim();
    const eventLabel = String(req.query.eventLabel || graphConfig.eventLabel || "__any").trim();
    const srcPattern = labelPattern("src", entityLabel);
    const dstPattern = labelPattern("dst", entityLabel);
    const eventPattern = labelPattern("e", eventLabel);
    const modeId = String(req.query.groupBy || "pair");
    const metric = widthMetric(req.query.widthBy || "event_count");
    const limit = asLimit(req.query.limit, 500, 2000);
    const clauses = [];
    const params = { from: req.query.from || null, to: req.query.to || null, limit };
    dateWhere("e", params, clauses);
    eventFilters(req.query, params, clauses);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    let groupExpr = "null";
    let modeLabel = "Source → Destination";
    if (modeId === "hour") {
      groupExpr = "substring(toString(e.ts_datetime), 0, 13) + ':00:00Z'";
      modeLabel = "Source → Destination + hour bucket";
    } else if (modeId.startsWith("event:")) {
      const field = safePropertyKey(modeId.slice("event:".length));
      if (field) {
        groupExpr = `toString(coalesce(e.${field}, 'unknown'))`;
        modeLabel = `Source → Destination + ${field}`;
      }
    }

    const cypher = `
      MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
      ${where}
      WITH coalesce(src.value, src.name, src.display, elementId(src)) AS source,
           coalesce(dst.value, dst.name, dst.display, elementId(dst)) AS target,
           labels(src)[0] AS source_label,
           labels(dst)[0] AS target_label,
           elementId(src) AS source_element_id,
           elementId(dst) AS target_element_id,
           src.${GRAPH_NOTE_PROPERTY} AS source_note,
           dst.${GRAPH_NOTE_PROPERTY} AS target_note,
           src.${GRAPH_COLOR_PROPERTY} AS source_color,
           dst.${GRAPH_COLOR_PROPERTY} AS target_color,
           ${groupExpr} AS group_value,
           count(e) AS event_count,
           sum(toFloat(coalesce(e.orig_bytes, 0)) + toFloat(coalesce(e.resp_bytes, 0))) AS total_bytes,
           sum(toFloat(coalesce(e.duration, 0))) AS total_duration,
           count(DISTINCT e.service) AS unique_services,
           count(DISTINCT e.id_resp_p) AS unique_ports,
           collect(DISTINCT e.service)[0..8] AS services,
           collect(DISTINCT e.proto)[0..8] AS protos,
           collect(DISTINCT e.id_resp_p)[0..8] AS destination_ports,
           min(e.ts_datetime) AS first_seen,
           max(e.ts_datetime) AS last_seen
      RETURN source, target, source_label, target_label, source_element_id, target_element_id,
             source_note, target_note, source_color, target_color, group_value, event_count, total_bytes, total_duration,
             unique_services, unique_ports, services, protos, destination_ports, first_seen, last_seen
      ORDER BY ${metric} DESC
      LIMIT $limit
    `;
    const result = await readQuery(cypher, params);
    const rows = result.records.map(recordToObject);
    const maxValue = rows.reduce((m, r) => Math.max(m, Number(r[metric] || 0)), 1);
    const nodes = new Map();
    const edges = [];
    for (const row of rows) {
      if (row.source === null || row.target === null) continue;
      const sourceLabel = row.source_label || "Entity";
      const targetLabel = row.target_label || sourceLabel;
      const sourceId = cyNodeId(sourceLabel, row.source);
      const targetId = cyNodeId(targetLabel, row.target);
      if (!nodes.has(sourceId)) nodes.set(sourceId, mapEntityNode(sourceLabel, row.source, "source", {
        elementId: row.source_element_id,
        note: row.source_note,
        color: row.source_color,
        properties: { value: row.source, role: "source", [GRAPH_NOTE_PROPERTY]: row.source_note || "", [GRAPH_COLOR_PROPERTY]: row.source_color || "" }
      }));
      if (!nodes.has(targetId)) nodes.set(targetId, mapEntityNode(targetLabel, row.target, "destination", {
        elementId: row.target_element_id,
        note: row.target_note,
        color: row.target_color,
        properties: { value: row.target, role: "destination", [GRAPH_NOTE_PROPERTY]: row.target_note || "", [GRAPH_COLOR_PROPERTY]: row.target_color || "" }
      }));
      const suffix = row.group_value ? `:${modeId}:${row.group_value}` : "";
      const id = `virtual:${sourceId}->${targetId}${suffix}`;
      const labelParts = [`${row.event_count} events`, bytesLabel(row.total_bytes)];
      if (row.group_value) labelParts.unshift(String(row.group_value));
      edges.push({
        data: {
          id, source: sourceId, target: targetId, label: labelParts.join(" / "), caption: labelParts.join(" / "),
          type: "VIRTUAL_COMMUNICATION", isVirtual: true, aggregate_mode: modeId, aggregate_value: row.group_value,
          widthMetric: metric, widthMetricValue: row[metric], width: virtualWidth(row[metric], maxValue),
          event_count: row.event_count, total_bytes: row.total_bytes, total_duration: row.total_duration,
          unique_services: row.unique_services, unique_ports: row.unique_ports,
          services: row.services || [], protos: row.protos || [], destination_ports: row.destination_ports || [],
          first_seen: serializeDateTime(row.first_seen), last_seen: serializeDateTime(row.last_seen),
          source_value: String(row.source), destination_value: String(row.target), source_label: sourceLabel, target_label: targetLabel,
          properties: row
        },
        classes: `virtual communication aggregate-${modeId.replace(/[^a-z0-9_-]/gi, "-")}`
      });
    }
    const graph = await applyGraphAnnotations({ nodes: [...nodes.values()], edges });
    res.json({ graph, table: { columns: result.records[0]?.keys || [], rows }, summary: { nodes: graph.nodes.length, edges: graph.edges.length, rows: rows.length }, config: { mode: { id: modeId, label: modeLabel }, metric } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/graph/pair/events", async (req, res) => {
  try {
    const entityLabel = String(req.query.entityLabel || graphConfig.entityLabel || "__any").trim();
    const eventLabel = String(req.query.eventLabel || graphConfig.eventLabel || "__any").trim();
    const srcPattern = labelPattern("src", req.query.sourceLabel || entityLabel);
    const dstPattern = labelPattern("dst", req.query.targetLabel || entityLabel);
    const eventPattern = labelPattern("e", eventLabel);
    const limit = asLimit(req.query.limit, 200, 1000);
    const clauses = ["toString(coalesce(src.value, src.name, src.display, elementId(src))) = $source", "toString(coalesce(dst.value, dst.name, dst.display, elementId(dst))) = $target"];
    const params = { source: req.query.source, target: req.query.target, from: req.query.from || null, to: req.query.to || null, limit };
    if (!params.source || !params.target) throw new Error("source and target are required.");
    dateWhere("e", params, clauses);
    eventFilters(req.query, params, clauses);
    const result = await readQuery(`
      MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
      WHERE ${clauses.join(" AND ")}
      RETURN src, e, dst
      ORDER BY e.ts_datetime DESC
      LIMIT $limit
    `, params);
    const graph = await applyGraphAnnotations(eventRowsToDetailedGraph(result.records));
    res.json({ graph, table: { columns: result.records[0]?.keys || [], rows: result.records.map(recordToObject) }, summary: { nodes: graph.nodes.length, edges: graph.edges.length, rows: result.records.length } });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

function nodeValueFromParam(nodeId) {
  const decoded = decodeURIComponent(String(nodeId || ""));
  return decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
}

app.get("/api/graph/node/:nodeId/stats", async (req, res) => {
  try {
    const entityLabel = String(req.query.entityLabel || graphConfig.entityLabel || "__any").trim();
    const eventLabel = String(req.query.eventLabel || graphConfig.eventLabel || "__any").trim();
    const srcPattern = labelPattern("src", entityLabel);
    const dstPattern = labelPattern("dst", entityLabel);
    const eventPattern = labelPattern("e", eventLabel);
    const value = nodeValueFromParam(req.params.nodeId);
    const params = { value, from: req.query.from || null, to: req.query.to || null };
    const baseClauses = [];
    dateWhere("e", params, baseClauses);
    eventFilters(req.query, params, baseClauses);
    const outboundWhere = [`toString(coalesce(src.value, src.name, src.display, elementId(src))) = $value`, ...baseClauses].join(" AND ");
    const inboundWhere = [`toString(coalesce(dst.value, dst.name, dst.display, elementId(dst))) = $value`, ...baseClauses].join(" AND ");

    const [nodeResult, outboundResult, inboundResult, topNeighborsResult, topPortsResult] = await Promise.all([
      readQuery(`
        MATCH (n)
        WHERE toString(coalesce(n.value, n.name, n.display, elementId(n))) = $value
        RETURN coalesce(n.value, n.name, n.display, elementId(n)) AS node,
               labels(n) AS labels,
               elementId(n) AS element_id
        LIMIT 1
      `, { value }),
      readQuery(`
        MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
        WHERE ${outboundWhere}
        RETURN count(e) AS events,
               count(DISTINCT dst) AS neighbors,
               collect(DISTINCT e.service)[0..12] AS services,
               collect(DISTINCT e.id_resp_p)[0..12] AS ports,
               min(e.ts_datetime) AS first_seen,
               max(e.ts_datetime) AS last_seen
      `, params),
      readQuery(`
        MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
        WHERE ${inboundWhere}
        RETURN count(e) AS events,
               count(DISTINCT src) AS neighbors,
               collect(DISTINCT e.service)[0..12] AS services,
               collect(DISTINCT e.id_resp_p)[0..12] AS ports,
               min(e.ts_datetime) AS first_seen,
               max(e.ts_datetime) AS last_seen
      `, params),
      readQuery(`
        CALL {
          MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
          WHERE ${outboundWhere}
          RETURN coalesce(dst.value, dst.name, dst.display, elementId(dst)) AS neighbor,
                 labels(dst)[0] AS label,
                 'outbound' AS direction,
                 count(e) AS events,
                 sum(toFloat(coalesce(e.orig_bytes, 0)) + toFloat(coalesce(e.resp_bytes, 0))) AS bytes,
                 collect(DISTINCT e.service)[0..6] AS services,
                 collect(DISTINCT e.id_resp_p)[0..6] AS ports
          UNION ALL
          MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
          WHERE ${inboundWhere}
          RETURN coalesce(src.value, src.name, src.display, elementId(src)) AS neighbor,
                 labels(src)[0] AS label,
                 'inbound' AS direction,
                 count(e) AS events,
                 sum(toFloat(coalesce(e.orig_bytes, 0)) + toFloat(coalesce(e.resp_bytes, 0))) AS bytes,
                 collect(DISTINCT e.service)[0..6] AS services,
                 collect(DISTINCT e.id_resp_p)[0..6] AS ports
        }
        RETURN neighbor, label, direction, events, bytes, services, ports
        ORDER BY events DESC, bytes DESC
        LIMIT 12
      `, params),
      readQuery(`
        CALL {
          MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
          WHERE ${outboundWhere}
          RETURN e.id_resp_p AS port, e.service AS service, e.proto AS proto
          UNION ALL
          MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
          WHERE ${inboundWhere}
          RETURN e.id_resp_p AS port, e.service AS service, e.proto AS proto
        }
        RETURN port, service, proto, count(*) AS events
        ORDER BY events DESC
        LIMIT 12
      `, params)
    ]);

    if (!nodeResult.records.length) return res.status(404).json({ error: "node not found" });
    const node = recordToObject(nodeResult.records[0]);
    const out = outboundResult.records[0] ? recordToObject(outboundResult.records[0]) : {};
    const inc = inboundResult.records[0] ? recordToObject(inboundResult.records[0]) : {};
    const dates = [out.first_seen, inc.first_seen, out.last_seen, inc.last_seen].filter(Boolean).map(String).sort();
    let timeline = { buckets: [], step: null };
    if (dates.length) {
      const step = chooseRoundedTimeStep(dates[0], dates.at(-1), 72);
      const timelineResult = await readQuery(`
        CALL {
          MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
          WHERE ${outboundWhere}
          RETURN e
          UNION ALL
          MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
          WHERE ${inboundWhere}
          RETURN e
        }
        WITH toInteger(floor(e.ts_datetime.epochMillis / $stepMs) * $stepMs) AS bucket_ms, count(e) AS count
        RETURN bucket_ms, count
        ORDER BY bucket_ms ASC
        LIMIT 1000
      `, { ...params, stepMs: step.ms });
      const sparse = new Map(timelineResult.records.map((record) => {
        const row = recordToObject(record);
        return [Number(row.bucket_ms), Number(row.count || 0)];
      }));
      const fromDate = new Date(String(dates[0]));
      const toDate = new Date(String(dates.at(-1)));
      const startMs = Math.floor(fromDate.getTime() / step.ms) * step.ms;
      const endMs = Math.ceil(toDate.getTime() / step.ms) * step.ms;
      const buckets = [];
      for (let bucketMs = startMs; bucketMs <= endMs && buckets.length < 240; bucketMs += step.ms) {
        buckets.push({ bucket: new Date(bucketMs).toISOString(), bucket_ms: bucketMs, count: sparse.get(bucketMs) || 0 });
      }
      timeline = { buckets, step };
    }
    res.json({
      summary: {
        ...node,
        outbound_events: out.events || 0,
        inbound_events: inc.events || 0,
        total_events: Number(out.events || 0) + Number(inc.events || 0),
        outbound_neighbors: out.neighbors || 0,
        inbound_neighbors: inc.neighbors || 0,
        total_neighbors: Number(out.neighbors || 0) + Number(inc.neighbors || 0),
        outbound_services: out.services || [],
        inbound_services: inc.services || [],
        outbound_ports: out.ports || [],
        inbound_ports: inc.ports || [],
        first_seen: serializeDateTime(dates[0] || null),
        last_seen: serializeDateTime(dates.at(-1) || null)
      },
      topNeighbors: topNeighborsResult.records.map(recordToObject),
      topPorts: topPortsResult.records.map(recordToObject),
      timeline
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/graph/node/:nodeId/neighbors", async (req, res) => {
  try {
    const entityLabel = String(req.query.entityLabel || graphConfig.entityLabel || "__any").trim();
    const eventLabel = String(req.query.eventLabel || graphConfig.eventLabel || "__any").trim();
    const srcPattern = labelPattern("src", entityLabel);
    const dstPattern = labelPattern("dst", entityLabel);
    const eventPattern = labelPattern("e", eventLabel);
    const limit = asLimit(req.query.limit, 200, 1000);
    const value = nodeValueFromParam(req.params.nodeId);
    const direction = String(req.query.direction || "both");
    const baseClauses = [];
    const params = { value, from: req.query.from || null, to: req.query.to || null, limit };
    dateWhere("e", params, baseClauses);
    eventFilters(req.query, params, baseClauses);
    const outClauses = ["toString(coalesce(src.value, src.name, src.display, elementId(src))) = $value", ...baseClauses];
    const inClauses = ["toString(coalesce(dst.value, dst.name, dst.display, elementId(dst))) = $value", ...baseClauses];
    const out = `MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern}) WHERE ${outClauses.join(" AND ")} RETURN src, e, dst`;
    const inc = `MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern}) WHERE ${inClauses.join(" AND ")} RETURN src, e, dst`;
    const cypher = direction === "outbound" ? `${out} ORDER BY e.ts_datetime DESC LIMIT $limit` : direction === "inbound" ? `${inc} ORDER BY e.ts_datetime DESC LIMIT $limit` : `${out} UNION ${inc} ORDER BY e.ts_datetime DESC LIMIT $limit`;
    const result = await readQuery(cypher, params);
    const graph = await applyGraphAnnotations(eventRowsToDetailedGraph(result.records));
    res.json({ graph, table: { columns: result.records[0]?.keys || [], rows: result.records.map(recordToObject) }, summary: { nodes: graph.nodes.length, edges: graph.edges.length, rows: result.records.length } });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/graph/event/:eventId", async (req, res) => {
  try {
    const eventPattern = labelPattern("e", req.query.eventLabel || graphConfig.eventLabel || "__any");
    const result = await readQuery(`MATCH (${eventPattern}) WHERE e.event_id = $eventId OR elementId(e) = $eventId RETURN e LIMIT 1`, { eventId: req.params.eventId });
    if (!result.records.length) return res.status(404).json({ error: "event not found" });
    res.json(recordToObject(result.records[0]));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/graph/search", async (req, res) => {
  try {
    const entityPattern = labelPattern("n", req.query.entityLabel || graphConfig.entityLabel || "__any");
    const q = String(req.query.q || "").trim();
    const limit = asLimit(req.query.limit, 20, 100);
    if (!q) return res.json({ results: [] });
    const result = await readQuery(`
      MATCH (${entityPattern})
      WHERE (n)-[:SRC_OF]->() OR ()-[:DST_TO]->(n)
      WITH DISTINCT n
      WHERE toString(coalesce(n.value, '')) CONTAINS $q
         OR toString(coalesce(n.name, '')) CONTAINS $q
         OR toString(coalesce(n.display, '')) CONTAINS $q
         OR toString(coalesce(n.caption, '')) CONTAINS $q
      RETURN coalesce(n.value, n.name, n.display, elementId(n)) AS value, labels(n) AS labels, n.caption AS caption, n.name AS name, n.display AS display
      ORDER BY value
      LIMIT $limit
    `, { q, limit });
    res.json({ results: result.records.map(recordToObject) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/graph/timeline", async (req, res) => {
  try {
    const entityLabel = String(req.query.entityLabel || graphConfig.entityLabel || "__any").trim();
    const eventLabel = String(req.query.eventLabel || graphConfig.eventLabel || "__any").trim();
    const srcPattern = labelPattern("src", req.query.sourceLabel || entityLabel);
    const dstPattern = labelPattern("dst", req.query.targetLabel || entityLabel);
    const eventPattern = labelPattern("e", eventLabel);
    const baseClauses = ["e.ts_datetime IS NOT NULL"];
    const params = {
      source: req.query.source || null,
      target: req.query.target || null,
      from: req.query.from || null,
      to: req.query.to || null
    };
    if (params.source) baseClauses.push("toString(coalesce(src.value, src.name, src.display, elementId(src))) = $source");
    if (params.target) baseClauses.push("toString(coalesce(dst.value, dst.name, dst.display, elementId(dst))) = $target");
    eventFilters(req.query, params, baseClauses);

    const boundsResult = await readQuery(`
      MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
      WHERE ${baseClauses.join(" AND ")}
      RETURN min(e.ts_datetime) AS from, max(e.ts_datetime) AS to, count(e) AS total_events
    `, params);
    const bounds = boundsResult.records[0] ? recordToObject(boundsResult.records[0]) : {};
    if (!bounds.from || !bounds.to) return res.json({ buckets: [], step: null, bounds });

    const selectedFrom = params.from || bounds.from;
    const selectedTo = params.to || bounds.to;
    const step = chooseRoundedTimeStep(bounds.from, bounds.to, req.query.buckets);
    const bucketParams = { ...params, stepMs: step.ms };
    const result = await readQuery(`
      MATCH (${srcPattern})-[:SRC_OF]->(${eventPattern})-[:DST_TO]->(${dstPattern})
      WHERE ${baseClauses.join(" AND ")}
      WITH toInteger(floor(e.ts_datetime.epochMillis / $stepMs) * $stepMs) AS bucket_ms, count(e) AS count
      RETURN bucket_ms, count
      ORDER BY bucket_ms ASC
      LIMIT 10000
    `, bucketParams);
    const sparse = new Map(result.records.map((record) => {
      const row = recordToObject(record);
      return [Number(row.bucket_ms), Number(row.count || 0)];
    }));
    const fromDate = new Date(String(bounds.from));
    const toDate = new Date(String(bounds.to));
    const startMs = Math.floor(fromDate.getTime() / step.ms) * step.ms;
    const endMs = Math.ceil(toDate.getTime() / step.ms) * step.ms;
    const maxBuckets = Math.max(30, Math.min(1000, Number(req.query.maxBuckets || 500)));
    const buckets = [];
    for (let bucketMs = startMs; bucketMs <= endMs && buckets.length < maxBuckets; bucketMs += step.ms) {
      buckets.push({ bucket: new Date(bucketMs).toISOString(), bucket_ms: bucketMs, count: sparse.get(bucketMs) || 0 });
    }
    res.json({
      buckets,
      step: { ...step, targetBuckets: TIMELINE_TARGET_BUCKETS },
      bounds,
      selection: { from: selectedFrom, to: selectedTo }
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

function eventRowsToDetailedGraph(records) {
  const nodes = new Map();
  const edges = new Map();
  for (const record of records) {
    const src = record.get("src");
    const dst = record.get("dst");
    const e = record.get("e");
    const srcProps = toNative(src.properties || {});
    const dstProps = toNative(dst.properties || {});
    const eventProps = toNative(e.properties || {});
    const sVal = srcProps.value || eventProps.source_value || entityId(src);
    const dVal = dstProps.value || eventProps.destination_value || entityId(dst);
    const srcLabel = src.labels?.[0] || "Entity";
    const dstLabel = dst.labels?.[0] || srcLabel;
    const sid = cyNodeId(srcLabel, sVal);
    const did = cyNodeId(dstLabel, dVal);
    const eid = cyEventId(eventProps.event_id || entityId(e));
    if (!nodes.has(sid)) nodes.set(sid, { ...mapEntityNode(srcLabel, sVal, "source"), data: { ...mapEntityNode(srcLabel, sVal, "source").data, properties: srcProps, elementId: entityId(src), note: srcProps[GRAPH_NOTE_PROPERTY] || "", customColor: srcProps[GRAPH_COLOR_PROPERTY] || "" } });
    if (!nodes.has(did)) nodes.set(did, { ...mapEntityNode(dstLabel, dVal, "destination"), data: { ...mapEntityNode(dstLabel, dVal, "destination").data, properties: dstProps, elementId: entityId(dst), note: dstProps[GRAPH_NOTE_PROPERTY] || "", customColor: dstProps[GRAPH_COLOR_PROPERTY] || "" } });
    if (!nodes.has(eid)) {
      const labels = e.labels || [];
      const etype = eventType(labels);
      const caption = eventProps.caption || eventProps.display || `${eventProps.proto || etype} ${eventProps.id_resp_p || eventProps.service || ""}`.trim();
      nodes.set(eid, { data: { id: eid, elementId: entityId(e), label: caption, caption, type: etype, labels, event_id: eventProps.event_id, ts: eventProps.ts_iso || eventProps.ts_datetime || eventProps.ts_raw || "", properties: eventProps, note: eventProps[GRAPH_NOTE_PROPERTY] || "", customColor: eventProps[GRAPH_COLOR_PROPERTY] || "" }, classes: `event ${etype.toLowerCase().replace(/event$/i, "")}` });
    }
    edges.set(`src_of:${eid}`, { data: { id: `src_of:${eid}`, source: sid, target: eid, label: "SRC_OF", caption: "SRC_OF", type: "SRC_OF", properties: {} }, classes: "event-link src-of" });
    edges.set(`dst_to:${eid}`, { data: { id: `dst_to:${eid}`, source: eid, target: did, label: "DST_TO", caption: "DST_TO", type: "DST_TO", properties: {} }, classes: "event-link dst-to" });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

app.patch("/api/graph-metadata/:kind/:id", async (req, res) => {
  const kind = String(req.params.kind || "");
  const id = String(req.params.id || "");
  if (!["node", "edge"].includes(kind)) {
    res.status(400).json({ error: "kind must be node or edge." });
    return;
  }
  if (!id) {
    res.status(400).json({ error: "Graph element id is required." });
    return;
  }

  try {
    const alias = kind === "node" ? "n" : "r";
    const isVirtual = id.startsWith("virtual:") || id.startsWith("src_of:") || id.startsWith("dst_to:") || id.includes("->");
    if (isVirtual) {
      await writeAnnotation(kind, id, req.body || {});
      res.json({ ok: true, id, kind, storage: "annotation" });
      return;
    }
    const match = kind === "node" ? "MATCH (n) WHERE elementId(n) = $id" : "MATCH ()-[r]-() WHERE elementId(r) = $id";
    const { cypher, params } = metadataSetClauses(alias, req.body || {});
    const result = await writeQuery(`${match} ${cypher} RETURN elementId(${alias}) AS id`, { id, ...params });
    if (!result.records.length) {
      await writeAnnotation(kind, id, req.body || {});
      res.json({ ok: true, id, kind, storage: "annotation" });
      return;
    }
    res.json({ ok: true, id, kind, storage: "element" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

process.on("SIGINT", async () => {
  await driver.close();
  process.exit(0);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Neo4j Cytoscape Explorer listening on :${port}`);
});
