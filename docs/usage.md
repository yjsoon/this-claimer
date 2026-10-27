# Using This Claimer

## Everyday flow

1. **Visit the web app**: Enter your password to authenticate
2. **Upload receipts**: Drag and drop or tap to upload
3. **View pending claims**: HowMuch transactions with `TODO:` memos appear automatically; use the Backend selector to switch to YNAB
4. **Process claims**: Run `/claims` in Claude Code to match receipts to transactions

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

**Push checked to Xero** includes only checked/reviewed lines that have not
already been pushed. The button and note show the selected count and amount;
the confirmation totals and receipt PDF use that same subset. Unchecked lines
stay available for a later draft. Zero checked lines disables Push. Pushed lines
show a **Draft pushed** link and cannot be added to another draft; mark them
claimed separately after checking Xero. The section's **Mark checked pushed lines
as claimed** action ignores checked lines that have not been pushed yet.
Bill ownership and claimed state are
shared per line, so claiming one of several lines on a receipt does not hide its
unchecked siblings. Old receipt-wide pending stamps remain legacy metadata, not
proof of a pushed bill.

Pushes use version checks and reserve their exact line subset before calling
Xero. A stale or overlapping push fails rather than duplicating lines. If a push
has an uncertain outcome, retry the identical subset and reference; do not change
the selection or reference to work around an error. Exact retries reuse the
remembered bill (or the same Xero idempotency key while its outcome is unknown).
Unknown-outcome retries stop after five minutes, before Xero's six-minute key
expiry; check Xero and reconcile deliberately rather than risking a duplicate.
If Xero explicitly rejects validation (for example, an archived account), no
bill was created: correct the line, review it and push again. Failed acquisition
before contacting Xero releases its new reservations; it does not strand lines.

In an invoice receipt preview, **← / →** move between lines without wrapping,
**Enter** toggles reviewed/unreviewed without moving, and **Escape** closes.
Clicking the **tick** confirms the current line and opens the next preview;
confirming the final line closes the preview. The tick never unreviews a line.

Manual line edits (including Type/section, tax, account, memo, amount, remark and
review state) are shared with other browsers and agents on reload or **Refresh**.
AI GST tags remain the original printed-receipt finding; manual invoice tax
decisions take priority without rewriting those tags.

Existing browser edits are imported only for lines with no shared overrides, using
a version-checked write. Once a shared entry exists, it wins over undated browser
edits, including after a server reset. The original `claim_manager_invoice_edits`
localStorage entries remain as recovery backups; do not clear browser storage
until you have checked migration. If different browsers had different old edits,
the first successful import wins; compare the retained backups before deliberately
reapplying any missing changes. Backups are not merged over an existing shared line.

On a save failure or conflict, a visible error says the edits are not shared and
the local backup is kept. Conflicts display the newer shared values rather than
silently overwriting them. Refresh and deliberately reapply any intended change;
draft creation is blocked while the current session has unresolved save errors.
The app does not auto-retry failed edits over newer shared data. Agent API usage:
[shared invoice overrides](api.md#shared-invoice-line-overrides-agents-and-browsers).

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
