# CCPG Scheme Runtime Rules

This installed rule pack is compiled from an authorized business snapshot and
is a candidate until each knowledge reference and CCPG CLI mapping is verified.
Read `.ccpg-scheme/index.json` before processing a chapter and use the same DSH
native session for the serial chapter run.

- Follow chapter `order` and declared `dependencies`; do not silently skip,
  reorder, or invent missing inputs.
- Finish and submit the current chapter before reading later chapters' knowledge
  or drafting their outputs. A failed submission does not advance the chapter.
- Treat blocker entries in `.ccpg-scheme/manifest.json` as hard stops for affected chapters.
- Keep source materials, notes, body, attachments, evidence, confirmations, and
  runtime state separate. Never treat a filename or summary as source content.
- When the user supplies a Feishu spreadsheet as the actual scheme material
  list, use `feishu_collect_materials` to save all linked originals and the
  inventory inside this workspace without per-file confirmation. Reuse verified
  local downloads, resume pending exports with the same tool, then parse and bind
  the originals. Links supplied only as examples must not be read or downloaded.
- Use CCPG CLI through the standard `ccpg-cli` command only after project,
  permission, fields, period, metric scope, and capability evidence are verified.
  Otherwise request the user's material or explicit clarification.
- Use the current DSH native agent, file capabilities and official Office/PDF
  skills to read source documents. Text-only documents complete without image reading.
  Readable sources with pictures or unsupported parts need document-level review,
  not mandatory per-image tasks. Use the configured multimodal model only for
  content that needs it; preserve business images and exact extracted text.
  Ignore decorative exporter name/time watermarks without altering originals.
  Save one whole-document Markdown interpretation with `material_complete`,
  explicit unreadable gaps and the unchanged source hash. Reuse completed results;
  one original remains one material. No child session or particular image tool is
  required. DSH owns context management; do not accumulate large image attachments,
  retry an identical `preflight_compress_failed` request, install OCR or guess values.
- Draft in this same conversation; do not delegate a whole chapter just to reread
  its materials. Reuse verified readings and source-backed notes. Save each completed section
  with native file tools to `materials/notes/<chapter-id>-draft.md`; preserve unfinished
  sections across interruptions. Review all declared outputs, exact facts, evidence and
  gaps before `chapter_submit`. Prefer `bodyPath` to submit the saved Markdown once.
- 正文面向业务读者，开头直接进入章节内容；不要暴露材料编码、文件名、源表行号、
  Skill 名、工具调用、内部路径或“依据如下”等内部执行说明。来源关系只保存在
  evidence、contextRefs 和方案索引中。
- A knowledge inventory or law-name list is an index, not the authoritative text.
  Resolve only the sources required for the current chapter through available native
  search/browser tools or current-user Feishu CLI. For laws, use issuing authorities
  and verify jurisdiction, effective dates and applicable clauses. Save readable originals
  or faithful Markdown under `materials/input/knowledge`, retaining source URL,
  retrieval date and version; parse/register them before preparation and reuse verified
  downloads. Do not claim a list, search snippet or model memory is the original.
  If tools, permission or authoritative text are unavailable, preserve the gap and
  request the missing source; never invent a retrieval or citation.
- Submit only complete, evidence-backed artifacts through the scheme tools.
  Human confirmation is separate from model generation.
- Parse and register relevant source materials before chapter preparation. Evidence
  sources must be a registered material or artifact ID returned by scheme tools,
  never a file path, title, or prose citation.
- `chapter_prepare` automatically binds declared bundled knowledge originals.
  If it reports document review, complete that original once and prepare again;
  do not request it from the user or register a bundled summary as the original.
- Use `chapter_prepare.outputs` for attachments: exact `outputId`, readable
  `name` including an extension, and exactly one `content`, `contentPath`,
  `filePath` or `base64`. A saved UTF-8 attachment under `materials/notes`
  uses `contentPath`; image and binary originals use workspace-relative `filePath`.
  Preserve real image attachments and insert required body images at the declared
  position using standard inline Markdown `![description](<local-file-path>)`.
  Do not replace originals with prose or HTML/reference-style image tags.
  A rejected submission preserves its draft; correct parameters rather than
  regenerate its content.
- If a native scheme tool reports an internal failure, use only documented
  recovery once when appropriate. If the same error repeats, stop the current
  chapter and report it. Do not inspect plugin source, call private HTTP
  endpoints, or use shell/file tools to bypass scheme tools.
- Treat these user phrases as product commands and execute the needed internal
  tools yourself: "start the scheme" initializes when needed then prepares the
  first ready chapter; "continue" recovers and prepares the next ready chapter;
  "I added materials" copies current DSH conversation attachments into
  `materials/input` with the native file capability, then parses and binds
  available inputs. The directory is internal and is never named to the user.
  Never ask the user to name `project_create`, `chapter_prepare`, skill files,
  or `chapter_submit`. Ask only one plain-language question when a required
  material is still missing, and explain a blocked chapter by its business gap.
- When the user asks "整理这次测试的问题" or requests a problem report, call
  `scheme_validation_report` and return the saved local report as a clickable file.
- Use `ccpg_project_find` and `ccpg_project_fetch` for current-user CCPG project
  candidates and master-data snapshots. They preserve provenance but remain
  unverified: do not bind them as completed inputs or infer fields, periods and
  metric scope. Request user materials when the required scope cannot be verified.
  Do not reparse materials or start another quality-scoring model.
- Save concise chapter-specific feedback with `scheme_feedback`: user feedback
  uses `source: user`; an unverified model finding uses `source: model`.
  Keep expected and actual behavior separate without copying source materials,
  credentials or full conversation. Reports stay local and never approve content,
  change chapter progress or automatically modify rules.
