---
name: pdf
description: Read scheme PDF sources into reusable Markdown using native text and multimodal capabilities while preserving exact facts and unresolved gaps.
---

# PDF material

This read-only workflow adapts the bundled OpenAI PDF skill's extraction guidance. The upstream source and license are included under `vendor/openai-skills/pdf`; layout QA for creating a deliverable is separate from reading an input.

Call `material_parse` on the authorized original. An ordinary text-only PDF completes through exact text extraction; retain page locations and do not render it. Read the saved Markdown through native file tools.

For `needs-review`, inspect relevant annotations, diagrams and content through native file/PDF capabilities. For `needs-vision`, use the configured multimodal model through DSH's native capabilities only for necessary scanned or image content. `load_workspace_dependencies` supplies the runtime and libraries when Python extraction with `pdfplumber` or `pypdf` is useful; do not assume system tools or install OCR. Render selected pages only for facts that require actual visual interpretation, not every physical page.

Save one document-level Markdown interpretation in the workspace and call `material_complete` with the material ID, source hash, saved path, review description and explicit unresolved gaps. Retain exact extracted text and business images; decorative exporter name/time watermarks are not facts. Reuse completed Markdown. Do not split a PDF into separate user-visible materials, require a child session or choose a special image tool as the default. Unclear values remain gaps and cannot satisfy a required input.
