# AI Lead Intake Automation

An n8n portfolio project for processing inbound sales enquiries with an LLM, Google Sheets and Telegram.

**Stack:** n8n · JavaScript · OpenAI API · Google Sheets · Telegram Bot API

## Use case

Sales enquiries often arrive as unstructured messages. Reviewing each message, recording its details and preparing a response involves repetitive manual work.

This workflow brings those steps together: it validates an enquiry, generates a summary and priority score, records the result in a shared spreadsheet, and notifies an operator with a draft reply for review.

## Workflow

```text
POST /webhook/lead
  → Header authentication
  → Input validation ── invalid input → HTTP 400
  → LLM classification and draft reply
  → Response validation / manual-review fallback
  → Google Sheets: append lead
  → Telegram: notify operator
  → HTTP 200: processing result
```

Every valid enquiry follows the Sheets and Telegram path, including enquiries that require manual triage. Notifications are labelled `HOT`, `STANDARD` or `NEEDS REVIEW`.

## Key features

- **Structured intake:** validates field types and lengths, trims text and supplies defaults for optional fields.
- **AI-assisted triage:** identifies pricing, demo, support or other intent; generates an English summary and a reply in the enquiry's language.
- **Priority scoring:** rounds a validated score to an integer; scores of 70 or above are marked as hot leads. Scores are model estimates, not calibrated sales predictions.
- **Manual-review fallback:** API errors, refusals, incomplete responses and invalid model output produce an explicit `needs_review` flag rather than a fabricated verdict.
- **Shared lead log:** stores the original message, classification and processing status in Google Sheets.
- **Human approval:** provides a draft to the operator; does not send replies to prospective customers.

## Engineering decisions

| Decision | Purpose |
|---|---|
| Header Auth on the webhook | Restrict intake to authenticated callers |
| JSON-serialized model input | Preserve quotes, newlines and other characters in enquiries |
| Send only message and locale to the LLM | Avoid sending separate name and contact fields unnecessarily |
| Validate model output in JavaScript | Check intent, numeric score, text lengths and completion status |
| Write Sheets cells in `RAW` mode | Store submitted text without interpreting it as a spreadsheet formula |
| Escape Telegram HTML | Display user and model text without treating it as markup |
| Reference the parsed lead by node name | Keep the response independent of Sheets and Telegram output shapes |
| Store secrets in n8n credentials | Keep API keys and tokens out of the exported workflow |

The prompt separates instructions from enquiry data. This is a mitigation, not a guarantee against prompt injection; model output remains advisory and requires human review.

## Getting started

### Requirements

- An n8n instance with the node versions used in the export.
- An OpenAI API key with access to `gpt-4o-mini` and API billing enabled.
- A Google account with write access to the destination spreadsheet.
- A Telegram bot and a destination chat where it can send messages.
- Node.js 20 or later to run the local tests; no npm packages are required.

### 1. Import and connect credentials

Import `n8n-workflow.json` using n8n's **Import from File** option.

| Node | Configuration |
|---|---|
| `Webhook /lead` | Create a **Header Auth** credential with name `X-Webhook-Secret` and a strong, randomly generated value |
| `LLM triage` | Create a separate **Header Auth** credential with name `Authorization` and value `Bearer YOUR_OPENAI_API_KEY` |
| `Log to Sheets` | Connect a Google Sheets OAuth2 credential with write access to the spreadsheet |
| `Telegram alert` | Connect a Telegram credential using your bot token from BotFather |

For self-hosted n8n, configure the Google OAuth client using the redirect URI shown by n8n and enable the APIs required by its Google Sheets credential setup.

### 2. Configure destinations

In **Log to Sheets**, replace `REPLACE_WITH_SPREADSHEET_ID` with the spreadsheet ID. Create a tab named **Leads** and put these headers in separate cells across row 1:

```text
received_at, name, contact, source, locale, message, intent, score, is_hot, summary_en, draft_reply, needs_review, llm_status
```

In **Telegram alert**, replace `REPLACE_WITH_CHAT_ID` with your destination chat ID. Start a conversation with the bot for private messages, or add it to your group/channel with the required posting permissions.

The workflow uses node configuration and n8n credentials directly; it does not load `.env` files. `.env.example` lists optional caller-side variables for the request below.

### 3. Run a sample enquiry

Choose **Listen for Test Event** in the webhook node and copy its test URL. From the project directory, run this in PowerShell after setting the two environment variables in your local session:

```powershell
curl.exe --request POST "$env:WEBHOOK_URL" --header "Content-Type: application/json" --header "X-Webhook-Secret: $env:WEBHOOK_SECRET" --data-binary "@examples/sample-webhook.json"
```

Check the JSON response, the new spreadsheet row and the Telegram notification. Once configured, activate/publish the workflow and use the production webhook URL for subsequent requests.

An illustrative successful response is shown below; scores and wording vary by enquiry and model output:

```json
{
  "ok": true,
  "sheet_saved": true,
  "telegram_sent": true,
  "llm_status": "ok",
  "needs_review": false,
  "intent": "pricing",
  "score": 82,
  "is_hot": true,
  "draft_reply": "Which tools do you currently use to manage incoming enquiries?"
}
```

## Testing

```powershell
node --test test/workflow.test.cjs
node --check test/workflow.test.cjs
```

The 18 local tests cover input validation, classification parsing, fallback cases, connection references, Telegram escaping and response expressions. They execute the JavaScript extracted from the workflow with mocked n8n data access. They do not replace an integration run in n8n.

**Integration acceptance check:** after connecting your accounts, confirm that a sample enquiry produces one spreadsheet row, one Telegram notification and the expected HTTP response. Also confirm that missing `message` returns HTTP 400 without calling the downstream services. Live integration verification is a deployment step, not part of the local test suite.

## Operational scope

- HTTP 200 is returned after Sheets and Telegram succeed. An LLM fallback can still complete successfully with `needs_review: true`.
- Sheets and Telegram errors stop the execution. A Telegram failure can leave a saved row without a notification; downstream writes are not transactional.
- Requests are appended independently. There is no deduplication or automatic retry policy; inspect partial results before replaying an execution.
- The workflow is synchronous, with a 30-second LLM request timeout and a 120-second execution timeout. Client and proxy timeouts also apply.
- Use HTTPS, server-side callers, request-size limits and rate limiting when exposing the webhook. Do not embed the shared secret in a public frontend.
- Use synthetic data for demonstrations. Restrict access to the spreadsheet and chat, and establish a retention policy before handling real enquiries. Messages may themselves contain personal data sent to the LLM.
- Saved execution payloads are disabled in the export. If enabling execution history for troubleshooting, use synthetic data and review retention settings.

## Repository structure

```text
n8n-workflow.json              Importable workflow
examples/sample-webhook.json   Sample enquiry
 test/workflow.test.cjs        Local logic tests
.env.example                  Optional caller-side variable names
.gitignore                    Excludes local secrets and dependencies
```
