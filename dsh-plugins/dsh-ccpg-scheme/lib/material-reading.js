export const MATERIAL_READING_RULE = `- Use the current DSH native agent, file capabilities and official Office/PDF
  skills to read source documents. Text-only documents complete without image reading.
  Readable sources with pictures or unsupported parts need document-level review,
  not mandatory per-image tasks. Use the configured multimodal model only for
  content that needs it; preserve business images and exact extracted text.
  Ignore decorative exporter name/time watermarks without altering originals.
  Save one whole-document Markdown interpretation with \`material_complete\`,
  explicit unreadable gaps and the unchanged source hash. Reuse completed results;
  one original remains one material. No child session or particular image tool is
  required. DSH owns context management; do not accumulate large image attachments,
  retry an identical \`preflight_compress_failed\` request, install OCR or guess values.`;

export const LEGACY_MATERIAL_READING_RULES = [
  `- Read the original document with the current DSH native agent and the bundled
  Office/PDF skills. Use document-level \`material_complete\` to save one Markdown
  interpretation, including exact extracted text and explicit unresolved gaps.
  Use the configured multimodal model only when the source has visual or scanned
  content that needs semantic interpretation. Do not create per-image tasks,
  child sessions, or a second model loop; do not install OCR or retry an unchanged
  over-window request. One original file remains one reusable material.`,
];

export function replaceLegacyMaterialReading(text) {
  let next = String(text);
  let changed = false;
  for (const legacy of LEGACY_MATERIAL_READING_RULES) {
    if (next.includes(legacy)) {
      next = next.replace(legacy, MATERIAL_READING_RULE);
      changed = true;
    }
  }
  return { text: next, changed };
}
