import { put } from "@vercel/blob";

export type ProjectSettings = {
  aiRules: string;
  uiFieldsJson: string;
  taggingJson: string;
};

export type PageImage = {
  pageNumber: number;
  url: string;
  width: number;
  height: number;
};

export type ProjectManifest = {
  projectId: string;
  createdAt: string;

  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };

  // PNG pages stored in Blob
  pages?: PageImage[];

  settings: ProjectSettings;

  // coarse state for UI
  status: "empty" | "uploaded" | "processed";
};

export function newManifest(projectId: string): ProjectManifest {
  return {
    projectId,
    createdAt: new Date().toISOString(),
    status: "empty",
    settings: {
      aiRules: `You are the "Otherly Exec". Be strict and coherent. Do not invent details.`,
      uiFieldsJson: JSON.stringify(
        {
          fields: [
            { key: "title", label: "Title", type: "string" },
            { key: "summary", label: "Summary", type: "text" }
          ]
        },
        null,
        2
      ),
      taggingJson: JSON.stringify(
        {
          rules: [
            "Tags must be coherent with the PDF text context.",
            "Prefer LoRA-friendly tokens (short, reusable).",
            "Avoid full sentences. Avoid copyrighted names unless present in the source."
          ],
          max_tags_per_image: 25
        },
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
