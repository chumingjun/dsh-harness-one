# Security Policy

## Supported Versions

Security fixes target the latest published release and the `main` branch.

## Reporting a Vulnerability

Please do not open a public Issue for an unpatched vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/chumingjun/harness-one/security/advisories/new) and include:

- affected version and environment;
- reproduction steps or a minimal proof of concept;
- expected impact;
- any suggested mitigation.

Do not include real API keys, user credentials, private documents, or production data. You should receive an initial response within seven days. Once a fix is available, the report and credit can be disclosed by mutual agreement.

Workflow One plugins run with the permissions of the dsh process. Review third-party workflows before importing them, keep dsh bound to trusted networks, and store model or Feishu credentials only through dsh's credential mechanisms.
