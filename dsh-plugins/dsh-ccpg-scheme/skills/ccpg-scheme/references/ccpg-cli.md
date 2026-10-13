# CCPG CLI preparation

Source: Feishu docx `HvrndidqwoM4pbxeEW4ciBO5nVe`, revision 169.

Before using CCPG data:

1. Call `ccpg_cli_status`.
2. If the user asks to prepare CCPG CLI and it is absent or not configured, call `ccpg_cli_setup`. The tool follows the official Linux guide: one-click install for linux/amd64 or linux/arm64, mandatory `ccpg-cli update`, then `ccpg-cli config init --agent-code skill_hub_einwin`.
3. Unsupported platforms receive a manual-install result instead of a guessed command.
4. If the result says `auth-login`, run or ask the user to run `ccpg-cli auth login` in the native DSH terminal. The user must complete Feishu authorization with the group account; personal Feishu accounts with no permission must switch accounts.
5. Network failures around `bms.einwin.com` are environment/network issues. Report the exact error and ask operations to check DNS, HTTPS/TLS, proxy, or firewall access; do not disable security or invent another endpoint.

## Read-only project acquisition

Command flags below were checked against the installed official `ccpg-cli` help on 2026-10-12. This checks the command contract, not live permissions, business schema or data correctness.

1. Use `ccpg_project_find` with the user's project name/code keyword to obtain possible projects. The lookup is a similarity search; a candidate or score is not project identity verification.
2. Select the exact project code when available. Use `ccpg_project_fetch` with exactly one `projectCode` or `projectName`, plus `page` and `pageSize` when another page is needed. Never fetch unfiltered project master data or add a custom endpoint, bot identity, jq expression or arbitrary CLI command.
3. The plugin saves structured JSON as a local snapshot with fetch time, the fixed command, explicit user identity and requested project scope. Credential-shaped fields are removed recursively; pagination tokens are retained. It returns `verified: false`. Successful CLI execution does not establish project match, permissions, period, field definitions, units, metric scope or completeness. Unknown response schemas remain unverified.
4. Check returned rows against the selected project and required business scope. Verify permissions, period, requested fields and metric definitions before treating the snapshot as source material; no automatic registration or chapter binding occurs. If scope cannot be verified, request the missing source or explanation.
5. One page is not the complete project dataset. Use the response's documented pagination information to decide whether more pages are required; do not infer completeness from a nonempty response or merge unmatched projects.
6. On a failed or malformed response, report the bounded tool error and resolve installation, login or permission gaps. Do not echo raw CLI stdout/stderr, credentials or configuration values, retry as bot, install automatically, or guess alternate endpoints.

Only these read operations are exposed:

```sh
ccpg-cli project-search +find --q '<keyword>' --topk 10 --as user --format json
ccpg-cli datahub +project-list --project-code '<exact-code>' --dver-type 2 --page 1 --page-size 20 --as user --format json
ccpg-cli datahub +project-list --project-name '<exact-name>' --dver-type 2 --page 1 --page-size 20 --as user --format json
```

`projectCode` and `projectName` are single strings in the checked help. The wrapper requires nonempty trimmed strings without control characters (query/name at most 200 characters; code at most 100), `topk` from 1 to 100, `page` from 1 to 10000, and `pageSize` from 1 to 200. Formal data version `2`, `--as user` and JSON output are fixed. Optional lookup summaries contain only bounded candidate names/codes and numeric scores; use the saved snapshot to inspect other fields.
