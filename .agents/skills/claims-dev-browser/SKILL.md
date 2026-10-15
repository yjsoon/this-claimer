---
name: claims-dev-browser
description: Process expense claims using dev-browser for persistent Volopay sessions. Use when the user mentions claims with dev-browser, or wants the browser-button workflow.
---

# Claim Processing Workflow (dev-browser edition)

Process expense claims by matching YNAB transactions with uploaded receipts.
Uses **dev-browser** for persistent browser sessions — login once, process many claims
with an in-browser "DONE" button (no chat interaction needed between claims).

## Backend Boundary

This workflow is explicitly **YNAB-only**. Before matching, run `npm run link:matches -- --backend ynab` from `scripts/` and show the complete dry-run output to the user. Do not apply it without the confirmation required by the repository instructions.

Treat a receipt link as YNAB-owned only when `linkedClaimsBackend` is `"ynab"` or absent (legacy links). Never match, unlink, delete, or mark a `"howmuch"`-owned link through this workflow. If the user wants HowMuch claims, stop and use the backend-aware web Claims/Invoices flow instead.

## Prerequisites

- `dev-browser` installed globally (`npm i -g dev-browser && dev-browser install`)
- `.env` configured in the project root

## Instructions

You are helping the user process expense claims. Follow this workflow.

**Parallelization Strategy**: Use sub-agents (Task tool) throughout to maximize speed:
- **Downloading/identifying receipts**: Spawn parallel agents to process all receipts concurrently
- **Post-claim cleanup**: Run cleanup tasks in background agents while showing next claim

### 1. Load Configuration

Use the Read tool to read `.env` in the project root. Extract these values:
- `YNAB_API_KEY` - API key for YNAB
- `YNAB_BUDGET_ID` - Budget ID to query
- `R2_WORKER_URL` - URL of the receipt upload worker
- `R2_PASSWORD` - Password for receipt worker auth
- `VOLOPAY_URL` - Volopay base URL

If `.env` is missing or incomplete, ask the user to set it up using `.env.example` as a template.

**Important**: When using these values in curl commands, substitute them directly into the command (don't rely on shell variable expansion from `source .env` as it doesn't handle comments well).

### 2. Fetch YNAB Transactions

Use curl to fetch transactions marked with "TODO" in the memo:

```bash
curl -s -H "Authorization: Bearer <YNAB_API_KEY>" \
  "https://api.ynab.com/v1/budgets/<YNAB_BUDGET_ID>/transactions" \
  | jq '[.data.transactions[] | select(.memo) | select(.memo | ascii_downcase | contains("todo"))]'
```

Note: Filter for `amount < 0` (outflows) to avoid duplicate transfer entries.

**Important: Subtransactions / Split Transactions**
Some TODO claims live inside split transactions as subtransactions. The top-level memo filter won't catch these. To find them:
1. Also search subtransaction memos: `select(.subtransactions[] | .memo | ascii_downcase | contains("todo"))`
2. Subtransaction IDs have format `{parent_id}_st_{index}_{date}` — fetching them as regular transactions returns null
3. EZ-Link transfers and credit card payments may show positive amounts (inflows on the receiving account) — use absolute value for claiming
4. When the web UI / R2 receipts show `linkedClaimId` that doesn't match any top-level TODO, check if it's a subtransaction ID

Parse the response to extract:
- `id` - Transaction ID (for updating later)
- `date` - Transaction date
- `amount` - Amount in milliunits (divide by 1000 for actual amount)
- `payee_name` - Merchant/payee
- `memo` - Contains "TODO: description"
- `category_name` - Category

**IMPORTANT: The YNAB amount is always the claim amount.** Even if the receipt shows a different amount (e.g. foreign currency before conversion, or a different total), the SGD amount from YNAB is what gets submitted to Volopay. Do not flag YNAB/receipt amount mismatches as warnings — the YNAB amount is the source of truth.

### 3. Fetch Pending Receipts

List receipts from R2:

```bash
curl -s -H "X-Auth-Token: <R2_PASSWORD>" "<R2_WORKER_URL>/list" | jq '.receipts'
```

**Pre-linked receipts**: Auto-match only when `linkedClaimId` is present and `linkedClaimsBackend` is `"ynab"` or absent. Ignore HowMuch-owned links in this YNAB workflow.

### 4. Identify All Receipts

**Before matching, download and read ALL receipts to identify their contents.** Don't rely solely on filenames.

**Use sub-agents for parallel processing**: Spawn multiple Task tool agents to download and identify receipts concurrently. Each agent handles one receipt:

For each receipt, the agent should:
1. Download to /tmp/claims/:
   ```bash
   mkdir -p /tmp/claims
   curl -s -H "X-Auth-Token: <R2_PASSWORD>" "<R2_WORKER_URL>/receipt/[key]" -o /tmp/claims/[filename]
   ```

2. **For HEIC/image files**: Convert if needed:
   ```bash
   sips -Z 1500 /tmp/claims/file.heic --out /tmp/claims/file.jpg
   ```

3. **Read the receipt** using the Read tool to extract:
   - Merchant name
   - Date
   - Amount
   - Any invoice/order number

4. Return structured data for the manifest.

### 5. Match Analysis

Compare TODOs against **identified** receipts and show a summary:

**Matching priority:**
1. **Pre-linked receipts** - If a YNAB-owned `linkedClaimId` matches a TODO's transaction ID, use that receipt (highest priority)
2. **Date proximity** - Within 3 days
3. **Amount match** - Exact or within 10%

**Present the overview:**
```
=== CLAIMS OVERVIEW ===

🔗 PRE-LINKED (X items) - user already matched via web UI:
   - [date] [description] $[amount] ← [receipt name]
   ...

✅ READY TO PROCESS (X items) - have matching receipts:
   - [date] [description] $[amount]
   ...

❌ MISSING RECEIPTS (Y items) - need to find:
   - ...

📎 UNMATCHED RECEIPTS (Z items) - uploaded but no matching TODO:
   - ...
```

**Ask the user:**
1. Process ready items now?
2. Or pause to find missing receipts first?

### 6. Group and Order Claims

**Sorting strategy** (maintains claiming momentum by keeping similar items together):

1. **Group by merchant first** - All Cold Storage claims together, all Grab claims together, etc.
2. **Within each merchant, sub-group by description similarity**
3. **Within sub-groups, sort by date** - Chronological order

Present this grouping to user and confirm the processing order before starting.

### 7. Initialize dev-browser Session

Before processing claims, set up the persistent browser session:

```bash
dev-browser --browser volopay --timeout 60 <<'SCRIPT'
const page = await browser.getPage("volopay");
await page.goto("VOLOPAY_URL/my-volopay/reimbursement/claims");
console.log(JSON.stringify({ url: page.url(), title: await page.title() }));
SCRIPT
```

**If login is needed** (URL contains "/login"):
1. Click the Google login button:
   ```bash
   dev-browser --browser volopay --timeout 30 <<'SCRIPT'
   const page = await browser.getPage("volopay");
   await page.getByRole("button", { name: "Login with Google" }).click();
   console.log("GOOGLE_LOGIN_CLICKED");
   SCRIPT
   ```
2. Wait for user to complete Google auth in the browser window:
   ```bash
   dev-browser --browser volopay --timeout 180 <<'SCRIPT'
   const page = await browser.getPage("volopay");
   console.log("Complete Google auth in the browser window...");
   // IMPORTANT: Use regex anchored to start of URL to avoid matching volopay.co in query params
   await page.waitForURL(/^https:\/\/tinkertanker\.volopay\.co\/(?!login)/, { timeout: 180000 });
   console.log("LOGIN_COMPLETE");
   console.log(JSON.stringify({ url: page.url(), title: await page.title() }));
   SCRIPT
   ```
   **Note**: The regex MUST be anchored with `^` to avoid false matches on `volopay.co` appearing in Google's redirect query parameters. Also use `(?!login)` negative lookahead to exclude the login page itself.
3. Verify login succeeded, then navigate to claims page.

The session persists across all subsequent scripts — no need to re-login.

### 8. Process Each Claim

For each TODO transaction:

#### 8a. Prepare receipt for upload

Download the receipt and prepare it for dev-browser's sandboxed upload:

```bash
# Download receipt
mkdir -p /tmp/claims
curl -s -H "X-Auth-Token: <R2_PASSWORD>" "<R2_WORKER_URL>/receipt/[key]" -o "/tmp/claims/[filename]"

# For HEIC files: convert to JPEG, then delete HEIC
sips -Z 1500 /tmp/claims/file.heic --out /tmp/claims/file.jpg
trash /tmp/claims/file.heic

# Rename for clarity: [claim#] - [merchant] [date] [amount].[ext]
mv "/tmp/claims/[filename]" "/tmp/claims/1 - stratechery 25-oct 150.pdf"

# Prepare base64 for dev-browser upload (sandbox can't access host filesystem)
base64 -i "/tmp/claims/[renamed-file]" -o ~/.dev-browser/tmp/receipt.b64
```

Also open the receipt for the user to see:
```bash
open "/tmp/claims/[renamed-file]"
```

And use the Read tool to extract: merchant name, date, total amount, tax breakdown.

#### 8b. Show claim summary

Present the formatted claim before filling:

```
=== CLAIM [N] of [TOTAL] ===
Date:        [date]
Merchant:    [merchant]
Description: [description from memo]
Amount:      S$[YNAB amount]
             (or for foreign currency: US$[receipt amount] (S$[YNAB amount] at rate [rate]))
Tax:         [tax amount if found, or "included" / "not shown"]
Receipt:     file:///tmp/claims/[filename]

Volopay Category: [category]
Xero Category:    [xero category]
Xero Tax Code:    [tax code]
```

**Copy merchant to clipboard**: Run `echo -n "[merchant]" | pbcopy`. Use the registered company name (e.g., "Kap Kia Pte Ltd" not "Yeast Side").

#### 8c. Fill Volopay form and inject DONE button

Run a single dev-browser script that:
1. Navigates to the create-claim page
2. Fills all form fields
3. Uploads receipt via base64 DataTransfer workaround
4. Injects a floating "DONE" button
5. Blocks until the button is clicked

**IMPORTANT**: Use `--timeout 600` (10 minutes) to give the user time to review and submit.

```bash
dev-browser --browser volopay --timeout 600 <<'DEVSCRIPT'
const page = await browser.getPage("volopay");

// Navigate to create claim form
await page.goto("VOLOPAY_URL/my-volopay/reimbursement/claims?createReimbursement=true");
await page.waitForSelector("text=Create claim", { timeout: 15000 });

// === MERCHANT ===
await page.locator(".vp-input-select__value-container").first().click();
await page.waitForTimeout(300);
await page.keyboard.type("MERCHANT_NAME");
await page.waitForTimeout(800);
await page.keyboard.press("Enter");
await page.waitForTimeout(500);

// === AMOUNT ===
await page.getByRole("spinbutton", { name: "Amount *" }).fill("AMOUNT");

// === CURRENCY (if not SGD) ===
// Only include this block if currency is not SGD:
// await page.locator(".w-1\\/2 > .relative > .grow > .react-select > .vp-input-select__control").click();
// await page.waitForTimeout(200);
// const currInput = page.locator("input[id^='react-select-'][id$='-input']").last();
// await currInput.fill("USD");
// await currInput.press("Enter");
// await page.waitForTimeout(300);

// === VOLOPAY CATEGORY ===
await page.mouse.wheel(0, 200);
await page.waitForTimeout(300);
await page.locator("svg").nth(3).click();
await page.waitForTimeout(500);
await page.getByText("VOLOPAY_CATEGORY", { exact: true }).click();
await page.waitForTimeout(300);

// === TRANSACTION DATE ===
await page.getByRole("button", { name: /Transaction date/i }).click();
await page.waitForTimeout(500);
// Navigate calendar to target month/year, then click day
// (Use the calendar navigation logic from the existing script)
// Click the day:
await page.locator(".react-datepicker__day:not(.react-datepicker__day--outside-month)")
  .getByText("DAY_NUM", { exact: true }).click();
await page.waitForTimeout(300);

// === RECEIPT UPLOAD (base64 workaround) ===
const b64 = await readFile("receipt.b64");
const mimeType = "MIME_TYPE"; // e.g., "image/png", "application/pdf"
const fileName = "FILENAME";
await page.evaluate(({ b64Content, mime, name }) => {
  const binary = atob(b64Content.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const file = new File([blob], name, { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector("input[type='file']");
  if (input) {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}, { b64Content: b64, mime: mimeType, name: fileName });
await page.waitForTimeout(1500);

// If upload failed (date picker hang), save draft and reopen
// ... (handle draft save/reopen if needed)

// === MEMO ===
await page.locator("div").filter({ hasText: /^No memo added$/ }).first().click();
await page.waitForTimeout(300);
await page.locator("textarea[name='remarks']").fill("MEMO_TEXT");

// Scroll to Xero fields
await page.mouse.wheel(0, 300);
await page.waitForTimeout(300);

// === XERO CATEGORY ===
await page.locator(".flex > div > .grow > .react-select > .vp-input-select__control").first().click();
await page.waitForTimeout(300);
await page.getByText("XERO_CATEGORY", { exact: true }).click();
await page.waitForTimeout(300);

// === XERO TAX CODE ===
await page.locator("div:nth-child(2) > .grow > .react-select > .vp-input-select__control > .vp-input-select__indicators > .vp-input-select__indicator").click();
await page.waitForTimeout(300);
await page.getByText("XERO_TAX_CODE", { exact: true }).click();
await page.waitForTimeout(300);

// === XERO BIZ UNIT ===
await page.locator("div:nth-child(4) > .grow > .react-select > .vp-input-select__control").click();
await page.waitForTimeout(300);
await page.getByRole("option", { name: "BIZ_UNIT" }).click();
await page.waitForTimeout(300);

// === INJECT DONE BUTTON ===
await page.evaluate(() => {
  // Remove any previous DONE button
  const old = document.getElementById("__claim-done-btn");
  if (old) old.remove();

  window.__claimDone = false;

  const overlay = document.createElement("div");
  overlay.id = "__claim-done-overlay";
  overlay.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:99999;display:flex;justify-content:center;padding:16px;background:linear-gradient(transparent,rgba(0,0,0,0.1));pointer-events:none;";

  const btn = document.createElement("button");
  btn.id = "__claim-done-btn";
  btn.innerHTML = "✅ DONE — Next Claim";
  btn.style.cssText = "pointer-events:auto;padding:16px 48px;font-size:20px;font-weight:bold;background:#22c55e;color:white;border:none;border-radius:16px;cursor:pointer;box-shadow:0 4px 20px rgba(34,197,94,0.4);transition:all 0.2s;";
  btn.onmouseenter = () => { btn.style.transform = "scale(1.05)"; btn.style.boxShadow = "0 6px 24px rgba(34,197,94,0.6)"; };
  btn.onmouseleave = () => { btn.style.transform = "scale(1)"; btn.style.boxShadow = "0 4px 20px rgba(34,197,94,0.4)"; };
  btn.onclick = () => {
    window.__claimDone = true;
    btn.innerHTML = "⏳ Processing next claim...";
    btn.style.background = "#64748b";
    btn.style.cursor = "default";
    btn.disabled = true;
  };

  overlay.appendChild(btn);
  document.body.appendChild(overlay);
});

// === WAIT FOR USER TO CLICK DONE ===
console.log("FORM_FILLED");
await page.waitForFunction(() => window.__claimDone === true, { timeout: 600000 });
console.log("CLAIM_DONE");
DEVSCRIPT
```

**Running this script**: Use `bash` with `mode="sync"` and `initial_wait=30`. The script will:
- Quickly fill the form and print `FORM_FILLED`
- Block waiting for the user to click the DONE button
- When clicked, print `CLAIM_DONE` and exit

When you see `CLAIM_DONE` in the output, proceed to cleanup and the next claim.

#### 8d. Cleanup (background)

After the DONE button is clicked, **immediately show the next claim summary** and spawn a background sub-agent for cleanup:

**Background cleanup agent prompt**:
```
"Complete claim cleanup for transaction [TRANSACTION_ID]:
Verified source provenance at handoff: linkedClaimsBackend=ynab.
1. Before any mutation, refetch receipt [key] from the R2 list and verify linkedClaimsBackend is exactly 'ynab'. Abort without updating YNAB or deleting anything if it is HowMuch, absent, or changed.
2. Update YNAB memo from 'TODO: X' to 'CLAIMED: X' via PUT to transactions API
3. Delete receipt [key] from R2 via DELETE endpoint
4. Delete local file /tmp/claims/[filename] using trash command
5. Remove ~/.dev-browser/tmp/receipt.b64
Credentials: YNAB_API_KEY=[key], YNAB_BUDGET_ID=[id], R2_WORKER_URL=[url], R2_PASSWORD=[pwd]"
```

Cleanup tasks (for reference):
- Update YNAB memo from "TODO: X" to "CLAIMED: X":
  ```bash
  curl -s -X PUT -H "Authorization: Bearer <YNAB_API_KEY>" \
    -H "Content-Type: application/json" \
    -d '{"transaction": {"memo": "CLAIMED: [description]"}}' \
    "https://api.ynab.com/v1/budgets/<YNAB_BUDGET_ID>/transactions/<TRANSACTION_ID>"
  ```
- Delete receipt from R2:
  ```bash
  curl -s -X DELETE -H "X-Auth-Token: <R2_PASSWORD>" "<R2_WORKER_URL>/receipt/[key]"
  ```
- Delete local receipt file:
  ```bash
  trash /tmp/claims/[filename]
  ```
- Clean up base64 temp:
  ```bash
  rm ~/.dev-browser/tmp/receipt.b64
  ```

### 9. Handle Edge Cases

- **No matching receipt**: Flag for manual review, ask user if they want to skip or mark without receipt
- **Multiple matches**: Show all options and let user pick
- **Unmatched receipts**: At the end, list any receipts that weren't matched to transactions
- **Multiple YNAB transactions per receipt** (e.g. `linkedClaimDescription: "2 claims linked"`): Sometimes the user splits one ride/expense into two YNAB transactions but has only one receipt. In this case:
  1. Present both transactions together, showing their combined total matches the receipt
  2. Ask user if they want to submit one combined Volopay claim for the receipt total
  3. If combined: submit one claim for the full amount, then mark BOTH YNAB transactions as CLAIMED
  4. Only delete the R2 receipt after all related transactions are marked CLAIMED
  5. Do NOT attempt to submit two separate Volopay claims with the same receipt amount split
- **Upload failure (date picker hang)**: If the DataTransfer upload doesn't trigger properly, save as draft, reopen, and retry:
  ```javascript
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("cell", { name: "MERCHANT" }).first().click();
  await page.waitForTimeout(2000);
  // Retry upload...
  ```

### 10. Summary

When all claims are processed:

1. **Wait for background cleanup agents**: Verify all cleanup tasks completed successfully. Report any failures.
2. **Stop the dev-browser session** (optional — user may want to keep it for future runs):
   ```bash
   dev-browser stop
   ```
3. **Show summary**:
   - Number of claims processed
   - Any skipped items
   - Any orphaned receipts remaining
   - Any cleanup failures that need manual attention

---

## Tax Code Logic

**CRITICAL: Only use INPUTY24 if the receipt explicitly shows a GST line item with amount. Never assume GST.**

| Condition | Tax Code |
|-----------|----------|
| Receipt shows explicit GST amount (e.g., "GST 9%: $X.XX") | INPUTY24:Standard-Rated Purchases |
| No GST breakdown + Foreign currency (USD) | OPINPUT:Out Of Scope Purchases |
| No GST breakdown + SGD | NRINPUT:Purchases from Non-GST Registered Suppliers |

**WARNING**: "Inclusive of taxes" does NOT mean GST is shown. You must see an actual GST line item to use INPUTY24.

## Volopay Category Mapping

| Expense Type | Volopay Category |
|--------------|------------------|
| Software/SaaS | Software |
| Hardware/Equipment | Equipment & hardware |
| Food/Meals | Entertainment |

## Xero Category Mapping

| Expense Type | Xero Category |
|--------------|---------------|
| Software/SaaS | Computer Software (463) |
| Software for class (IMDA VIBE, "for class") | Cost of Sales (320) |
| Hardware | Computer Hardware & Accessories (464) |
| Books | Books, Magazines, Journals (460) |
| Transport (local) | Local Public Transport (incl Taxi) (451) |
| Transport (overseas) | Overseas Transport (452) |
| Phone/Internet | Telephone & Internet (467) |

**Note**: Most software uses "Computer Software (463)". Only use "Cost of Sales (320)" when the YNAB memo explicitly mentions IMDA VIBE or "for class".

---

## Quick Reference

**YNAB API**: https://api.ynab.com/v1/
**Transaction amounts**: In milliunits (divide by 1000)
**Negative amounts**: Outflows (expenses)
**Positive amounts**: Inflows

**dev-browser instance**: `--browser volopay`
**Persistent page name**: `"volopay"`
**Base64 temp file**: `~/.dev-browser/tmp/receipt.b64`
**Receipt filename format**: `[claim#] - [merchant] [date] [amount].[ext]`
**Volopay URL**: `${VOLOPAY_URL}/my-volopay/reimbursement/claims?createReimbursement=true` (configured in .env)
