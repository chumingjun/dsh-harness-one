<p align="right">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

# Workflow One

<p align="center">
  <img src="./images/cover.png" width="100%" alt="Workflow One multi-agent workflows with fully transparent node outputs">
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek-Harness-4D6BFE?labelColor=0F0F1A" alt="DeepSeek Harness plugin"></a>
  <a href="https://zcode.z.ai/cn"><img src="https://img.shields.io/badge/Built%20with-ZCode-14B8A6?labelColor=0F0F1A" alt="Built with ZCode"></a>
  <a href="https://github.com/bruc3van/awesome-dsh-plugin/blob/main/catalog/media-vision.md"><img src="https://img.shields.io/badge/listed%20in-awesome--dsh--plugin-2563EB?labelColor=0F0F1A" alt="Listed in awesome-dsh-plugin"></a>
  <a href="https://www.npmjs.com/package/dsh-harness-one"><img src="https://img.shields.io/npm/v/dsh-harness-one" alt="npm version"></a>
  <a href="https://github.com/chumingjun/dsh-harness-one/actions/workflows/ci.yml"><img src="https://github.com/chumingjun/dsh-harness-one/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/chumingjun/dsh-harness-one/releases/latest"><img src="https://img.shields.io/github/v/release/chumingjun/dsh-harness-one" alt="latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/chumingjun/dsh-harness-one" alt="MIT license"></a>
</p>

## Turn real agents into observable workflows

`Workflow One` is a visual AI workflow orchestrator for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). Describe what you need in natural language and the AI will plan and create a DAG of real dsh agents, scripts, conditions, and HTTP nodes. Fine-tune it on the canvas when needed, then start the flow, inspect every node's input, output, and artifacts, and resume interrupted runs without starting over.

## Why Workflow One?

| Capability | What changes |
| --- | --- |
| **Visual orchestration** | Express sequential, parallel, and conditional paths as nodes and edges instead of hiding the process in a prompt. |
| **Real dsh agents** | Each agent node uses dsh models, tools, and Skills, with different models and roles on the same canvas. |
| **Observable runs** | Inspect live state, actual inputs, outputs, tokens, traces, and artifacts while concurrent runs stay isolated. |
| **Recoverable execution** | Retry, timeout, continue after failure, or resume from an interruption instead of rerunning the whole workflow. |
| **Multiple triggers** | Start from the canvas, chat, a webhook, or cron; the AI assistant can also inspect, edit, and run workflows. |
| **Deliverable results** | Preview or download artifacts and send progress or final results to Feishu groups and users. |

## Install

> [!NOTE]
> Requires Node.js >= 22.15.0 (dsh itself uses the zstd API from `node:zlib`, available since 22.15) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): `npm i -g @deepseek-ai/dsh`.

### npm

```sh
dsh plugin --profile web add dsh-harness-one
dsh web
```

[Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) users should open **Open DSH Terminal**, run `dsh plugin add dsh-harness-one`, and restart Desktop. Do not run `setup.sh` in Desktop; it manages its own profile, Node/pnpm runtime, and loopback port. See [Desktop setup and troubleshooting](dsh-plugins/DESKTOP.md).

**UI dependency:** Workflow One's embedded canvas is hosted in the official dsh interface by the open-source [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) project. `dsh-harness-one` installs and depends on it automatically. If DSH-better-sidebar is missing or disabled, the embedded Workflow entry is unavailable, while the standalone `/wf1/` canvas remains accessible.

### Offline bundle

Download the prebuilt bundle from [GitHub Releases](https://github.com/chumingjun/dsh-harness-one/releases/latest):

```sh
curl -LO https://github.com/chumingjun/dsh-harness-one/releases/download/<tag>/dsh-harness-one-plugins-<tag>.tar.gz
tar -xzf dsh-harness-one-plugins-<tag>.tar.gz && cd dsh-plugins
sh setup.sh --one wf1 4021
sh start.sh wf1                         # http://127.0.0.1:4021/
```

### Build from source

```sh
git clone https://github.com/chumingjun/dsh-harness-one.git
cd harness-one
npm install
npm --prefix web install
sh dsh-plugins/build-web.sh             # Required for source installs
sh dsh-plugins/setup.sh --one dev 4021
sh dsh-plugins/start.sh dev
```

Models and API keys are managed entirely by the dsh profile. This repository and its plugins never hard-code or store keys. See [`dsh-plugins/README.md`](dsh-plugins/README.md) for complete setup, configuration, and development details.

## How it works

Workflow One lives inside the official dsh interface and is designed for creating complex workflows through AI conversation. Describe the goal and needs in natural language on the left, and the generated DAG appears on the canvas. Use the canvas to verify structure, fine-tune settings, and observe execution; manual node editing remains available when needed.

1. Describe the workflow you need in natural language. The AI will plan the flow and create the nodes for you.
2. When requirements change, describe the update in the conversation and the AI will update the workflow accordingly.
3. Confirm the generated graph on the canvas, save it, then start the run from chat or the canvas.
4. During a run, the conversation shows each node's progress directly in cards. You can also configure a notification node to sync node status to a Feishu group or direct chat in real time. Canvas nodes expose actual input and execution details, while the result panel provides the timeline, final result, and artifacts.

![Workflow One switching from the full canvas to live node details](images/workflow-one-demo.gif)

[View the full-resolution screenshot](images/workflow01.png)

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

## Packages

The default bundle contains `dsh-ccpg-tools`, `dsh-ccpg-orchestrator`, `dsh-ccpg-web`, `dsh-ccpg-canvasui`, `dsh-ccpg-document-preview`, `dsh-ccpg-larkauth`, and `dsh-ccpg-llm-guard`. `dsh-ccpg-brand` is an optional standalone package.

See [dsh-plugins/README.md](dsh-plugins/README.md) for installation, packaging, architecture, and storage details.

## Architecture

![Workflow One system architecture](images/architecture.svg)

## Acknowledgements

More than 90% of this project was developed using [ZCode](https://zcode.z.ai/cn). We thank ZCode for providing the development platform and support.

## Contributing and Security

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Discussions](https://github.com/chumingjun/dsh-harness-one/discussions)

Licensed under the [MIT License](LICENSE).
