# Agent access and WebMCP

The frontend progressively enhances compatible browsers with three read-only
WebMCP tools: `list_receipts`, `list_pending_claims`, and `get_xero_status`.
They use the signed-in browser session and existing authenticated GET endpoints;
they do not expose credentials, start vision tagging, or submit financial actions.
The public [`llms.txt`](upload-app/src/llms.txt) guide documents pagination,
backend ownership, amount units, GST evidence, and the human-review workflow.
Ordinary browser automation remains available without WebMCP.

WebMCP is experimental, not a remote MCP server. The implementation detects both
`document.modelContext` (current API) and `navigator.modelContext` (older builds).
See [Chrome's setup instructions](https://developer.chrome.com/docs/ai/webmcp)
for compatible browser versions, the local development flag, and origin-trial
enrollment. No origin-trial token is bundled; enabling it on a production origin
is a separate deployment/configuration step. Tools are not exposed cross-origin.

Run `npm run smoke:frontend` in `upload-app/` to test both registration interfaces,
tool execution with mocked authenticated APIs, failure handling, read-only
requests, accessible control labels, and the existing non-WebMCP workflows.
The harness verifies the app contract, not a particular browser agent's integration.

With a WebMCP-capable `agent-browser`, open the app and let the user sign in,
then use `agent-browser webmcp list` to discover tools and, for example,
`agent-browser webmcp invoke list_receipts --params '{"limit":20}'` to read a page.
Native discovery, logged-out rejection and a mocked receipt read were also
verified with Chrome 153 using experimental web-platform features.
