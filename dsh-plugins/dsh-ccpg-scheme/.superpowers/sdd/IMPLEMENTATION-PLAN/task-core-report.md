# Core TDD Report

Date: 2026-10-09
Branch: `codex/ccpg-scheme-tdd`

## Scope

This slice covered the S1/S2 core contracts for the local DSH scheme plugin:

- Dedicated scheme workspace rooted at the current session cwd.
- `.ccpg-scheme/state.json` as the authoritative state file and `index.json` as rebuildable derived data.
- Chapter attempts scoped to the same native DSH session.
- User-only confirmation/skip APIs, with Agent tools limited to generation-side operations.
- Artifact files stored under `outputs/chapters/<chapter>/<artifact>` with hashes for official reads/exports.
- Rule replacement compatibility and stale marking.

## RED

Focused tests were added before implementation for:

- Attempt UUIDs and stale attempt rejection.
- Submit cancellation before persistence/commit.
- Summary/context reference files and artifact hash verification.
- External artifact modification detection.
- Evidence source validation.
- Index corruption with the same revision.
- Explicit skip reason/CAS without dependency bypass.
- Invalid rules preserving an empty dedicated workspace.
- Host behavior for current-cwd project resolution and no Agent `chapter_confirm` tool.

## GREEN

Implemented the smallest production changes:

- `SchemeStore` now reads/writes guarded project paths and rebuilds corrupt/stale indexes by comparing the full derived index.
- `createProject()` validates rules before writing workspace files.
- `prepareChapter()` issues `attemptId` and prompts the current native session instead of asking for a new session.
- `submitChapter()` accepts `AbortSignal`, validates evidence references, writes summary/context refs, hashes artifact files, and records only metadata in state.
- `readChapterArtifact()` and `exportProject()` verify official artifact hashes; external edits mark the chapter `external-changed` and block official output.
- `skipChapter()` records an explicit user skip with reason and revision CAS.
- `replaceChapterRules()` includes order/confirmations in compatibility and marks the edited chapter plus descendants stale.
- Host registration removed Agent `chapter_confirm`; confirm/skip remain HTTP user APIs.

## Verification

- `node test/core.test.mjs` -> 18/18 pass
- `node test/host.test.mjs` -> 1/1 pass
- `node test/materials.test.mjs` -> 4/4 pass
- `node test/connectors.test.mjs` -> 3/3 pass
- `node test/client.test.mjs` -> 8/8 pass

`dsh-plugins/bootstrap-deps.sh dsh-plugins/dsh-ccpg-scheme` was used to restore local `@deepseek-ai/*` SDK symlinks after npm install removed them.

## Limits

- Raw shell/file writes are not OS-level sandboxed by this plugin. They are detected at the official read/export boundary via artifact hashes.
- The target DSH Desktop/profile native hook behavior still needs S2 real-profile validation.
