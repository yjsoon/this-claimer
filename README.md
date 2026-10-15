# This Claimer

A personal expense-claims tool. Upload receipts to a small web app, match them to `TODO:` transactions in HowMuch or YNAB, and turn ready claims into Xero draft bills (or Volopay claims). Formerly "Claim Manager" and `ynab-claimer`.

## What's in here

- `upload-app/`: the web app, a Cloudflare Worker with R2 storage. Uploads, receipt-to-claim linking, AI tagging of amounts, dates and GST, Gmail receipt import, and the Xero Invoices tab.
- `scripts/`: local helpers for auto-linking clear matches, Volopay form filling and Grab/Gojek receipt export.
- `.claude/skills/`: Claude Code skills, including `/claims` for interactive claim processing.

## Quick start

First-time setup (R2 bucket, Worker secrets) is in [docs/setup.md](docs/setup.md). After that:

```bash
cp .env.example .env   # fill in your values
cd upload-app
npm install
npm run deploy
```

Pushes to `main` that touch `upload-app/` deploy automatically via GitHub Actions.

## Docs

- [Setup](docs/setup.md): environment, Worker secrets, custom domain, Xero, iOS Shortcut
- [Using it](docs/usage.md): everyday flow, auto-linking, Xero invoices, Volopay
- [Worker API](docs/api.md): endpoints for scripts and agents
- [Agent access and WebMCP](docs/webmcp.md)
- [AGENTS.md](AGENTS.md): conventions and rules for AI agents working on the repo
