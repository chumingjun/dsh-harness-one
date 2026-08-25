# Workflow One

[简体中文](README.md) | English

**A visual AI workflow orchestrator running inside [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).** Build multi-agent DAGs with drag-and-drop nodes, watch live execution, recover interrupted runs, and send deliverables and run updates to Feishu.

[![npm](https://img.shields.io/npm/v/dsh-ccpg-one)](https://www.npmjs.com/package/dsh-ccpg-one)
[![CI](https://github.com/chumingjun/harness-one/actions/workflows/ci.yml/badge.svg)](https://github.com/chumingjun/harness-one/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/chumingjun/harness-one)](https://github.com/chumingjun/harness-one/releases/latest)
[![MIT License](https://img.shields.io/github/license/chumingjun/harness-one)](LICENSE)

![Workflow One switching from the full canvas to live node details](images/workflow-one-demo.gif)

[View the full-resolution screenshot](images/workflow01.png)

## Install

Requires Node.js >= 24.15 and an existing dsh installation:

```sh
dsh plugin --profile web add dsh-ccpg-one@0.2.1
dsh web
```

In Harness Desktop, run `dsh plugin add dsh-ccpg-one@0.2.1` from **Open DSH Terminal**, then restart Desktop. A prebuilt offline bundle is also available from [GitHub Releases](https://github.com/chumingjun/harness-one/releases/latest).

## What It Does

- Eight node types: input, agent, QuickJS script, condition, HTTP, output, notification, and note.
- Parallel DAG scheduling with retries, timeouts, branch isolation, cancellation, replay, and restart recovery.
- Live SSE status, per-node inputs and outputs, token usage, traces, artifacts, and document previews.
- Stable template variables, workflow inputs, global variables, and structured agent outputs.
- AI-assisted canvas editing through native dsh tools.
- Webhook and cron triggers, optional Feishu document writeback, and workflow notification cards.
- Workspace-local SQLite storage for workflows and run history.

![Conversation, node configuration, and live run progress](images/workflow.png)

## Workflow Notifications

The notification node observes the whole run. It can be connected inline as a pass-through node or left unconnected; both placements behave the same. The initial provider sends Feishu interactive cards, while the channel-neutral event layer is ready for future DingTalk and WeCom providers.

- **Run completion** sends one result card when the workflow succeeds, fails, or is canceled.
- **Every node** sends a compact update after each business node succeeds or fails, followed by the final result card.
- **Group delivery** uses a `chat_id` beginning with `oc_`; the application bot must be in that group.
- **Direct delivery** uses a user's `open_id` beginning with `ou_`; the application visibility range and bot messaging relationship must include that user.

Cards show progress, duration, node counts, output summaries, and failure or cancellation details. Common secret values are redacted and summaries are truncated. Delivery failures are recorded on the notification node without changing the business workflow status. Configure the self-built Feishu application's App ID and App Secret in the canvas settings; these credentials are separate from the lark-cli user login.

## Importable Examples

[`examples/workflows/`](examples/workflows/) contains three ready-to-import workflows: repair ticket normalization, urgency routing, and parallel review. Open the Workflow list, choose **Import**, and select a `.workflow-one.json` file.

## Source Setup

```sh
git clone https://github.com/chumingjun/harness-one.git
cd harness-one
npm test
sh dsh-plugins/build-web.sh
sh dsh-plugins/setup.sh --one dev 4021
sh dsh-plugins/start.sh dev
```

The plugin uses the model provider configured by dsh. This repository never stores API keys.

## Packages

The default bundle contains `dsh-ccpg-tools`, `dsh-ccpg-orchestrator`, `dsh-ccpg-web`, `dsh-ccpg-canvasui`, `dsh-ccpg-document-preview`, `dsh-ccpg-larkauth`, and `dsh-ccpg-llm-guard`. `dsh-ccpg-brand` is an optional standalone package.

See [dsh-plugins/README.md](dsh-plugins/README.md) for installation, packaging, architecture, and storage details.

## Contributing and Security

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Discussions](https://github.com/chumingjun/harness-one/discussions)

Licensed under the [MIT License](LICENSE).
