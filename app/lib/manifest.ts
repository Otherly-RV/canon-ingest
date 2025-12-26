import { put } from "@vercel/blob";

export type ProjectSettings = {
  aiRules: string;
  uiFieldsJson: string;
  taggingJson: string;
};

export type AssetBBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PageAsset = {
  assetId: string; // "p{page}-img{index}"
  url: string;
  bbox: AssetBBox;
  tags?: string[];
  tagRationale?: string;
};
export type PageImage = {
  pageNumber: number;
  url: string;
  width: number;
  height: number;

  // NEW: cropped image assets extracted from this page
  assets?: PageAsset[];

  // NEW: tombstones.
  // Some routes (tagging / record-bulk / rebuild-index) historically fetched a
  // manifest, did work for a while, then saved it back. If a user deleted an
  // asset during that window, the old manifest write would "resurrect" it.
  // We keep a per-page list of deleted assetIds so later saves can respect it.
  deletedAssetIds?: string[];

  // Optional fallback (older flow)
  tags?: string[];
};

export type ProjectManifest = {
  projectId: string;
  createdAt: string;

  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };

  // NEW: raw Document AI JSON stored in Blob (used for detection)
  docAiJson?: { url: string };

  pages?: PageImage[];

  settings: ProjectSettings;

  status: "empty" | "uploaded" | "processed";

  debugLog?: string[];
};

export function newManifest(projectId: string): ProjectManifest {
  return {
    projectId,
    createdAt: new Date().toISOString(),
    status: "empty",
    settings: {
      aiRules: `You are the "Otherly Exec". Be strict and coherent. Do not invent details.`,
      uiFieldsJson: JSON.stringify({ fields: [] }, null, 2),
      taggingJson: JSON.stringify(
        { max_tags_per_image: 25, min_word_len: 3, banned: [], required: [] },
        null,
        2
      )
    }
  };
}

export function manifestPath(projectId: string) {
  return `projects/${projectId}/manifest.json`;
}

export async function saveManifest(manifest: ProjectManifest) {
  const blob = await put(manifestPath(manifest.projectId), JSON.stringify(manifest, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false
  });
  return blob.url;
}

/**
 * Force-fetch manifest bypassing Vercel Edge cache.
 */
export async function fetchManifestDirect(url: string): Promise<ProjectManifest> {
  const u = new URL(url);
  const cleanUrl = `${u.origin}${u.pathname}`;
  const cacheBuster = `${cleanUrl}?v=${Date.now()}`;
  
  const res = await fetch(cacheBuster, { 
    cache: "no-store",
    headers: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to read manifest directly: ${res.statusText}`);
  }
  
  return (await res.json()) as ProjectManifest;
}
