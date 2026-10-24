# Using This Claimer

## Everyday flow

1. **Visit the web app**: Enter your password to authenticate
2. **Upload receipts**: Drag and drop or tap to upload
3. **View pending claims**: HowMuch transactions with `TODO:` memos appear automatically; use the Backend selector to switch to YNAB
4. **Process claims**: Run `/claims` in Claude Code to match receipts to transactions

A HowMuch transaction marked **To confirm** (`needs_confirmation`) has an estimated amount, usually a foreign spend at a guessed rate. Its claim shows an amber ≈ before the amount, and pushing it to Xero asks first. Confirm the amount in HowMuch (or fix it on the invoice line) before billing.

Receipts can also be marked ready without a visible TODO claim. Click the receipt link button, then choose **Mark ready** without selecting a claim. These receipts move under **Ready to Claim** alongside ordinary linked claim-receipt pairs.

The `/claims` skill lives in `.claude/skills/claims/SKILL.md`.

## Auto-link clear matches

For obvious one-to-one matches, run the local helper from `scripts/`:

```bash
cd scripts
npm run link:matches
```

This is a dry run by default. It only proposes matches where one unlinked receipt maps to one unlinked YNAB TODO claim by receipt date and amount. To write the links:

```bash
npm run link:matches -- --apply
```

Optional flags:

- `--since-date YYYY-MM-DD` - fetch TODO claims from a specific date
- `--near-days N` - allow receipt dates within N days; default is exact date only
- `--allow-upload-date` - use upload date when no manual or AI receipt date exists

## Xero invoices

A full-width **Invoices** tab in the web app assembles ready-to-claim items into
monthly DRAFT bills in Xero, replacing Volopay. Items split into GST / non-GST /
transport (line items grouped by account, sorted by date); each line's account,
GST flag and remark are editable. **Push to Xero (draft)** creates the bill (payee
"Soon Yin Jie", tax-inclusive), attaches the receipts (merging into combined PDFs
when over Xero's 3 MB / 10-attachment caps), then presents a separate **Mark
checked as claimed** action. That action tags the receipts and flips linked
`TODO:` memos to `CLAIMED:` in their originating backend; creating the draft
alone does not change claim memos.

The worker talks to Xero over raw `fetch` (OAuth 2.0; rotating refresh token in the
`XERO_TOKENS` KV namespace). Setup and usage: `.claude/skills/claim-invoices/SKILL.md`.

## Volopay automation

Playwright script to auto-fill Volopay expense claim forms.

```bash
cd scripts
npm install
npm run submit -- claim.json
```

The script fills all form fields and pauses for review before submit. If a dropdown option isn't found, it shows an alert and pauses for manual selection.

## Overview

```
Mobile/Desktop                    YNAB
     │                              │
     │ Upload receipts              │ Mark with TODO:
     ▼                              ▼
┌─────────┐                   ┌──────────┐
│   R2    │◄──── /claims ────►│  YNAB    │
│ Storage │     (Claude)      │   API    │
└─────────┘                   └──────────┘
     │                              │
     │ Delete when done             │ Update to CLAIMED:
     ▼                              ▼
  Cleaned up                   Marked complete
```
