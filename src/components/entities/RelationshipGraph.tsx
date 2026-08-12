import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

export interface GraphNode {
  _id: string;
  name: string;
  type: string;
  mentionCount: number;
}

export interface GraphEdge {
  _id: string;
  source: string;
  target: string;
  relationType: string;
  confidence: number;
  quote?: string;
  documentName?: string;
}

const TYPE_COLORS: Record<string, string> = {
  people: "#8b5cf6", // violet
  organization: "#3b82f6", // blue
  places: "#10b981", // emerald
  dates: "#f59e0b", // amber
};
const DEFAULT_COLOR = "#94a3b8"; // slate

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Compute a static force-directed layout: circular init, then a fixed number
 * of repulsion + spring + gravity iterations. Deterministic, no animation —
 * plenty for the <200 node graphs a story produces.
 */
function computeLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node._id, i]));
  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  const R = 60 + n * 14;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / Math.max(n, 1);
    xs[i] = R * Math.cos(angle);
    ys[i] = R * Math.sin(angle);
  }

  const springLength = 130;
  for (let iter = 0; iter < 300; iter++) {
    const t = 1 - iter / 300; // cooling
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);

    // Pairwise repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[i] - xs[j];
        const dy = ys[i] - ys[j];
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = 5000 / d2;
        const d = Math.sqrt(d2);
        fx[i] += (dx / d) * f;
        fy[i] += (dy / d) * f;
        fx[j] -= (dx / d) * f;
        fy[j] -= (dy / d) * f;
      }
    }

    // Springs along edges
    for (const edge of edges) {
      const a = index.get(edge.source);
      const b = index.get(edge.target);
      if (a === undefined || b === undefined) continue;
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - springLength) * 0.05;
      fx[a] += (dx / d) * f;
      fy[a] += (dy / d) * f;
      fx[b] -= (dx / d) * f;
      fy[b] -= (dy / d) * f;
    }

    // Gentle gravity toward center
    for (let i = 0; i < n; i++) {
      fx[i] -= xs[i] * 0.01;
      fy[i] -= ys[i] * 0.01;
      const cap = 30 * t + 2;
      xs[i] += Math.max(-cap, Math.min(cap, fx[i]));
      ys[i] += Math.max(-cap, Math.min(cap, fy[i]));
    }
  }

  return new Map(
    nodes.map((node, i) => [node._id, { x: xs[i], y: ys[i] }])
  );
}

export default function RelationshipGraph({
  nodes,
  edges,
  projectId,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Scopes the /entity/:slug links — entities are per-project. */
  projectId?: string;
}) {
  const navigate = useNavigate();
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const positions = useMemo(() => computeLayout(nodes, edges), [nodes, edges]);

  const viewBox = useMemo(() => {
    if (nodes.length === 0) return "-100 -100 200 200";
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of positions.values()) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const pad = 70;
    return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  }, [nodes, positions]);

  if (nodes.length === 0) return null;

  const neighborIds = new Set<string>();
  if (hoveredNode) {
    neighborIds.add(hoveredNode);
    for (const e of edges) {
      if (e.source === hoveredNode) neighborIds.add(e.target);
      if (e.target === hoveredNode) neighborIds.add(e.source);
    }
  }
  const dimmed = (id: string) => hoveredNode !== null && !neighborIds.has(id);

  const hovered = edges.find((e) => e._id === hoveredEdge);

  return (
    <div className="relative">
      <svg viewBox={viewBox} className="w-full" style={{ maxHeight: 420 }}>
        {edges.map((edge) => {
          const a = positions.get(edge.source);
          const b = positions.get(edge.target);
          if (!a || !b) return null;
          const isDim =
            hoveredNode !== null &&
            edge.source !== hoveredNode &&
            edge.target !== hoveredNode;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g
              key={edge._id}
              opacity={isDim ? 0.15 : 1}
              onMouseEnter={() => setHoveredEdge(edge._id)}
              onMouseLeave={() => setHoveredEdge(null)}
              className="cursor-default"
            >
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--graph-edge)"
                strokeWidth={hoveredEdge === edge._id ? 2.5 : 1.5}
              />
              {/* invisible fat line for easier hovering */}
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="transparent"
                strokeWidth={12}
              />
              <text
                x={mx}
                y={my - 4}
                textAnchor="middle"
                fontSize={9}
                fill="var(--graph-edge-label)"
                className="select-none pointer-events-none"
              >
                {edge.relationType.replace(/_/g, " ")}
              </text>
            </g>
          );
        })}

        {nodes.map((node) => {
          const pos = positions.get(node._id);
          if (!pos) return null;
          const r = Math.min(8 + Math.sqrt(node.mentionCount) * 3, 22);
          return (
            <g
              key={node._id}
              opacity={dimmed(node._id) ? 0.25 : 1}
              className="cursor-pointer"
              onClick={() =>
                navigate(
                  `/entity/${toSlug(node.name)}${projectId ? `?project=${projectId}` : ""}`
                )
              }
              onMouseEnter={() => setHoveredNode(node._id)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r}
                fill={TYPE_COLORS[node.type] ?? DEFAULT_COLOR}
                fillOpacity={0.85}
                stroke="var(--graph-node-ring)"
                strokeWidth={1.5}
              />
              <text
                x={pos.x}
                y={pos.y + r + 12}
                textAnchor="middle"
                fontSize={11}
                fontWeight={500}
                fill="currentColor"
                className="select-none"
              >
                {node.name}
              </text>
            </g>
          );
        })}
      </svg>

      {hovered && (
        <div className="absolute bottom-2 left-2 right-2 bg-popover border rounded-md shadow-md px-3 py-2 text-xs pointer-events-none">
          <span className="font-medium">
            {hovered.relationType.replace(/_/g, " ")}
          </span>
          {hovered.quote && (
            <span className="text-muted-foreground"> — “{hovered.quote}”</span>
          )}
          {hovered.documentName && (
            <span className="text-muted-foreground block mt-0.5">
              Source: {hovered.documentName}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
