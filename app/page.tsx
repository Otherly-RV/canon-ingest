"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

type AssetBBox = { x: number; y: number; w: number; h: number };

type PageAsset = {
  assetId: string;
  url: string;
  bbox: AssetBBox;
  tags?: string[];
  tagRationale?: string;
};

type SettingsHistoryEntry = {
  timestamp: string;
  label?: string;
  content: string;
};

type SettingsHistory = {
  aiRules?: SettingsHistoryEntry[];
  taggingJson?: SettingsHistoryEntry[];
  schemaJson?: SettingsHistoryEntry[];
  completenessRules?: SettingsHistoryEntry[];
  detectionRulesJson?: SettingsHistoryEntry[];
};

type Manifest = {
  projectId: string;
  createdAt: string;
  status: "empty" | "uploaded" | "processed";
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
  formattedText?: { url: string };
  docAiJson?: { url: string };
  schemaResults?: { url: string };
  pages?: Array<{
    pageNumber: number;
    url: string;
    width: number;
    height: number;
    tags?: string[];
    assets?: PageAsset[];
    deletedAssetIds?: string[];
  }>;
  settings: {
    aiRules: string;
    uiFieldsJson: string;
    taggingJson: string;
    schemaJson: string;
    completenessRules?: string;
    detectionRulesJson?: string;
    history?: SettingsHistory;
  };
};

type ProjectRow = {
  projectId: string;
  manifestUrl: string;
  createdAt: string;
  status: string;
  filename: string;
  pagesCount: number;
  hasText: boolean;
};

type PdfJsLib = {
  getDocument: (opts: { url: string; withCredentials?: boolean }) => PdfLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
};

type PdfLoadingTask = { promise: Promise<PdfDocument> };

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => PdfViewport;
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
};

type PdfViewport = { width: number; height: number };

async function readErrorText(res: Response) {
  try {
    const t = await res.text();
    return t || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function setUrlParams(pid: string, m: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("pid", pid);
  url.searchParams.set("m", m);
  window.history.replaceState({}, "", url.toString());
}

function clearUrlParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("pid");
  url.searchParams.delete("m");
  window.history.replaceState({}, "", url.toString());
}

function getUrlParams() {
  const url = new URL(window.location.href);
  return {
    pid: url.searchParams.get("pid") || "",
    m: url.searchParams.get("m") || ""
  };
}

function bust(url: string) {
  const u = new URL(url);
  u.searchParams.set("v", String(Date.now()));
  return u.toString();
}

function setPdfJsWorker(pdfjs: PdfJsLib) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={up ? "M6 14l6-6 6 6" : "M6 10l6 6 6-6"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Trash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M10 11v7M14 11v7M9 7l1-2h4l1 2M6 7l1 14h10l1-14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Refresh() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12a9 9 0 10-3 6.7M21 12v-6m0 6h-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Tabs({
  value,
  onChange
}: {
  value: "ai" | "tagging" | "schema" | "completeness" | "detection";
  onChange: (v: "ai" | "tagging" | "schema" | "completeness" | "detection") => void;
}) {
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: "1px solid #000",
    background: active ? "#000" : "#fff",
    color: active ? "#fff" : "#000",
    borderRadius: 10,
    padding: "7px 10px",
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap"
  });

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        minWidth: 0,
        flex: 1,
        overflow: "hidden"
      }}
    >
      <button type="button" onClick={() => onChange("ai")} style={tabStyle(value === "ai")}>
        AI Rules
      </button>
      <button type="button" onClick={() => onChange("schema")} style={tabStyle(value === "schema")}>
        Schema JSON
      </button>
      <button type="button" onClick={() => onChange("tagging")} style={tabStyle(value === "tagging")}>
        Tagging JSON
      </button>
      <button type="button" onClick={() => onChange("completeness")} style={tabStyle(value === "completeness")}>
        Completeness
      </button>
      <button type="button" onClick={() => onChange("detection")} style={tabStyle(value === "detection")}>
        Detection
      </button>
    </div>
  );
}

// Completeness calculation helper
function calculateCompleteness(
  schemaData: Record<string, unknown>,
  completenessRules: string
): { overall: number; byDomain: Record<string, number>; alert: { color: string; message: string } } {
  const domains = ["OVERVIEW", "CHARACTERS", "WORLD", "LORE", "STYLE", "STORY"];
  const byDomain: Record<string, number> = {};
  
  // Parse custom rules if provided
  let customWeights: Record<string, number> = {};
  try {
    if (completenessRules.trim()) {
      const parsed = JSON.parse(completenessRules);
      if (parsed.weights) customWeights = parsed.weights;
    }
  } catch {
    // Use defaults if parsing fails
  }

  // Calculate per-domain completeness
  for (const domain of domains) {
    const domainData = schemaData[domain];
    if (!domainData || typeof domainData !== "object") {
      byDomain[domain] = 0;
      continue;
    }

    const fields = Object.entries(domainData as Record<string, unknown>);
    if (fields.length === 0) {
      byDomain[domain] = 0;
      continue;
    }

    let filledCount = 0;
    let totalWeight = 0;
    let filledWeight = 0;

    for (const [key, val] of fields) {
      const weight = customWeights[`${domain}.${key}`] || 1;
      totalWeight += weight;
      
      const isFilled = val !== null && val !== undefined && val !== "" && 
        !(Array.isArray(val) && val.length === 0) &&
        !(typeof val === "object" && !Array.isArray(val) && Object.keys(val).length === 0);
      
      if (isFilled) {
        filledCount++;
        filledWeight += weight;
      }
    }

    byDomain[domain] = totalWeight > 0 ? Math.round((filledWeight / totalWeight) * 100) : 0;
  }

  // Calculate overall with domain weights
  const domainWeights: Record<string, number> = {
    OVERVIEW: customWeights.OVERVIEW || 20,
    CHARACTERS: customWeights.CHARACTERS || 20,
    WORLD: customWeights.WORLD || 15,
    LORE: customWeights.LORE || 15,
    STYLE: customWeights.STYLE || 15,
    STORY: customWeights.STORY || 15
  };
  
  let weightedSum = 0;
  let totalDomainWeight = 0;
  for (const domain of domains) {
    const w = domainWeights[domain];
    weightedSum += byDomain[domain] * w;
    totalDomainWeight += w;
  }
  const overall = totalDomainWeight > 0 ? Math.round(weightedSum / totalDomainWeight) : 0;

  // Determine alert
  let alert = { color: "#22c55e", message: "Baseline is production-ready" };
  if (overall < 50) {
    alert = { color: "#ef4444", message: "Insufficient baseline — upload more sources or fill key fields" };
  } else if (overall < 70) {
    alert = { color: "#f97316", message: "Review before production — address missing fields" };
  } else if (overall < 80) {
    alert = { color: "#eab308", message: "Minor additions recommended" };
  }

  return { overall, byDomain, alert };
}

// Domain colors for visual differentiation
const DOMAIN_COLORS: Record<string, { bg: string; accent: string; light: string }> = {
  OVERVIEW: { bg: "#f0f7ff", accent: "#2563eb", light: "#dbeafe" },
  CHARACTERS: { bg: "#fdf2f8", accent: "#db2777", light: "#fce7f3" },
  WORLD: { bg: "#ecfdf5", accent: "#059669", light: "#d1fae5" },
  LORE: { bg: "#fefce8", accent: "#ca8a04", light: "#fef9c3" },
  STYLE: { bg: "#faf5ff", accent: "#9333ea", light: "#f3e8ff" },
  STORY: { bg: "#fff7ed", accent: "#ea580c", light: "#ffedd5" }
};

// Schema Results UI Component - renders filled schema as cards
function SchemaResultsUI({
  jsonString,
  domain,
  level
}: {
  jsonString: string;
  domain: string;
  level: "L1" | "L2" | "L3";
}) {
  const colors = DOMAIN_COLORS[domain] || DOMAIN_COLORS.OVERVIEW;

  // Parse JSON safely
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(jsonString) as Record<string, unknown>;
  } catch {
    return (
      <div style={{ padding: 16, background: "#fef2f2", borderRadius: 12, fontSize: 13, color: "#dc2626", border: "1px solid #fecaca" }}>
        ⚠️ Invalid JSON. Switch to Raw JSON view to fix.
      </div>
    );
  }

  // Navigate to the correct level and domain
  const levelData = (data[level] as Record<string, unknown>) ?? {};
  const domainData = (levelData[domain] as Record<string, unknown>) ?? {};

  if (Object.keys(domainData).length === 0) {
    return (
      <div style={{ padding: 24, background: "#f8fafc", borderRadius: 12, fontSize: 14, color: "#64748b", textAlign: "center", border: "1px dashed #e2e8f0" }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>📭</div>
        No data for {level} → {domain}
      </div>
    );
  }

  // Render cards for each field
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {Object.entries(domainData).map(([key, value]) => (
        <SchemaCard key={key} fieldName={key} value={value} colors={colors} />
      ))}
    </div>
  );
}

// CSS named colors that browsers understand
const CSS_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", 
  "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", 
  "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", 
  "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen", 
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue", 
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro", 
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", 
  "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", 
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon", 
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime", 
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", 
  "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", 
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", 
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff", 
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", 
  "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", 
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", 
  "wheat", "white", "whitesmoke", "yellow", "yellowgreen"
]);

// Check if a string is a valid CSS color (hex or named)
function isValidCssColor(str: string): boolean {
  if (typeof str !== "string") return false;
  // Check hex format
  if (/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}|[0-9A-Fa-f]{3})$/.test(str)) return true;
  // Check named colors (case-insensitive)
  return CSS_NAMED_COLORS.has(str.toLowerCase().trim());
}

// Individual card component for schema fields
function SchemaCard({
  fieldName,
  value,
  colors
}: {
  fieldName: string;
  value: unknown;
  colors: { bg: string; accent: string; light: string };
}) {
  const formatFieldName = (name: string) => {
    // Convert camelCase/PascalCase to readable format
    return name.replace(/([A-Z])/g, " $1").trim();
  };

  // Handle null/undefined
  if (value === null || value === undefined) {
    return (
      <div
        style={{
          background: "#f8fafc",
          borderRadius: 12,
          padding: 16,
          border: "1px dashed #e2e8f0"
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ fontSize: 14, color: "#94a3b8", fontStyle: "italic" }}>Not specified</div>
      </div>
    );
  }

  // Handle asset type (image/audio with url) - e.g., KeyArtPoster
  if (typeof value === "object" && value !== null && "url" in value) {
    const asset = value as { url: string; source?: string; caption?: string };
    return (
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          border: "1px solid #e2e8f0"
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", padding: "12px 16px", background: colors.bg, borderBottom: "1px solid #e2e8f0" }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ padding: 12 }}>
          <img
            src={asset.url}
            alt={asset.caption || fieldName}
            style={{
              width: "100%",
              maxHeight: 400,
              objectFit: "contain",
              borderRadius: 8
            }}
          />
          {asset.caption && (
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 8, textAlign: "center" }}>
              {asset.caption}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Handle string
  if (typeof value === "string") {
    return (
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 16,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          border: "1px solid #e2e8f0"
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "#1e293b" }}>
          {value || <span style={{ color: "#94a3b8" }}>—</span>}
        </div>
      </div>
    );
  }

  // Handle color array (ExtractedPalette) - render as circular swatches
  // Supports both hex codes (#FF0000) and CSS named colors (red, blue, etc.)
  const isColorArray = Array.isArray(value) && 
    value.length > 0 && 
    value.every((v) => typeof v === "string" && isValidCssColor(v as string));

  if (isColorArray) {
    const colorValues = value as string[];
    return (
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 16,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          border: "1px solid #e2e8f0"
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          {colorValues.map((color, i) => (
            <div
              key={i}
              title={color}
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: color,
                border: "3px solid #fff",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                cursor: "pointer",
                transition: "transform 0.15s"
              }}
              onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.15)")}
              onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
            />
          ))}
        </div>
      </div>
    );
  }

  // Handle array of strings (tags) - but not hex colors
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 16,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          border: "1px solid #e2e8f0"
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
          {formatFieldName(fieldName)}
        </div>
        {value.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {value.map((item, i) => (
              <span
                key={i}
                style={{
                  background: colors.light,
                  color: colors.accent,
                  padding: "6px 12px",
                  borderRadius: 20,
                  fontSize: 13,
                  fontWeight: 500
                }}
              >
                {item}
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 14, color: "#94a3b8" }}>—</div>
        )}
      </div>
    );
  }

  // Handle array of objects (like CharacterList, Locations, etc.)
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    return (
      <div
        style={{
          background: colors.bg,
          borderRadius: 16,
          overflow: "hidden",
          border: `1px solid ${colors.light}`
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "14px 18px",
            color: colors.accent,
            borderBottom: `1px solid ${colors.light}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            textTransform: "uppercase",
            letterSpacing: "0.05em"
          }}
        >
          {formatFieldName(fieldName)}
          <span
            style={{
              background: colors.accent,
              color: "#fff",
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 600
            }}
          >
            {value.length}
          </span>
        </div>
        <div style={{ display: "grid", gap: 2, background: colors.light }}>
          {value.map((item, i) => (
            <div key={i} style={{ background: "#fff" }}>
              <ObjectCard data={item as Record<string, unknown>} index={i} colors={colors} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Handle nested object
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return (
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          border: "1px solid #e2e8f0"
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "12px 16px",
            color: colors.accent,
            background: colors.bg,
            borderBottom: "1px solid #e2e8f0",
            textTransform: "uppercase",
            letterSpacing: "0.05em"
          }}
        >
          {formatFieldName(fieldName)}
        </div>
        <div style={{ padding: 16, display: "grid", gap: 14 }}>
          {Object.entries(obj).map(([k, v]) => (
            <NestedField key={k} fieldName={k} value={v} colors={colors} />
          ))}
        </div>
      </div>
    );
  }

  // Fallback for other types
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        padding: 16,
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        border: "1px solid #e2e8f0"
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
        {formatFieldName(fieldName)}
      </div>
      <div style={{ fontSize: 14, color: "#1e293b" }}>{String(value)}</div>
    </div>
  );
}

// Nested field renderer for objects within objects
function NestedField({
  fieldName,
  value,
  colors
}: {
  fieldName: string;
  value: unknown;
  colors: { bg: string; accent: string; light: string };
}) {
  const formatFieldName = (name: string) => name.replace(/([A-Z])/g, " $1").trim();

  // Handle asset type (image/audio with url)
  if (typeof value === "object" && value !== null && "url" in value) {
    const asset = value as { url: string; source?: string; caption?: string };
    return (
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <img
            src={asset.url}
            alt={asset.caption || fieldName}
            style={{
              maxWidth: "100%",
              maxHeight: 300,
              objectFit: "contain",
              borderRadius: 8,
              border: "2px solid #e2e8f0",
              boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
              background: "#f8fafc"
            }}
          />
          {asset.caption && <span style={{ fontSize: 13, color: "#64748b" }}>{asset.caption}</span>}
        </div>
      </div>
    );
  }

  // Handle string
  if (typeof value === "string") {
    // Skip empty or "Unknown" values for cleaner UI
    if (!value || value === "Unknown") {
      return null;
    }
    return (
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ fontSize: 14, color: "#1e293b", lineHeight: 1.5 }}>{value}</div>
      </div>
    );
  }

  // Handle color array (ExtractedPalette) - render as circular swatches
  // Supports both hex codes (#FF0000) and CSS named colors (red, blue, etc.)
  const isColorArray = Array.isArray(value) && 
    value.length > 0 && 
    value.every((v) => typeof v === "string" && isValidCssColor(v as string));

  if (isColorArray) {
    const colorValues = value as string[];
    return (
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {colorValues.map((color, i) => (
            <div
              key={i}
              title={color}
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: color,
                border: "2px solid #fff",
                boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
                cursor: "pointer",
                transition: "transform 0.15s"
              }}
              onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.15)")}
              onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
            />
          ))}
        </div>
      </div>
    );
  }

  // Handle string array (but not colors which are handled above)
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    if (value.length === 0) return null;
    return (
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {value.map((item, i) => (
            <span
              key={i}
              style={{
                background: colors.light,
                color: colors.accent,
                padding: "4px 10px",
                borderRadius: 16,
                fontSize: 12,
                fontWeight: 500
              }}
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // Handle array of objects (like relationships)
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    return (
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {value.map((item, i) => {
            const obj = item as Record<string, unknown>;
            const targetName = obj.TargetCharacterName || obj.Name || obj.name || `Item ${i + 1}`;
            const relType = obj.RelationshipType || obj.Type || obj.type || "";
            const desc = obj.Description || obj.description || "";
            return (
              <div
                key={i}
                style={{
                  background: colors.bg,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${colors.light}`
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "#1e293b" }}>{String(targetName)}</span>
                  {relType && (
                    <span
                      style={{
                        background: colors.accent,
                        color: "#fff",
                        padding: "2px 8px",
                        borderRadius: 10,
                        fontSize: 10,
                        fontWeight: 600
                      }}
                    >
                      {String(relType)}
                    </span>
                  )}
                </div>
                {desc && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{String(desc)}</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Handle nested object
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj).filter(([, v]) => v && v !== "Unknown");
    if (entries.length === 0) return null;
    return (
      <div
        style={{
          padding: "12px 14px",
          background: colors.bg,
          borderRadius: 8,
          border: `1px solid ${colors.light}`
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 600, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
          {formatFieldName(fieldName)}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {entries.map(([k, v]) => (
            <NestedField key={k} fieldName={k} value={v} colors={colors} />
          ))}
        </div>
      </div>
    );
  }

  // Fallback - better handling to avoid [object Object]
  const displayValue = (() => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return "[Complex object]";
      }
    }
    return String(value);
  })();

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
        {formatFieldName(fieldName)}
      </div>
      <div style={{ fontSize: 14, color: "#1e293b", whiteSpace: "pre-wrap" }}>{displayValue}</div>
    </div>
  );
}

// Card for object items in arrays (like individual characters, locations)
function ObjectCard({
  data,
  index,
  colors
}: {
  data: Record<string, unknown>;
  index: number;
  colors: { bg: string; accent: string; light: string };
}) {
  // Try to find a name/title field - check many common patterns
  const nameField = data.Name || data.name || data.Title || data.title || data.NameLabel || 
    data.EventTitle || data.ArcName || data.EpisodeId || data.Character || 
    data.Label || data.label || `Item ${index + 1}`;
  const headline = data.Headline || data.headline || data.Summary || data.summary || 
    data.Logline || data.logline || "";
  const role = data.Role || data.role || data.RoleType || data.TimeMarker || "";

  // Check for lead image
  const imagesObj = data.Images as Record<string, unknown> | undefined;
  const leadImage = imagesObj?.LeadImage as { url: string } | undefined;

  // Group fields into sections for better organization - skip fields already shown in header
  const skipFields = [
    "Name", "name", "Title", "title", "NameLabel", "EventTitle", "ArcName", "EpisodeId", "Character", "Label", "label",
    "Headline", "headline", "Summary", "summary", "Logline", "logline",
    "Images", "Role", "role", "RoleType", "TimeMarker"
  ];

  return (
    <div style={{ padding: 20 }}>
      {/* Header with image and name */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
        {leadImage?.url ? (
          <img
            src={leadImage.url}
            alt={String(nameField)}
            style={{
              width: 160,
              height: 160,
              objectFit: "contain",
              borderRadius: 12,
              border: "3px solid #fff",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              background: "#f8fafc"
            }}
          />
        ) : (
          <div
            style={{
              width: 160,
              height: 160,
              borderRadius: 12,
              background: `linear-gradient(135deg, ${colors.light} 0%, ${colors.bg} 100%)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 48,
              color: colors.accent,
              fontWeight: 700,
              border: `2px solid ${colors.light}`
            }}
          >
            {String(nameField).charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>{String(nameField)}</div>
          {role && (
            <span
              style={{
                display: "inline-block",
                background: colors.accent,
                color: "#fff",
                padding: "4px 10px",
                borderRadius: 16,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 6
              }}
            >
              {String(role)}
            </span>
          )}
          {headline && <div style={{ fontSize: 14, color: "#64748b", lineHeight: 1.4, marginTop: 4 }}>{String(headline)}</div>}
        </div>
      </div>

      {/* Other fields in a grid */}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {Object.entries(data)
          .filter(([k, v]) => !skipFields.includes(k) && v && v !== "Unknown")
          .map(([k, v]) => (
            <NestedField key={k} fieldName={k} value={v} colors={colors} />
          ))}
      </div>
    </div>
  );
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [manifestUrl, setManifestUrl] = useState<string>("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [lastError, setLastError] = useState<string>("");

  const [cloudOpen, setCloudOpen] = useState(true);

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [projectsBusy, setProjectsBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(true);
  const [settingsTab, setSettingsTab] = useState<"ai" | "tagging" | "schema" | "completeness" | "detection">("ai");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string>("");

  const [aiRulesDraft, setAiRulesDraft] = useState<string>("");
  const [taggingJsonDraft, setTaggingJsonDraft] = useState<string>("");
  const [schemaJsonDraft, setSchemaJsonDraft] = useState<string>("");
  const [completenessRulesDraft, setCompletenessRulesDraft] = useState<string>("");
  const [detectionRulesJsonDraft, setDetectionRulesJsonDraft] = useState<string>("");

  // Settings history state
  const [settingsHistory, setSettingsHistory] = useState<SettingsHistory>({});
  const [showHistoryPanel, setShowHistoryPanel] = useState<boolean>(false);

  // Intro modal state
  const [introOpen, setIntroOpen] = useState<boolean>(false);

  // AI Helper state
  type AiHelperMessage = { role: "user" | "assistant"; content: string };
  const [aiHelperOpen, setAiHelperOpen] = useState<boolean>(false);
  const [aiHelperMessages, setAiHelperMessages] = useState<AiHelperMessage[]>([]);
  const [aiHelperInput, setAiHelperInput] = useState<string>("");
  const [aiHelperLoading, setAiHelperLoading] = useState<boolean>(false);
  const [aiHelperProvider, setAiHelperProvider] = useState<"gemini" | "openai">("gemini");

  const [rasterProgress, setRasterProgress] = useState({
    running: false,
    currentPage: 0,
    totalPages: 0,
    uploaded: 0
  });

  const [splitProgress, setSplitProgress] = useState({
    running: false,
    page: 0,
    totalPages: 0,
    assetsUploaded: 0
  });

  const [taggingProgress, setTaggingProgress] = useState({
    running: false,
    total: 0,
    tagged: 0
  });

  const [assetsOpen, setAssetsOpen] = useState(true);
  const [deletingAssets, setDeletingAssets] = useState<Record<string, boolean>>({});

  const [textPanelOpen, setTextPanelOpen] = useState(false);
  const [extractedText, setExtractedText] = useState<string>("");
  const [formattedText, setFormattedText] = useState<string>("");
  const [textLoading, setTextLoading] = useState(false);

  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // Schema filling state
  const [schemaResultsOpen, setSchemaResultsOpen] = useState(false);
  const [schemaResults, setSchemaResults] = useState<string>("");
  const [schemaResultsDraft, setSchemaResultsDraft] = useState<string>("");
  const [schemaFillBusy, setSchemaFillBusy] = useState(false);
  const [schemaSaveBusy, setSchemaSaveBusy] = useState(false);
  const [schemaResultsTab, setSchemaResultsTab] = useState<string>("OVERVIEW");
  const [schemaResultsLevel, setSchemaResultsLevel] = useState<"L1" | "L2" | "L3">("L2");
  const [schemaResultsViewMode, setSchemaResultsViewMode] = useState<"ui" | "json">("ui");

  // Completeness calculation state
  const [completenessResult, setCompletenessResult] = useState<{
    overall: number;
    byDomain: Record<string, number>;
    alert: { color: string; message: string };
  } | null>(null);
  const [completenessVisible, setCompletenessVisible] = useState(false);

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setDebugLog((prev) => [...prev.slice(-99), `[${ts}] ${msg}`]);
  }

  // Helper to get current content for a settings tab
  function getCurrentSettingsContent(tab: typeof settingsTab): string {
    switch (tab) {
      case "ai": return aiRulesDraft;
      case "tagging": return taggingJsonDraft;
      case "schema": return schemaJsonDraft;
      case "completeness": return completenessRulesDraft;
      case "detection": return detectionRulesJsonDraft;
      default: return "";
    }
  }

  // Helper to get history key for a settings tab
  function getHistoryKey(tab: typeof settingsTab): keyof SettingsHistory {
    switch (tab) {
      case "ai": return "aiRules";
      case "tagging": return "taggingJson";
      case "schema": return "schemaJson";
      case "completeness": return "completenessRules";
      case "detection": return "detectionRulesJson";
      default: return "aiRules";
    }
  }

  // Save current content as a version snapshot
  function saveVersionSnapshot(label?: string) {
    const content = getCurrentSettingsContent(settingsTab);
    if (!content.trim()) return;

    const key = getHistoryKey(settingsTab);
    const entry: SettingsHistoryEntry = {
      timestamp: new Date().toISOString(),
      label: label || undefined,
      content
    };

    setSettingsHistory((prev) => {
      const existing = prev[key] ?? [];
      // Keep max 20 versions per tab
      const updated = [entry, ...existing].slice(0, 20);
      return { ...prev, [key]: updated };
    });
  }

  // Restore a version from history
  function restoreVersion(entry: SettingsHistoryEntry) {
    const content = entry.content;
    switch (settingsTab) {
      case "ai": setAiRulesDraft(content); break;
      case "tagging": setTaggingJsonDraft(content); break;
      case "schema": setSchemaJsonDraft(content); break;
      case "completeness": setCompletenessRulesDraft(content); break;
      case "detection": setDetectionRulesJsonDraft(content); break;
    }
    setShowHistoryPanel(false);
  }

  // Delete a version from history
  function deleteVersion(index: number) {
    const key = getHistoryKey(settingsTab);
    setSettingsHistory((prev) => {
      const existing = prev[key] ?? [];
      const updated = existing.filter((_, i) => i !== index);
      return { ...prev, [key]: updated };
    });
  }

  // AI Helper chat function
  async function sendAiHelperMessage() {
    if (!aiHelperInput.trim() || aiHelperLoading) return;

    const userMessage: AiHelperMessage = { role: "user", content: aiHelperInput.trim() };
    const newMessages = [...aiHelperMessages, userMessage];
    setAiHelperMessages(newMessages);
    setAiHelperInput("");
    setAiHelperLoading(true);

    try {
      const res = await fetch("/api/projects/settings/ai-helper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          settingsTab,
          currentContent: getCurrentSettingsContent(settingsTab),
          provider: aiHelperProvider
        })
      });

      const data = (await res.json()) as { ok: boolean; response?: string; error?: string };

      if (!res.ok || !data.ok) {
        setAiHelperMessages([
          ...newMessages,
          { role: "assistant", content: `Error: ${data.error || "Failed to get response"}` }
        ]);
      } else {
        setAiHelperMessages([...newMessages, { role: "assistant", content: data.response || "" }]);
      }
    } catch (err) {
      setAiHelperMessages([
        ...newMessages,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : String(err)}` }
      ]);
    } finally {
      setAiHelperLoading(false);
    }
  }

  // Apply AI suggestion to current settings
  function applyAiSuggestion(content: string) {
    // Extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const extracted = jsonMatch ? jsonMatch[1].trim() : content.trim();

    // Validate if it's valid JSON for JSON tabs
    if (settingsTab !== "ai") {
      try {
        JSON.parse(extracted);
      } catch {
        // Not valid JSON, don't apply
        return;
      }
    }

    switch (settingsTab) {
      case "ai": setAiRulesDraft(extracted); break;
      case "tagging": setTaggingJsonDraft(extracted); break;
      case "schema": setSchemaJsonDraft(extracted); break;
      case "completeness": setCompletenessRulesDraft(extracted); break;
      case "detection": setDetectionRulesJsonDraft(extracted); break;
    }
  }

  async function loadManifest(url: string) {
    const mRes = await fetch("/api/projects/manifest/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifestUrl: url })
    });

    if (!mRes.ok) throw new Error(`Failed to read manifest: ${await readErrorText(mRes)}`);

    const payload = (await mRes.json()) as { ok: boolean; manifest?: Manifest; error?: string };
    if (!payload.ok || !payload.manifest) throw new Error(payload.error || "Bad manifest read response");

    const m = payload.manifest;
    setManifest(m);
    setAiRulesDraft(m.settings?.aiRules ?? "");
    setTaggingJsonDraft(m.settings?.taggingJson ?? "");
    setSchemaJsonDraft(m.settings?.schemaJson ?? "");
    setCompletenessRulesDraft(m.settings?.completenessRules ?? "");
    setDetectionRulesJsonDraft(m.settings?.detectionRulesJson ?? "");
    setSettingsHistory(m.settings?.history ?? {});

    // Load cached formatted text if available
    if (m.formattedText?.url) {
      try {
        const res = await fetch(m.formattedText.url);
        if (res.ok) {
          const text = await res.text();
          setFormattedText(text);
        }
      } catch {
        // Ignore errors loading cached text
      }
    }

    // Load cached extracted text if available
    if (m.extractedText?.url) {
      try {
        const res = await fetch(m.extractedText.url);
        if (res.ok) {
          const text = await res.text();
          setExtractedText(text);
        }
      } catch {
        // Ignore errors loading extracted text
      }
    }

    // Load cached schema results if available
    if (m.schemaResults?.url) {
      try {
        const res = await fetch(m.schemaResults.url);
        if (res.ok) {
          const text = await res.text();
          setSchemaResults(text);
          setSchemaResultsDraft(text);
        }
      } catch {
        // Ignore errors loading schema results
      }
    } else {
      setSchemaResults("");
      setSchemaResultsDraft("");
    }

    return m;
  }

  async function refreshProjects() {
    setProjectsBusy(true);
    try {
      const r = await fetch("/api/projects/list", { cache: "no-store" });
      if (!r.ok) throw new Error(await readErrorText(r));
      const j = (await r.json()) as { ok: boolean; projects?: ProjectRow[]; error?: string };
      if (!j.ok || !Array.isArray(j.projects)) throw new Error(j.error || "Bad /list response");
      setProjects(j.projects);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsBusy(false);
    }
  }

  useEffect(() => {
    const { pid, m } = getUrlParams();
    if (pid && m) {
      setProjectId(pid);
      setManifestUrl(m);
      loadManifest(m).catch((e) => setLastError(e instanceof Error ? e.message : String(e)));
    }
    refreshProjects().catch(() => {});
  }, []);

  async function createProject() {
    const r = await fetch("/api/projects/create", { method: "POST" });
    if (!r.ok) throw new Error(`Create project failed: ${await readErrorText(r)}`);

    const j = (await r.json()) as { ok: boolean; projectId?: string; manifestUrl?: string; error?: string };
    if (!j.ok || !j.projectId || !j.manifestUrl) throw new Error(j.error || "Create project failed (bad response)");

    setProjectId(j.projectId);
    setManifestUrl(j.manifestUrl);
    setUrlParams(j.projectId, j.manifestUrl);

    await loadManifest(j.manifestUrl);
    await refreshProjects();

    return { projectId: j.projectId, manifestUrl: j.manifestUrl };
  }

  async function uploadSource(file: File) {
    setLastError("");
    setBusy("Uploading SOURCE...");

    // Preserve current settings before creating new project
    const savedSettings = {
      aiRules: aiRulesDraft,
      taggingJson: taggingJsonDraft,
      schemaJson: schemaJsonDraft,
      completenessRules: completenessRulesDraft,
      detectionRulesJson: detectionRulesJsonDraft,
      history: settingsHistory
    };

    // Clear data fields since we're starting fresh with a new source
    // (but keep settings - they'll be restored after loadManifest)
    setSchemaResults("");
    setSchemaResultsDraft("");
    setFormattedText("");
    setExtractedText("");
    setManifest(null);

    try {
      // Always create a new project for each upload
      const p = await createProject();

      // Use client-side upload to bypass serverless function size limits
      const blob = await upload(`projects/${p.projectId}/source/source.pdf`, file, {
        access: "public",
        handleUploadUrl: "/api/blob"
      });

      // Record the PDF URL in the manifest
      const r = await fetch("/api/projects/record-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: p.projectId,
          manifestUrl: p.manifestUrl,
          sourcePdfUrl: blob.url,
          filename: file.name
        })
      });
      if (!r.ok) throw new Error(`Record source failed: ${await readErrorText(r)}`);

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record source failed (bad response)");

      setManifestUrl(j.manifestUrl);
      setUrlParams(p.projectId, j.manifestUrl);

      await loadManifest(j.manifestUrl);

      // Restore settings from previous project (loadManifest clears them for new projects)
      setAiRulesDraft(savedSettings.aiRules);
      setTaggingJsonDraft(savedSettings.taggingJson);
      setSchemaJsonDraft(savedSettings.schemaJson);
      setCompletenessRulesDraft(savedSettings.completenessRules);
      setDetectionRulesJsonDraft(savedSettings.detectionRulesJson);
      setSettingsHistory(savedSettings.history);

      await refreshProjects();
    } finally {
      setBusy("");
    }
  }

  async function processPdf() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF");
    if (busy) return;

    setBusy("Processing...");
    log("Starting DocAI processing...");

    try {
      const r = await fetch("/api/projects/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Process failed (bad response)");

      log("DocAI processing complete");
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);

      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Process error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
    }
  }

  async function recordPage(pageNumber: number, url: string, width: number, height: number, currentManifestUrl: string): Promise<string> {
    const r = await fetch("/api/projects/pages/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl: currentManifestUrl, pageNumber, url, width, height })
    });

    if (!r.ok) throw new Error(await readErrorText(r));

    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || `Record page ${pageNumber} failed (bad response)`);

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);
    return j.manifestUrl;
  }

  async function rasterizeToPngs() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF");
    if (busy || rasterProgress.running) return;

    setBusy("Rasterizing...");
    setRasterProgress({ running: true, currentPage: 0, totalPages: 0, uploaded: 0 });
    log("Starting rasterization...");

    try {
      const pdfjsImport = (await import("pdfjs-dist")) as unknown as PdfJsLib;
      setPdfJsWorker(pdfjsImport);

      const loadingTask = pdfjsImport.getDocument({ url: manifest.sourcePdf.url, withCredentials: false });
      const pdf = await loadingTask.promise;

      const totalPages = Number(pdf.numPages) || 0;
      setRasterProgress((p) => ({ ...p, totalPages }));
      log(`PDF has ${totalPages} pages`);

      // Collect all page data first, then save in one batch at the end
      const allPages: Array<{ pageNumber: number; url: string; width: number; height: number }> = [];

      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        setRasterProgress((p) => ({ ...p, currentPage: pageNumber }));

        const page = await pdf.getPage(pageNumber);
        const scale = 1.25;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Cannot create canvas 2D context");

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));

        await page.render({ canvasContext: ctx, viewport }).promise;

        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png");
        });

        const file = new File([pngBlob], `page-${pageNumber}.png`, { type: "image/png" });

        const blob = await upload(`projects/${projectId}/pages/page-${pageNumber}.png`, file, {
          access: "public",
          handleUploadUrl: "/api/blob"
        });

        // Collect page data instead of saving one by one
        allPages.push({
          pageNumber,
          url: blob.url,
          width: canvas.width,
          height: canvas.height
        });

        setRasterProgress((p) => ({ ...p, uploaded: p.uploaded + 1 }));
        log(`Uploaded page ${pageNumber}/${totalPages}`);
      }

      // Now save all pages in one bulk operation to avoid race conditions
      log(`Saving ${allPages.length} pages to manifest...`);
      const r = await fetch("/api/projects/pages/record-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, pages: allPages })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record bulk pages failed");

      log(`All ${allPages.length} pages saved successfully`);
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);

      // Load final manifest at the end
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Rasterization error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setRasterProgress((p) => ({ ...p, running: false }));
    }
  }

  async function recordAssetsBulk(pageNumber: number, assets: Array<{ assetId: string; url: string; bbox: AssetBBox }>) {
    const r = await fetch("/api/projects/assets/record-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl, pageNumber, assets })
    });

    if (!r.ok) throw new Error(await readErrorText(r));

    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record bulk failed (bad response)");

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);
    await loadManifest(j.manifestUrl);
  }

  async function splitImages() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.pages?.length) return setLastError("No page PNGs - run Rasterize first");
    if (busy || splitProgress.running) return;

    const pages = manifest.pages;

    // Parse detection rules from settings
    let detectionRules: object | undefined;
    if (detectionRulesJsonDraft.trim()) {
      try {
        detectionRules = JSON.parse(detectionRulesJsonDraft) as object;
      } catch {
        return setLastError("Invalid Detection Rules JSON");
      }
    }

    setBusy("Detecting images...");
    setSplitProgress({ running: true, page: 0, totalPages: pages.length, assetsUploaded: 0 });
    log("Starting image detection with Gemini...");

    try {
      for (const page of pages) {
        setSplitProgress((s) => ({ ...s, page: page.pageNumber }));
        log(`Detecting images on page ${page.pageNumber}...`);

        // Use Gemini to detect images on this page
        const detectRes = await fetch("/api/projects/assets/detect-gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageUrl: page.url,
            pageWidth: page.width,
            pageHeight: page.height,
            detectionRules
          })
        });

        if (!detectRes.ok) {
          log(`Detection failed for page ${page.pageNumber}: ${await readErrorText(detectRes)}`);
          continue;
        }

        const detected = (await detectRes.json()) as { boxes?: Array<{ x: number; y: number; width: number; height: number; category?: string }>; error?: string };
        const boxes = detected.boxes ?? [];
        log(`Found ${boxes.length} images on page ${page.pageNumber}`);

        if (boxes.length === 0) continue;

        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.crossOrigin = "anonymous";
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error(`Failed to load page image p${page.pageNumber}`));
          el.src = bust(page.url);
        });

        const uploadedForPage: Array<{ assetId: string; url: string; bbox: AssetBBox }> = [];

        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          // Convert from {x, y, width, height} to {x, y, w, h}
          const bbox: AssetBBox = { x: b.x, y: b.y, w: b.width, h: b.height };

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Cannot create canvas 2D context");

          canvas.width = Math.max(1, Math.floor(bbox.w));
          canvas.height = Math.max(1, Math.floor(bbox.h));

          ctx.drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, canvas.width, canvas.height);

          const pngBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((bb) => (bb ? resolve(bb) : reject(new Error("toBlob returned null"))), "image/png");
          });

          const assetId = `p${page.pageNumber}-img${String(i + 1).padStart(2, "0")}`;
          const file = new File([pngBlob], `${assetId}.png`, { type: "image/png" });

          const uploaded = await upload(`projects/${projectId}/assets/p${page.pageNumber}/${assetId}.png`, file, {
            access: "public",
            handleUploadUrl: "/api/blob"
          });

          uploadedForPage.push({ assetId, url: uploaded.url, bbox });

          setSplitProgress((s) => ({ ...s, assetsUploaded: s.assetsUploaded + 1 }));
          log(`Uploaded asset ${assetId}`);
        }

        if (uploadedForPage.length > 0) {
          await recordAssetsBulk(page.pageNumber, uploadedForPage);
        }
      }

      log("Detection complete");
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Detection error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setSplitProgress((s) => ({ ...s, running: false }));
    }
  }

  async function rebuildAssets() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setBusy("Rebuilding assets...");
    try {
      const r = await fetch("/api/projects/assets/rebuild-index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Rebuild failed (${r.status})`);

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function restoreFromBlob() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setBusy("Restoring from blob storage...");
    log("Starting restore from blob storage...");
    try {
      const r = await fetch("/api/projects/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = (await r.json()) as { 
        ok: boolean; 
        manifestUrl?: string; 
        error?: string;
        pagesFound?: number;
        assetsFound?: number;
        pagesInManifest?: number;
      };
      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Restore failed (${r.status})`);

      log(`Restore complete: ${j.pagesFound} page blobs, ${j.assetsFound} asset blobs, ${j.pagesInManifest} pages in manifest`);
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Restore error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
    }
  }

  async function tagAssets() {
    setLastError("");
    if (!projectId || !manifestUrl) return;
    if (!manifest?.pages?.length) {
      setLastError("No pages to tag.");
      return;
    }

    // Count total assets
    let totalAssets = 0;
    for (const p of manifest.pages) {
      totalAssets += (p.assets ?? []).length;
    }

    if (totalAssets === 0) {
      log("No assets to tag.");
      return;
    }

    setBusy("Tagging assets...");
    setTaggingProgress({ running: true, total: totalAssets, tagged: 0 });
    log(`Starting tagging of ${totalAssets} assets (overwrite mode)...`);

    try {
      const r = await fetch("/api/projects/assets/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, overwrite: true })
      });

      const j = (await r.json()) as {
        ok: boolean;
        manifestUrl?: string;
        error?: string;
        considered?: number;
        tagged?: number;
        failed?: number;
        errors?: Array<{ pageNumber: number; assetId: string; error: string }>;
        timedOut?: boolean;
        message?: string;
      };

      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Tagging failed (${r.status})`);

      let logMsg = `Tagging complete: ${j.tagged} assets tagged out of ${j.considered} considered`;
      if (j.failed && j.failed > 0) {
        logMsg += ` (${j.failed} failed)`;
        if (j.errors && j.errors.length > 0) {
          const firstErr = j.errors[0];
          log(`First error: ${firstErr.assetId} - ${firstErr.error}`);
        }
      }
      if (j.timedOut) {
        logMsg += ` - PARTIAL (time limit reached, run again to continue)`;
      }
      log(logMsg);
      setTaggingProgress((s) => ({ ...s, tagged: j.tagged ?? 0 }));

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Tagging error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setTaggingProgress((s) => ({ ...s, running: false }));
    }
  }

  async function fillSchema() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setSchemaFillBusy(true);
    setBusy("Filling schema with AI...");
    log("Starting schema fill...");

    try {
      const r = await fetch("/api/projects/schema/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = (await r.json()) as {
        ok: boolean;
        results?: string;
        error?: string;
      };

      if (!r.ok || !j.ok || !j.results) throw new Error(j.error || `Schema fill failed (${r.status})`);

      log("Schema fill complete");
      setSchemaResultsDraft(j.results);
      setSchemaResultsOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Schema fill error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setSchemaFillBusy(false);
    }
  }

  async function saveSchemaResults() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setSchemaSaveBusy(true);
    log("Saving schema results...");

    try {
      const r = await fetch("/api/projects/schema/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, results: schemaResultsDraft })
      });

      const j = (await r.json()) as {
        ok: boolean;
        manifestUrl?: string;
        error?: string;
      };

      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Schema save failed (${r.status})`);

      log("Schema results saved");
      setSchemaResults(schemaResultsDraft);
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Schema save error: ${msg}`);
      setLastError(msg);
    } finally {
      setSchemaSaveBusy(false);
    }
  }

  async function deleteProject(targetProjectId: string) {
    const ok = window.confirm(`Delete project ${targetProjectId}?`);
    if (!ok) return;

    setLastError("");
    setProjectsBusy(true);

    try {
      const r = await fetch("/api/projects/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: targetProjectId })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      if (targetProjectId === projectId) {
        setProjectId("");
        setManifestUrl("");
        setManifest(null);
        setAiRulesDraft("");
        setTaggingJsonDraft("");
        clearUrlParams();
      }

      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsBusy(false);
    }
  }

  async function openProject(p: ProjectRow) {
    setLastError("");
    setProjectId(p.projectId);
    setManifestUrl(p.manifestUrl);
    setUrlParams(p.projectId, p.manifestUrl);

    try {
      await loadManifest(p.manifestUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      await refreshProjects();
    }
  }

  async function saveSettings() {
    setSettingsError("");
    if (!projectId || !manifestUrl) {
      setSettingsError("No active project.");
      return;
    }

    // Validate taggingJson is valid JSON
    try {
      JSON.parse(taggingJsonDraft);
    } catch {
      setSettingsError("Tagging JSON is invalid.");
      return;
    }

    // Validate schemaJson is valid JSON (if not empty)
    if (schemaJsonDraft.trim()) {
      try {
        JSON.parse(schemaJsonDraft);
      } catch {
        setSettingsError("Schema JSON is invalid.");
        return;
      }
    }

    // Validate completenessRules is valid JSON (if not empty)
    if (completenessRulesDraft.trim()) {
      try {
        JSON.parse(completenessRulesDraft);
      } catch {
        setSettingsError("Completeness Rules JSON is invalid.");
        return;
      }
    }

    // Validate detectionRulesJson is valid JSON (if not empty)
    if (detectionRulesJsonDraft.trim()) {
      try {
        JSON.parse(detectionRulesJsonDraft);
      } catch {
        setSettingsError("Detection Rules JSON is invalid.");
        return;
      }
    }

    setSettingsBusy(true);
    try {
      const r = await fetch("/api/projects/settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          manifestUrl,
          aiRules: aiRulesDraft,
          taggingJson: taggingJsonDraft,
          schemaJson: schemaJsonDraft,
          completenessRules: completenessRulesDraft,
          detectionRulesJson: detectionRulesJsonDraft,
          history: settingsHistory
        })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Save failed (bad response)");

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);

      await refreshProjects();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function loadExtractedText() {
    if (!manifest?.extractedText?.url) {
      setLastError("No extracted text available. Run 'Process Text' first.");
      return;
    }

    setTextLoading(true);
    log("Loading extracted text...");

    try {
      // Load raw extracted text
      const res = await fetch(manifest.extractedText.url);
      if (!res.ok) throw new Error(`Failed to fetch text: ${res.status}`);
      const raw = await res.text();
      setExtractedText(raw);
      log(`Loaded ${raw.length} chars of extracted text`);

      // Check if we have cached formatted text
      if (manifest.formattedText?.url) {
        log("Loading cached formatted text...");
        const cachedRes = await fetch(manifest.formattedText.url);
        if (cachedRes.ok) {
          const cachedText = await cachedRes.text();
          setFormattedText(cachedText);
          log("Loaded cached formatted text");
          setTextPanelOpen(true);
          return;
        }
        log("Failed to load cached text, re-formatting...");
      }

      // Format with Gemini and cache the result
      log("Formatting with Gemini...");
      const fRes = await fetch("/api/projects/format-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, text: raw })
      });

      if (!fRes.ok) {
        log("Gemini formatting failed, showing raw text");
        setFormattedText(raw);
      } else {
        const fj = (await fRes.json()) as { ok: boolean; formatted?: string; manifestUrl?: string; error?: string };
        if (fj.ok && fj.formatted) {
          setFormattedText(fj.formatted);
          log("Text formatted and cached successfully");
          // Update manifest URL if it changed (due to caching)
          if (fj.manifestUrl) {
            setManifestUrl(fj.manifestUrl);
            setUrlParams(projectId, fj.manifestUrl);
            await loadManifest(fj.manifestUrl);
          }
        } else {
          log(fj.error || "Format failed, showing raw");
          setFormattedText(raw);
        }
      }

      setTextPanelOpen(true);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
      log(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTextLoading(false);
    }
  }

  async function deleteAsset(pageNumber: number, assetId: string) {
    if (!projectId || !manifestUrl) return;

    const key = `${pageNumber}-${assetId}`;
    if (deletingAssets[key]) return;

    setDeletingAssets((m) => ({ ...m, [key]: true }));
    setLastError("");

    setManifest((prev) => {
      if (!prev?.pages) return prev;
      return {
        ...prev,
        pages: prev.pages.map((p) => {
          if (p.pageNumber !== pageNumber) return p;
          const assets = Array.isArray(p.assets) ? p.assets : [];
          const deleted = Array.isArray(p.deletedAssetIds) ? p.deletedAssetIds : [];
          const nextDeleted = deleted.includes(assetId) ? deleted : [...deleted, assetId];
          return { ...p, assets: assets.filter((a) => a.assetId !== assetId), deletedAssetIds: nextDeleted };
        })
      };
    });

    try {
      const r = await fetch("/api/projects/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, pageNumber, assetId })
      });

      const j = (await r.json().catch(() => null)) as { ok?: boolean; manifestUrl?: string; error?: string } | null;
      if (!r.ok || !j?.ok || !j.manifestUrl) throw new Error(j?.error || `Delete failed (${r.status})`);

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
      await loadManifest(manifestUrl);
    } finally {
      setDeletingAssets((m) => {
        const copy = { ...m };
        delete copy[key];
        return copy;
      });
    }
  }

  const pagesCount = manifest?.pages?.length ?? 0;

  const totalAssetsCount =
    (manifest?.pages ?? []).reduce((acc, p) => acc + (Array.isArray(p.assets) ? p.assets.length : 0), 0) ?? 0;

  const assetsFlat = useMemo(() => {
    const out: Array<{ pageNumber: number; asset: PageAsset }> = [];
    for (const p of manifest?.pages ?? []) {
      for (const a of p.assets ?? []) out.push({ pageNumber: p.pageNumber, asset: a });
    }
    return out;
  }, [manifest]);

  const taggedAssetsCount = useMemo(() => {
    let n = 0;
    for (const p of manifest?.pages ?? []) {
      for (const a of p.assets ?? []) {
        if (Array.isArray(a.tags) && a.tags.length > 0) n += 1;
      }
    }
    return n;
  }, [manifest]);

  const assetCard = (pageNumber: number, asset: PageAsset) => {
    const tags = Array.isArray(asset.tags) ? asset.tags : [];
    const delKey = `${pageNumber}-${asset.assetId}`;
    const delBusy = !!deletingAssets[delKey] || !!busy;

    return (
      <div
        key={`${pageNumber}-${asset.assetId}`}
        style={{
          border: "1px solid rgba(0,0,0,0.25)",
          borderRadius: 12,
          overflow: "hidden",
          background: "#fff",
          position: "relative"
        }}
      >
        <button
          type="button"
          aria-label="Delete asset"
          disabled={delBusy}
          onClick={() => void deleteAsset(pageNumber, asset.assetId)}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 28,
            height: 28,
            borderRadius: 10,
            border: "1px solid #000",
            background: "#fff",
            display: "grid",
            placeItems: "center",
            opacity: delBusy ? 0.4 : 1,
            cursor: delBusy ? "not-allowed" : "pointer",
            zIndex: 2
          }}
        >
          <XIcon />
        </button>

        <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.03)" }}>
          <img
            src={bust(asset.url)}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        </div>

        <div style={{ padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 800 }}>
            p{pageNumber} · {asset.assetId}
          </div>

          {tags.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {tags.slice(0, 20).map((t) => (
                <span
                  key={t}
                  style={{
                    border: "1px solid rgba(0,0,0,0.25)",
                    borderRadius: 999,
                    padding: "3px 8px",
                    fontSize: 12
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      {/* Row 1: App name + Intro button */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.3 }}>OTHERLY — Ingest 1.0</div>
        <button
          type="button"
          onClick={() => setIntroOpen(true)}
          style={{
            border: "1px solid #000",
            background: "#fff",
            padding: "8px 16px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer"
          }}
        >
          Intro
        </button>
      </div>

      {/* Intro Modal */}
      {introOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999
          }}
          onClick={() => setIntroOpen(false)}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: 32,
              maxWidth: 720,
              maxHeight: "80vh",
              overflow: "auto",
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
              <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Canon Ingest — IP Bible Digitization Tool</h1>
              <button
                type="button"
                onClick={() => setIntroOpen(false)}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: 24,
                  cursor: "pointer",
                  padding: 4,
                  lineHeight: 1
                }}
              >
                ×
              </button>
            </div>

            <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 0, marginBottom: 12 }}>Overview</h2>
            <p style={{ margin: "0 0 12px 0", lineHeight: 1.6 }}>
              Canon Ingest is an AI-powered platform that transforms creative IP (Intellectual Property) documents—story bibles, scripts, pitch decks, and development materials—into structured, searchable, production-ready data.
            </p>
            <p style={{ margin: "0 0 20px 0", lineHeight: 1.6 }}>
              This is a debug/testing app designed to evaluate different AI configurations and settings to determine the optimal setup for the OTHERLY PLATFORM.
            </p>

            <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 0, marginBottom: 12 }}>Workflow</h2>
            <p style={{ margin: "0 0 12px 0", lineHeight: 1.6 }}>The app follows a strict sequential workflow:</p>
            <ol style={{ margin: "0 0 20px 0", paddingLeft: 20, lineHeight: 1.8 }}>
              <li><strong>Load Source</strong> — Upload PDF documents</li>
              <li><strong>Process Text</strong> — Extract text content from pages</li>
              <li><strong>View Text</strong> — Review extracted text</li>
              <li><strong>Rasterize PNGs</strong> — Convert PDF pages to images</li>
              <li><strong>Detect Images</strong> — AI identifies and crops images from pages</li>
              <li><strong>Tag Assets</strong> — AI categorizes and labels extracted images</li>
              <li><strong>Fill Schema</strong> — AI populates the structured data schema</li>
              <li><strong>Completeness %</strong> — Review extraction quality score</li>
            </ol>

            <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 0, marginBottom: 12 }}>How to Use</h2>
            <ul style={{ margin: "0 0 20px 0", paddingLeft: 20, lineHeight: 1.8 }}>
              <li><strong>Follow the numbered order:</strong> Each step should be activated and verified in sequence before proceeding.</li>
              <li><strong>Steps 5–8 can be skipped,</strong> but results in subsequent stages will be less effective.</li>
              <li><strong>Re-running a step</strong> will update that field&apos;s results, but downstream steps must be re-run to reflect those changes.</li>
              <li><strong>AI Helper:</strong> A chatbot is available to assist with writing JSON instructions for settings.</li>
              <li><strong>Save your work:</strong> Use the &quot;Save Version&quot; button to create snapshots of your JSON settings. This preserves your configurations and allows others to work with the app without losing information.</li>
            </ul>

            <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 0, marginBottom: 12, color: "#c00" }}>Known Bugs</h2>
            <ul style={{ margin: "0 0 12px 0", paddingLeft: 20, lineHeight: 1.8 }}>
              <li>The Save and Delete buttons sometimes require multiple clicks (you may need to re-paste your content before saving).</li>
              <li>To reliably save JSON settings: click &quot;Save Version&quot; first, then click the black &quot;Save&quot; button on the right.</li>
              <li>This is a known issue with Vercel Blob storage. As an internal testing app, this is acceptable for now—we plan to fix it soon.</li>
            </ul>
          </div>
        </div>
      )}

      {/* Row 2: Main workflow buttons */}
      <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => fileRef.current?.click()}
          style={{ border: "1px solid #000", background: "#fff", padding: "10px 12px", borderRadius: 12 }}
        >
          1. Load Source
        </button>

        <button
          type="button"
          disabled={!manifest?.sourcePdf?.url || !!busy}
          onClick={() => void processPdf()}
          style={{
            border: "1px solid #000",
            background: manifest?.sourcePdf?.url && !busy ? "#000" : "#fff",
            color: manifest?.sourcePdf?.url && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifest?.sourcePdf?.url && !busy ? 1 : 0.4
          }}
        >
          2. Process Text
        </button>

        <button
          type="button"
          disabled={!manifest?.extractedText?.url || !!busy || textLoading}
          onClick={() => void loadExtractedText()}
          style={{
            border: "1px solid #000",
            background: manifest?.extractedText?.url && !busy ? "#000" : "#fff",
            color: manifest?.extractedText?.url && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifest?.extractedText?.url && !busy ? 1 : 0.4
          }}
        >
          {textLoading ? "Loading..." : "3. View Text"}
        </button>

        <button
          type="button"
          disabled={!manifest?.sourcePdf?.url || !!busy || rasterProgress.running}
          onClick={() => void rasterizeToPngs()}
          style={{
            border: "1px solid #000",
            background: manifest?.sourcePdf?.url && !busy ? "#000" : "#fff",
            color: manifest?.sourcePdf?.url && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifest?.sourcePdf?.url && !busy ? 1 : 0.4
          }}
        >
          4. Rasterize PNGs
        </button>

        <button
          type="button"
          disabled={!manifest?.pages?.length || !!busy || splitProgress.running}
          onClick={() => void splitImages()}
          style={{
            border: "1px solid #000",
            background: manifest?.pages?.length && !busy ? "#000" : "#fff",
            color: manifest?.pages?.length && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifest?.pages?.length && !busy ? 1 : 0.4
          }}
        >
          5. Detect Images
        </button>

        <button
          type="button"
          disabled={!totalAssetsCount || !!busy || taggingProgress.running}
          onClick={() => void tagAssets()}
          style={{
            border: "1px solid #000",
            background: totalAssetsCount && !busy ? "#000" : "#fff",
            color: totalAssetsCount && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: totalAssetsCount && !busy ? 1 : 0.4
          }}
        >
          6. Tag Assets
        </button>

        <button
          type="button"
          disabled={!manifestUrl || !!busy || schemaFillBusy}
          onClick={() => void fillSchema()}
          style={{
            border: "1px solid #000",
            background: manifestUrl && !busy && !schemaFillBusy ? "#000" : "#fff",
            color: manifestUrl && !busy && !schemaFillBusy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifestUrl && !busy && !schemaFillBusy ? 1 : 0.4
          }}
        >
          7. Fill Schema
        </button>

        <button
          type="button"
          disabled={!schemaResultsDraft}
          onClick={() => {
            if (!schemaResultsDraft) return;
            // Always recalculate on click
            try {
              const parsed = JSON.parse(schemaResultsDraft);
              const levelData = parsed[schemaResultsLevel] || parsed["L2"] || {};
              const result = calculateCompleteness(levelData, completenessRulesDraft);
              setCompletenessResult(result);
              setCompletenessVisible(true);
            } catch {
              setCompletenessResult({ overall: 0, byDomain: {}, alert: { color: "#ef4444", message: "Invalid schema JSON" } });
              setCompletenessVisible(true);
            }
          }}
          style={{
            border: "1px solid #000",
            background: schemaResultsDraft ? "#000" : "#fff",
            color: schemaResultsDraft ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: schemaResultsDraft ? 1 : 0.4,
            display: "flex",
            alignItems: "center",
            gap: 6
          }}
        >
          8. Completeness %
          {completenessVisible && completenessResult && (
            <span style={{
              background: completenessResult.alert.color,
              color: "#fff",
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 700
            }}>
              {completenessResult.overall}%
            </span>
          )}
        </button>
      </div>

      {/* Row 3: Utility buttons aligned right */}
      <div style={{ marginTop: 12, display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          disabled={!manifestUrl || !projectId || !!busy}
          onClick={() => void rebuildAssets()}
          style={{
            border: "1px solid #000",
            background: "#fff",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: !manifestUrl || !projectId || busy ? 0.4 : 1
          }}
        >
          Rebuild assets
        </button>

        <button
          type="button"
          disabled={!manifestUrl || !projectId || !!busy}
          onClick={() => void restoreFromBlob()}
          style={{
            border: "1px solid #000",
            background: "#fff",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: !manifestUrl || !projectId || busy ? 0.4 : 1
          }}
        >
          Restore
        </button>
      </div>

      {/* Working Panel */}
      {!!busy && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Working</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{busy}</div>

          {rasterProgress.totalPages > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Raster: {rasterProgress.currentPage}/{rasterProgress.totalPages} · {rasterProgress.uploaded}/
              {rasterProgress.totalPages}
            </div>
          )}

          {splitProgress.totalPages > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Detect: {splitProgress.page}/{splitProgress.totalPages} · {splitProgress.assetsUploaded} assets
            </div>
          )}

          {taggingProgress.running && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Tagging: {taggingProgress.tagged}/{taggingProgress.total} assets
            </div>
          )}
        </div>
      )}

      {/* Error Panel */}
      {!!lastError && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Error</div>
          <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{lastError}</div>
        </div>
      )}

      {/* Debug Log Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Debug Log ({debugLog.length})</div>
          <button
            type="button"
            aria-label={debugLogOpen ? "Collapse log" : "Expand log"}
            onClick={() => setDebugLogOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={debugLogOpen} />
          </button>
        </div>

        {debugLogOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {debugLog.length > 0 ? (
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  maxHeight: 200,
                  overflow: "auto",
                  background: "#1a1a1a",
                  color: "#0f0",
                  padding: 10,
                  borderRadius: 6
                }}
              >
                {debugLog.join("\n")}
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.6 }}>No log entries yet.</div>
            )}
            <button
              type="button"
              onClick={() => setDebugLog([])}
              style={{
                marginTop: 8,
                border: "1px solid #000",
                background: "#fff",
                padding: "6px 10px",
                borderRadius: 8,
                fontSize: 12
              }}
            >
              Clear Log
            </button>
          </div>
        )}
      </div>

      {/* Cloud State Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Cloud state</div>

          <button
            type="button"
            aria-label={cloudOpen ? "Collapse cloud state" : "Expand cloud state"}
            onClick={() => setCloudOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={cloudOpen} />
          </button>
        </div>

        {cloudOpen && (
          <div style={{ padding: "0 14px 14px 14px", fontSize: 13 }}>
            <div>
              <span style={{ opacity: 0.7 }}>projectId:</span> {projectId || "—"}
            </div>

            <div style={{ marginTop: 6 }}>
              <span style={{ opacity: 0.7 }}>status:</span> {manifest?.status || "—"}
            </div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>manifestUrl:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifestUrl || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>sourcePdf:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.sourcePdf?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>extractedText:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.extractedText?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>docAiJson:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.docAiJson?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>pages:</span> {pagesCount}
            </div>

            <div style={{ marginTop: 6 }}>
              <span style={{ opacity: 0.7 }}>assets:</span> {totalAssetsCount}
            </div>
          </div>
        )}
      </div>

      {/* Settings Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Settings</div>
          <button
            type="button"
            aria-label={settingsOpen ? "Collapse settings" : "Expand settings"}
            onClick={() => setSettingsOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={settingsOpen} />
          </button>
        </div>

        {settingsOpen && (
          <div style={{ padding: "0 14px 14px 14px", overflow: "hidden", width: "100%", boxSizing: "border-box" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", overflow: "hidden", width: "100%" }}>
              <Tabs value={settingsTab} onChange={setSettingsTab} />

              <button
                type="button"
                disabled={settingsBusy || !projectId || !manifestUrl}
                onClick={() => void saveSettings()}
                style={{
                  border: "1px solid #000",
                  background: "#000",
                  color: "#fff",
                  padding: "8px 10px",
                  borderRadius: 10,
                  opacity: settingsBusy || !projectId || !manifestUrl ? 0.5 : 1,
                  cursor: settingsBusy || !projectId || !manifestUrl ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 800,
                  whiteSpace: "nowrap"
                }}
              >
                {settingsBusy ? "Saving..." : "Save"}
              </button>
            </div>

            {/* Version History Controls + AI Helper */}
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => saveVersionSnapshot()}
                disabled={!getCurrentSettingsContent(settingsTab).trim()}
                style={{
                  border: "1px solid #000",
                  background: "#fff",
                  padding: "6px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  cursor: getCurrentSettingsContent(settingsTab).trim() ? "pointer" : "not-allowed",
                  opacity: getCurrentSettingsContent(settingsTab).trim() ? 1 : 0.5
                }}
              >
                📸 Save Version
              </button>
              <button
                type="button"
                onClick={() => setShowHistoryPanel((v) => !v)}
                style={{
                  border: "1px solid #000",
                  background: showHistoryPanel ? "#eee" : "#fff",
                  padding: "6px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  cursor: "pointer"
                }}
              >
                📜 History ({(settingsHistory[getHistoryKey(settingsTab)] ?? []).length})
              </button>
              <button
                type="button"
                onClick={() => setAiHelperOpen((v) => !v)}
                style={{
                  border: "1px solid #6366f1",
                  background: aiHelperOpen ? "#6366f1" : "#fff",
                  color: aiHelperOpen ? "#fff" : "#6366f1",
                  padding: "6px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                🤖 AI Helper
              </button>
            </div>

            {/* History Panel */}
            {showHistoryPanel && (
              <div style={{
                marginTop: 10,
                border: "1px solid rgba(0,0,0,0.3)",
                borderRadius: 10,
                padding: 10,
                maxHeight: 200,
                overflowY: "auto",
                background: "#fafafa"
              }}>
                <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8 }}>
                  Version History — {settingsTab.charAt(0).toUpperCase() + settingsTab.slice(1)}
                </div>
                {(settingsHistory[getHistoryKey(settingsTab)] ?? []).length === 0 ? (
                  <div style={{ fontSize: 12, color: "#666" }}>No saved versions yet. Click &quot;Save Version&quot; to create a snapshot.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {(settingsHistory[getHistoryKey(settingsTab)] ?? []).map((entry, i) => (
                      <div key={i} style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 8px",
                        background: "#fff",
                        border: "1px solid rgba(0,0,0,0.15)",
                        borderRadius: 6,
                        fontSize: 12
                      }}>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontWeight: 600 }}>
                            {new Date(entry.timestamp).toLocaleString()}
                          </span>
                          {entry.label && <span style={{ marginLeft: 8, color: "#666" }}>({entry.label})</span>}
                          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                            {entry.content.length} chars
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            type="button"
                            onClick={() => restoreVersion(entry)}
                            style={{
                              border: "1px solid #000",
                              background: "#000",
                              color: "#fff",
                              padding: "4px 8px",
                              borderRadius: 6,
                              fontSize: 11,
                              cursor: "pointer"
                            }}
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteVersion(i)}
                            style={{
                              border: "1px solid #c00",
                              background: "#fff",
                              color: "#c00",
                              padding: "4px 8px",
                              borderRadius: 6,
                              fontSize: 11,
                              cursor: "pointer"
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* AI Helper Floating Chat Window */}
            {aiHelperOpen && (
              <div style={{
                position: "fixed",
                bottom: 20,
                right: 20,
                width: 380,
                maxHeight: 500,
                border: "2px solid #6366f1",
                borderRadius: 16,
                background: "#fff",
                boxShadow: "0 8px 32px rgba(99,102,241,0.3)",
                display: "flex",
                flexDirection: "column",
                zIndex: 1000
              }}>
                {/* Header */}
                <div style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid #e5e7eb",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#6366f1",
                  borderRadius: "14px 14px 0 0"
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🤖</span>
                    <span style={{ fontWeight: 700, color: "#fff" }}>AI Helper</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <select
                      value={aiHelperProvider}
                      onChange={(e) => setAiHelperProvider(e.target.value as "gemini" | "openai")}
                      style={{
                        border: "1px solid rgba(255,255,255,0.3)",
                        background: "rgba(255,255,255,0.2)",
                        color: "#fff",
                        padding: "4px 8px",
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: "pointer"
                      }}
                    >
                      <option value="gemini" style={{ color: "#000" }}>Gemini</option>
                      <option value="openai" style={{ color: "#000" }}>OpenAI</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setAiHelperOpen(false)}
                      style={{
                        border: "none",
                        background: "rgba(255,255,255,0.2)",
                        color: "#fff",
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 14,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Context Badge */}
                <div style={{
                  padding: "8px 16px",
                  background: "#f3f4f6",
                  borderBottom: "1px solid #e5e7eb",
                  fontSize: 11,
                  color: "#666"
                }}>
                  Context: <strong>{settingsTab.charAt(0).toUpperCase() + settingsTab.slice(1)}</strong> settings
                </div>

                {/* Messages */}
                <div style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  minHeight: 200,
                  maxHeight: 280
                }}>
                  {aiHelperMessages.length === 0 && (
                    <div style={{ color: "#888", fontSize: 12, textAlign: "center", marginTop: 20 }}>
                      Ask me anything about your {settingsTab} settings!<br />
                      <span style={{ fontSize: 11 }}>I can help write JSON, explain fields, or suggest improvements.</span>
                    </div>
                  )}
                  {aiHelperMessages.map((msg, i) => (
                    <div key={i} style={{
                      alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "85%"
                    }}>
                      <div style={{
                        background: msg.role === "user" ? "#6366f1" : "#f3f4f6",
                        color: msg.role === "user" ? "#fff" : "#000",
                        padding: "8px 12px",
                        borderRadius: msg.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                        fontSize: 13,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word"
                      }}>
                        {msg.content}
                      </div>
                      {msg.role === "assistant" && msg.content.includes("```") && (
                        <button
                          type="button"
                          onClick={() => applyAiSuggestion(msg.content)}
                          style={{
                            marginTop: 4,
                            border: "1px solid #6366f1",
                            background: "#fff",
                            color: "#6366f1",
                            padding: "4px 8px",
                            borderRadius: 6,
                            fontSize: 11,
                            cursor: "pointer"
                          }}
                        >
                          📋 Apply to Editor
                        </button>
                      )}
                    </div>
                  ))}
                  {aiHelperLoading && (
                    <div style={{ color: "#888", fontSize: 12, fontStyle: "italic" }}>
                      Thinking...
                    </div>
                  )}
                </div>

                {/* Input */}
                <div style={{
                  padding: 12,
                  borderTop: "1px solid #e5e7eb",
                  display: "flex",
                  gap: 8
                }}>
                  <input
                    type="text"
                    value={aiHelperInput}
                    onChange={(e) => setAiHelperInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendAiHelperMessage();
                      }
                    }}
                    placeholder="Ask about settings..."
                    disabled={aiHelperLoading}
                    style={{
                      flex: 1,
                      border: "1px solid #d1d5db",
                      borderRadius: 8,
                      padding: "8px 12px",
                      fontSize: 13,
                      outline: "none"
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => sendAiHelperMessage()}
                    disabled={aiHelperLoading || !aiHelperInput.trim()}
                    style={{
                      border: "none",
                      background: aiHelperLoading || !aiHelperInput.trim() ? "#d1d5db" : "#6366f1",
                      color: "#fff",
                      padding: "8px 14px",
                      borderRadius: 8,
                      fontSize: 13,
                      cursor: aiHelperLoading || !aiHelperInput.trim() ? "not-allowed" : "pointer",
                      fontWeight: 600
                    }}
                  >
                    Send
                  </button>
                </div>

                {/* Quick Actions */}
                <div style={{
                  padding: "8px 12px 12px",
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap"
                }}>
                  <button
                    type="button"
                    onClick={() => {
                      setAiHelperInput("Explain this configuration");
                      setTimeout(() => sendAiHelperMessage(), 100);
                    }}
                    disabled={aiHelperLoading}
                    style={{
                      border: "1px solid #e5e7eb",
                      background: "#f9fafb",
                      padding: "4px 8px",
                      borderRadius: 6,
                      fontSize: 10,
                      cursor: "pointer"
                    }}
                  >
                    Explain config
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAiHelperInput("Suggest improvements");
                      setTimeout(() => sendAiHelperMessage(), 100);
                    }}
                    disabled={aiHelperLoading}
                    style={{
                      border: "1px solid #e5e7eb",
                      background: "#f9fafb",
                      padding: "4px 8px",
                      borderRadius: 6,
                      fontSize: 10,
                      cursor: "pointer"
                    }}
                  >
                    Suggest improvements
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAiHelperInput("Fix JSON syntax errors");
                      setTimeout(() => sendAiHelperMessage(), 100);
                    }}
                    disabled={aiHelperLoading}
                    style={{
                      border: "1px solid #e5e7eb",
                      background: "#f9fafb",
                      padding: "4px 8px",
                      borderRadius: 6,
                      fontSize: 10,
                      cursor: "pointer"
                    }}
                  >
                    Fix JSON errors
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAiHelperMessages([]);
                    }}
                    style={{
                      border: "1px solid #fca5a5",
                      background: "#fff",
                      color: "#dc2626",
                      padding: "4px 8px",
                      borderRadius: 6,
                      fontSize: 10,
                      cursor: "pointer"
                    }}
                  >
                    Clear chat
                  </button>
                </div>
              </div>
            )}

            {settingsError && (
              <div style={{ marginTop: 10, border: "1px solid #000", borderRadius: 12, padding: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Error</div>
                <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{settingsError}</div>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              {settingsTab === "ai" && (
                <textarea
                  value={aiRulesDraft}
                  onChange={(e) => setAiRulesDraft(e.target.value)}
                  placeholder="Enter AI rules for analysis..."
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    boxSizing: "border-box",
                    display: "block"
                  }}
                />
              )}
              {settingsTab === "schema" && (
                <textarea
                  value={schemaJsonDraft}
                  onChange={(e) => setSchemaJsonDraft(e.target.value)}
                  placeholder='{"levels": {"L1": {...}, "L2": {...}, "L3": {...}}, "categories": ["OVERVIEW", "CHARACTERS", "WORLD", "LORE", "STYLE", "STORY"]}'
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    boxSizing: "border-box",
                    display: "block"
                  }}
                />
              )}
              {settingsTab === "tagging" && (
                <textarea
                  value={taggingJsonDraft}
                  onChange={(e) => setTaggingJsonDraft(e.target.value)}
                  placeholder='{"tags": [...]}'
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    boxSizing: "border-box",
                    display: "block"
                  }}
                />
              )}
              {settingsTab === "completeness" && (
                <div>
                  <div style={{ marginBottom: 10, fontSize: 12, color: "#666" }}>
                    Define weights for calculating schema completeness. Format: <code>{`{"weights": {"OVERVIEW": 20, "CHARACTERS": 20, ...}, "OVERVIEW.IPTitle": 10, ...}`}</code>
                  </div>
                  <textarea
                    value={completenessRulesDraft}
                    onChange={(e) => setCompletenessRulesDraft(e.target.value)}
                    placeholder={`{
  "weights": {
    "OVERVIEW": 20,
    "CHARACTERS": 20,
    "WORLD": 15,
    "LORE": 15,
    "STYLE": 15,
    "STORY": 15
  }
}`}
                    style={{
                      width: "100%",
                      maxWidth: "100%",
                      minHeight: 180,
                      border: "1px solid rgba(0,0,0,0.35)",
                      borderRadius: 12,
                      padding: 12,
                      fontSize: 13,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      boxSizing: "border-box",
                      display: "block"
                    }}
                  />
                </div>
              )}
              {settingsTab === "detection" && (
                <div>
                  <div style={{ marginBottom: 10, fontSize: 12, color: "#666" }}>
                    Rules for image detection &amp; cropping in step 5. Controls what to extract, size thresholds, and crop behavior.
                  </div>
                  <textarea
                    value={detectionRulesJsonDraft}
                    onChange={(e) => setDetectionRulesJsonDraft(e.target.value)}
                    placeholder={`{
  "targets": ["characters", "locations", "keyArt", "logos", "diagrams"],
  "ignore": ["decorativeBorders", "pageNumbers", "watermarks", "tinyIcons"],
  "minimumSize": { "width": 80, "height": 80 },
  "qualityThreshold": 0.6,
  "cropPadding": { "default": 5, "characters": 10 },
  "preferFullBleed": ["locations", "keyArt"],
  "autoCategory": true
}`}
                    style={{
                      width: "100%",
                      maxWidth: "100%",
                      minHeight: 200,
                      border: "1px solid rgba(0,0,0,0.35)",
                      borderRadius: 12,
                      padding: 12,
                      fontSize: 13,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      boxSizing: "border-box",
                      display: "block"
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid rgba(0,0,0,0.2)" }} />

      {/* Extracted Text Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Extracted Text</div>
          <button
            type="button"
            aria-label={textPanelOpen ? "Collapse text" : "Expand text"}
            onClick={() => setTextPanelOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={textPanelOpen} />
          </button>
        </div>

        {textPanelOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {formattedText ? (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  maxHeight: 400,
                  overflow: "auto",
                  background: "#f9f9f9",
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid #ddd"
                }}
              >
                {formattedText}
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.6 }}>
                Click &quot;View Text&quot; to load and format extracted text.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Projects Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Projects</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              aria-label="Refresh projects"
              disabled={projectsBusy}
              onClick={() => void refreshProjects()}
              style={{
                border: "1px solid #000",
                background: "#fff",
                width: 36,
                height: 30,
                borderRadius: 10,
                display: "grid",
                placeItems: "center",
                opacity: projectsBusy ? 0.5 : 1
              }}
            >
              <Refresh />
            </button>

            <button
              type="button"
              aria-label={projectsOpen ? "Collapse projects" : "Expand projects"}
              onClick={() => setProjectsOpen((v) => !v)}
              style={{
                border: "1px solid #000",
                background: "#fff",
                width: 36,
                height: 30,
                borderRadius: 10,
                display: "grid",
                placeItems: "center"
              }}
            >
              <Chevron up={projectsOpen} />
            </button>
          </div>
        </div>

        {projectsOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {projects.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.7 }}>No projects found.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {projects.map((p) => {
                  const active = p.projectId === projectId;
                  return (
                    <div
                      key={p.projectId}
                      style={{
                        border: "1px solid rgba(0,0,0,0.25)",
                        borderRadius: 12,
                        padding: 10,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                        background: active ? "rgba(0,0,0,0.04)" : "#fff"
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => void openProject(p)}
                        style={{
                          textAlign: "left",
                          flex: 1,
                          border: "none",
                          background: "transparent",
                          padding: 0,
                          cursor: "pointer"
                        }}
                      >
                        <div style={{ fontWeight: 800, fontSize: 13, lineHeight: "18px" }}>
                          {p.filename || "(no source)"}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                          id: {p.projectId} · {p.status} · pages: {p.pagesCount} · text: {p.hasText ? "yes" : "no"}
                        </div>
                      </button>

                      <button
                        type="button"
                        aria-label={`Delete project ${p.projectId}`}
                        disabled={projectsBusy}
                        onClick={() => void deleteProject(p.projectId)}
                        style={{
                          border: "1px solid #000",
                          background: "#fff",
                          width: 36,
                          height: 30,
                          borderRadius: 10,
                          display: "grid",
                          placeItems: "center",
                          opacity: projectsBusy ? 0.5 : 1
                        }}
                      >
                        <Trash />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Schema Results Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>
            Schema Results
            {schemaResultsDraft && schemaResultsDraft !== schemaResults && (
              <span style={{ marginLeft: 8, fontSize: 12, color: "#c60", fontWeight: 400 }}>(unsaved)</span>
            )}
          </div>

          <button
            type="button"
            aria-label={schemaResultsOpen ? "Collapse schema results" : "Expand schema results"}
            onClick={() => setSchemaResultsOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={schemaResultsOpen} />
          </button>
        </div>

        {schemaResultsOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {schemaResultsDraft ? (
              <>
                {/* View mode toggle and controls */}
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 22, padding: 3 }}>
                    <button
                      type="button"
                      onClick={() => setSchemaResultsViewMode("ui")}
                      style={{
                        border: "none",
                        background: schemaResultsViewMode === "ui" ? "#fff" : "transparent",
                        color: schemaResultsViewMode === "ui" ? "#0f172a" : "#64748b",
                        padding: "8px 16px",
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        boxShadow: schemaResultsViewMode === "ui" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        gap: 6
                      }}
                    >
                      <span>🎨</span> UI View
                    </button>
                    <button
                      type="button"
                      onClick={() => setSchemaResultsViewMode("json")}
                      style={{
                        border: "none",
                        background: schemaResultsViewMode === "json" ? "#fff" : "transparent",
                        color: schemaResultsViewMode === "json" ? "#0f172a" : "#64748b",
                        padding: "8px 16px",
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        boxShadow: schemaResultsViewMode === "json" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        gap: 6
                      }}
                    >
                      <span>{ }</span> Raw JSON
                    </button>
                  </div>

                  {schemaResultsViewMode === "ui" && (
                    <>
                      <div style={{ width: 1, height: 28, background: "#e2e8f0", margin: "0 8px" }} />
                      
                      {/* Level selector */}
                      <div style={{ display: "flex", gap: 6 }}>
                        {(["L1", "L2", "L3"] as const).map((level) => (
                          <button
                            key={level}
                            type="button"
                            onClick={() => setSchemaResultsLevel(level)}
                            style={{
                              border: schemaResultsLevel === level ? "2px solid #0f172a" : "1px solid #e2e8f0",
                              background: schemaResultsLevel === level ? "#0f172a" : "#fff",
                              color: schemaResultsLevel === level ? "#fff" : "#64748b",
                              padding: "6px 14px",
                              borderRadius: 20,
                              fontSize: 12,
                              fontWeight: 600,
                              transition: "all 0.15s ease"
                            }}
                          >
                            {level === "L1" ? "🌍 L1 Global" : level === "L2" ? "📖 L2 Project" : "🎬 L3 Detailed"}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {schemaResultsViewMode === "ui" && (
                  <>
                    {/* Completeness Score Bar */}
                    {(() => {
                      try {
                        const parsed = schemaResultsDraft ? JSON.parse(schemaResultsDraft) : {};
                        const levelData = parsed[schemaResultsLevel] || {};
                        const completeness = calculateCompleteness(levelData, completenessRulesDraft);
                        return (
                          <div style={{ 
                            marginBottom: 16, 
                            padding: "12px 16px", 
                            background: "#f8fafc", 
                            borderRadius: 12,
                            border: "1px solid #e2e8f0"
                          }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <span style={{ fontWeight: 700, fontSize: 14 }}>Completeness</span>
                                <span style={{ 
                                  fontSize: 24, 
                                  fontWeight: 800, 
                                  color: completeness.alert.color 
                                }}>
                                  {completeness.overall}%
                                </span>
                              </div>
                              <span style={{ 
                                fontSize: 12, 
                                padding: "4px 10px", 
                                borderRadius: 12, 
                                background: completeness.alert.color + "20",
                                color: completeness.alert.color,
                                fontWeight: 600
                              }}>
                                {completeness.alert.message}
                              </span>
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {Object.entries(completeness.byDomain).map(([domain, pct]) => {
                                const colors = DOMAIN_COLORS[domain];
                                return (
                                  <div 
                                    key={domain} 
                                    style={{ 
                                      display: "flex", 
                                      alignItems: "center", 
                                      gap: 6,
                                      padding: "4px 10px",
                                      borderRadius: 8,
                                      background: colors?.bg || "#f1f5f9",
                                      border: `1px solid ${colors?.accent || "#94a3b8"}30`
                                    }}
                                  >
                                    <span style={{ fontSize: 11, color: colors?.accent || "#64748b" }}>{domain}</span>
                                    <span style={{ 
                                      fontSize: 12, 
                                      fontWeight: 700, 
                                      color: pct >= 80 ? "#22c55e" : pct >= 50 ? "#eab308" : "#ef4444"
                                    }}>
                                      {pct}%
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      } catch {
                        return null;
                      }
                    })()}

                    {/* Domain tabs */}
                    <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                      {(["OVERVIEW", "CHARACTERS", "WORLD", "LORE", "STYLE", "STORY"] as const).map((domain) => {
                        const colors = DOMAIN_COLORS[domain];
                        const isActive = schemaResultsTab === domain;
                        const icons: Record<string, string> = {
                          OVERVIEW: "📋",
                          CHARACTERS: "👤",
                          WORLD: "🌍",
                          LORE: "📜",
                          STYLE: "🎨",
                          STORY: "📖"
                        };
                        return (
                          <button
                            key={domain}
                            type="button"
                            onClick={() => setSchemaResultsTab(domain)}
                            style={{
                              border: isActive ? `2px solid ${colors.accent}` : "1px solid #e2e8f0",
                              background: isActive ? colors.bg : "#fff",
                              color: isActive ? colors.accent : "#64748b",
                              padding: "8px 16px",
                              borderRadius: 24,
                              fontSize: 13,
                              fontWeight: 600,
                              transition: "all 0.15s ease",
                              display: "flex",
                              alignItems: "center",
                              gap: 6
                            }}
                          >
                            <span>{icons[domain]}</span>
                            {domain}
                          </button>
                        );
                      })}
                    </div>

                    {/* Content cards */}
                    <SchemaResultsUI
                      jsonString={schemaResultsDraft}
                      domain={schemaResultsTab}
                      level={schemaResultsLevel}
                    />
                  </>
                )}

                {schemaResultsViewMode === "json" && (
                  <textarea
                    value={schemaResultsDraft}
                    onChange={(e) => setSchemaResultsDraft(e.target.value)}
                    style={{
                      width: "100%",
                      minHeight: 300,
                      fontFamily: "monospace",
                      fontSize: 12,
                      padding: 10,
                      border: "1px solid #ccc",
                      borderRadius: 6,
                      resize: "vertical",
                      boxSizing: "border-box",
                      display: "block",
                      maxWidth: "100%"
                    }}
                  />
                )}

                <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    disabled={schemaSaveBusy || schemaResultsDraft === schemaResults}
                    onClick={() => void saveSchemaResults()}
                    style={{
                      border: "1px solid #000",
                      background: schemaResultsDraft !== schemaResults ? "#000" : "#fff",
                      color: schemaResultsDraft !== schemaResults ? "#fff" : "#000",
                      padding: "8px 16px",
                      borderRadius: 8,
                      opacity: schemaSaveBusy || schemaResultsDraft === schemaResults ? 0.4 : 1
                    }}
                  >
                    {schemaSaveBusy ? "Saving..." : "Save Results"}
                  </button>
                  <button
                    type="button"
                    disabled={schemaResultsDraft === schemaResults}
                    onClick={() => setSchemaResultsDraft(schemaResults)}
                    style={{
                      border: "1px solid #000",
                      background: "#fff",
                      padding: "8px 16px",
                      borderRadius: 8,
                      opacity: schemaResultsDraft === schemaResults ? 0.4 : 1
                    }}
                  >
                    Revert
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                No schema results yet. Click &quot;7. Fill Schema&quot; to generate.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Assets Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Assets</div>

          <button
            type="button"
            aria-label={assetsOpen ? "Collapse assets" : "Expand assets"}
            onClick={() => setAssetsOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={assetsOpen} />
          </button>
        </div>

        {assetsOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
              {taggedAssetsCount} tagged / {totalAssetsCount} total
            </div>

            {assetsFlat.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.7 }}>—</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                {assetsFlat.map(({ pageNumber, asset }) => assetCard(pageNumber, asset))}
              </div>
            )}
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            await uploadSource(f);
          } catch (err) {
            setLastError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    </div>
  );
}
