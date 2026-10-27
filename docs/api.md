# Worker API

All endpoints require the `X-Auth-Token` header, except the OAuth redirect targets `GET /xero/callback` and `GET /gmail/callback`, which are verified with a one-time state value instead.

- `POST /upload` - Upload receipt file
- `GET /list` - List pending receipts (includes link metadata)
- `GET /ynab/todos?backend=howmuch|ynab` - Fetch pending claims (HowMuch is the default)
- `GET /receipt/:key` - Download receipt
- `DELETE /receipt/:key` - Delete receipt
- `PATCH /receipt/:key/link` - Link receipt to a transaction
- `PATCH /receipt/:key/receipt-date` - Set/clear manual receipt date override (`YYYY-MM-DD`)
- `GET|PATCH /receipt/:key/invoice-edits` - Read/update shared manual invoice line overrides (see below)
- `POST /receipt/:key/tag-amount` - Run Gemini amount tagging for one receipt
- `POST /amount-tags/pending?limit=3` - Tag a batch of pending receipts
- `GET /agent/unclaimed-expenditures?backend=howmuch|ynab` - Agent report of TODO claims without linked receipts (HowMuch is the default)
- `POST /xero/connect` · `GET /xero/callback` · `GET /xero/status` · `POST /xero/disconnect` · `GET /xero/meta` · `POST /xero/invoices/push` - Xero integration for the Invoices tab (see [usage](usage.md#xero-invoices))

`GET /agent/unclaimed-expenditures` accepts an optional `since_date=YYYY-MM-DD` query param and returns:
- `summary` - counts for TODO claims, missing receipt claims, linked claims, and unlinked receipts
- `missingReceiptClaims` - TODO expenditures with no linked uploaded receipt, including Gmail search hints
- `linkedClaims` - TODO claims that already have linked receipt metadata
- `unlinkedReceipts` - uploaded receipts that are not linked to any claim

`GET /list` and `GET /ynab/todos` also return a `Server-Timing` header; see [AGENTS.md](../AGENTS.md) for the Gmail, GST-tagging and diagnostics routes.

### Xero subset pushes

`POST /xero/invoices/push` invoices exactly its `lineItems`, not every ready line.
Send only the reviewed subset. The browser also sends `invoiceRevisions`, a map
from each selected receipt key to the exact `invoiceEdits.revision` last read
(including `null` for an unedited receipt). Stale revisions and overlapping pushes
return 409 before bill creation. Resolve conflicts deliberately; do not blindly
retry with a newer revision or change the reference to evade ownership checks.

`invoiceEdits.xero` is optional, server-owned state keyed by `backend::claimId`
(receipt-only lines use `backend::receipt-ready:<receipt-key>`). It stores the
reserved push key/time, then the bill ID/number and, after marking claimed, the
claimed timestamp. Manual PATCH/reset preserves it and cannot modify it. A known
bill is reused on an exact retry; an unknown result may retry the same payload
only within five minutes. After that, reconcile against Xero manually. The old
receipt-wide `xeroPending*` stamps are not authoritative per-line state.

## Shared invoice line overrides (agents and browsers)

Manual invoice edits are stored as separate JSON objects in the existing R2 bucket,
under the internal `__invoice_edits/` prefix. No new binding is required. They do
not change receipt bytes, receipt dates, claim memos, or AI metadata
(`taggedGstShown`, `taggedGstAmount`, `taggedGstSource`). Internal objects are excluded
from receipt listings and tagging scans. Do not edit or delete the R2 objects directly.

`GET /receipt/:key/invoice-edits` returns:

```json
{"revision":null,"lines":{}}
```

Once edited, `revision` is an opaque string. `lines` is keyed by
`<backend>::<claimId>` (for example `howmuch::transaction-id`), never by row number.
Use the receipt's `linkedClaimsBackend` and exact `linkedClaimIds` from `GET /list`;
ready-only `receipt-ready:` IDs work too. Each receipt in `/list` also includes
this record as `invoiceEdits`.

To set an SGD line to Non-GST, URL-encode the receipt key and PATCH with the exact
revision just read (`null` only when no record exists):

```json
{
  "backend": "howmuch",
  "claimId": "transaction-id",
  "revision": "revision-from-GET",
  "patch": {"section":"nongst","gstShown":false,"taxType":"NRINPUT"}
}
```

The response is the complete updated record and its new revision. Writes use an
atomic R2 conditional put. **409 means another writer won**: re-read, compare the
new shared edits with your intended change, and resolve deliberately. Never blindly
retry with the new revision. Revisions cover the whole receipt, including its other
linked lines. Unknown fields/invalid values return 400; missing receipts return 404.
All reads/writes require the usual `X-Auth-Token` and, when configured, Access headers.

Allowed patch fields: `section` (`gst|nongst|transport`), `gstShown` (manual invoice
decision, not the AI finding), `taxType` (`INPUTY24|NRINPUT|OPINPUT`), `accountCode`
(numeric string), `date` (`YYYY-MM-DD`, or `""` to leave the line date blank), `description`, `amount` (nonnegative SGD
number), `remark`, `include`, `reviewed`, `reviewInvalidated`, `reviewedSnapshot`,
and `reviewedSourceSnapshot`. Patches merge only supplied fields. Send classification
fields together consistently; the UI normalizes section/account/tax as before.
Financial/content edits invalidate review unless the patch also supplies review
state. Agents should normally leave the line unreviewed for the human to check;
the UI saves review with effective-line and source snapshots so upstream changes
still invalidate it. `patch: null` clears that line's overrides back to defaults,
keeping an empty entry to prevent old browser edits being imported again.

**Foodpanda platform-fee exception:** when YJ classifies a meal as Non-GST because
only the platform fee shows GST (for example S$0.12 on a S$219.30 meal), use the
Non-GST patch above, not an AI re-tag. The printed GST finding remains true; it does
not mean the entire meal should use `INPUTY24`. This is a manual rule, not a blanket
automatic Foodpanda classifier. Applying it to a live receipt is a separate,
authorized production-data action; implementation/tests do not apply it.
