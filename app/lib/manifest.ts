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
