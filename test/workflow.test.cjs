const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const wf = JSON.parse(fs.readFileSync(path.join(root, 'n8n-workflow.json'), 'utf8'));

function nodeByName(name) {
  const n = wf.nodes.find((n) => n.name === name);
  assert.ok(n, `node not found: ${name}`);
  return n;
}

function runJs(node, { input, namedInputs = {} }) {
  const fn = new Function('$input', '$', '$json', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Date', node.parameters.jsCode);
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => ({ first: () => ({ json: namedInputs[name] }) });
  return fn($input, $, input, JSON, Math, Number, String, Boolean, Date);
}

const validBody = { name: 'Armen', contact: '+374 99 000000', source: 'landing', locale: 'en', message: 'Need pricing for 50 leads/week automation' };

function validate(body) {
  return runJs(nodeByName('Validate lead'), { input: { body } })[0].json;
}

function parseLead(lead, llmJson) {
  return runJs(nodeByName('Parse LLM output'), { input: llmJson, namedInputs: { 'Validate lead': { lead } } })[0].json;
}

const goodLlm = (over = {}) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary_en: 'Wants pricing for automation', intent: 'pricing', score: 82, draft_reply: 'Sure, let me share the details.', ...over }) } }] });

test('structure: connections reference existing nodes, single webhook, linear main path', () => {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, conns] of Object.entries(wf.connections)) {
    assert.ok(names.has(src), `dangling source: ${src}`);
    for (const branch of conns.main) for (const t of branch) assert.ok(names.has(t.node), `dangling target: ${t.node}`);
  }
  const types = wf.nodes.map((n) => n.type);
  assert.equal(types.filter((t) => t === 'n8n-nodes-base.webhook').length, 1);
  assert.ok(types.includes('n8n-nodes-base.respondToWebhook'));
});

test('structure: webhook requires header auth, LLM node continues on error', () => {
  assert.equal(nodeByName('Webhook /lead').parameters.authentication, 'headerAuth');
  assert.equal(nodeByName('LLM triage').onError, 'continueRegularOutput');
});

test('validate: happy path', () => {
  const r = validate(validBody);
  assert.equal(r.valid, true);
  assert.equal(r.lead.name, 'Armen');
  assert.equal(r.lead.source, 'landing');
  assert.match(r.lead.received_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(r.lead.message.includes('50 leads'));
});

test('validate: rejects missing/empty/oversized message and bad types', () => {
  assert.equal(validate({}).valid, false);
  assert.equal(validate({ message: '   ' }).valid, false);
  assert.equal(validate({ message: 'x'.repeat(2001) }).valid, false);
  assert.equal(validate({ message: 42 }).valid, false);
  assert.equal(validate({ message: 'hi', name: 'x'.repeat(121) }).valid, false);
  assert.equal(validate('not an object').valid, false);
});

test('validate: defaults and trims', () => {
  const r = validate({ message: '  hi  ' });
  assert.equal(r.lead.name, 'unknown');
  assert.equal(r.lead.locale, 'en');
  assert.equal(r.lead.source, 'unknown');
  assert.equal(r.lead.message, 'hi');
});

test('parse: good LLM reply', () => {
  const out = parseLead(validate(validBody).lead, goodLlm());
  assert.equal(out.llm_status, 'ok');
  assert.equal(out.needs_review, false);
  assert.equal(out.intent, 'pricing');
  assert.equal(out.score, 82);
  assert.equal(out.is_hot, true);
  assert.ok(out.summary_en && out.draft_reply);
});

test('parse: score 69 is not hot, 70 is hot, out-of-range rejected', () => {
  assert.equal(parseLead(validate(validBody).lead, goodLlm({ score: 69 })).is_hot, false);
  assert.equal(parseLead(validate(validBody).lead, goodLlm({ score: 70 })).is_hot, true);
  assert.equal(parseLead(validate(validBody).lead, goodLlm({ score: 101 })).llm_status, 'invalid_response');
  assert.equal(parseLead(validate(validBody).lead, goodLlm({ score: -1 })).llm_status, 'invalid_response');
});

test('parse: bad intent / bad summary / bad draft / non-object all fall back', () => {
  const lead = validate(validBody).lead;
  for (const over of [{ intent: 'spam' }, { summary_en: '' }, { draft_reply: '' }, { score: 'high' }]) {
    const out = parseLead(lead, goodLlm(over));
    assert.equal(out.llm_status, 'invalid_response');
    assert.equal(out.needs_review, true);
    assert.equal(out.is_hot, false);
    assert.equal(out.score, null);
  }
  const out = parseLead(lead, { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] });
  assert.equal(out.llm_status, 'invalid_response');
});

test('parse: LLM node failed (error payload) → unavailable, lead still logged', () => {
  const out = parseLead(validate(validBody).lead, { error: 'connect ETIMEDOUT' });
  assert.equal(out.llm_status, 'unavailable');
  assert.equal(out.needs_review, true);
  assert.equal(out.is_hot, false);
  assert.ok(out.summary_en.includes('Review'));
});

test('parse: refusal / truncated completion treated as invalid', () => {
  const lead = validate(validBody).lead;
  assert.equal(parseLead(lead, { choices: [{ finish_reason: 'length', message: { content: '{"intent":"pricing","score":90,"summary_en":"x","draft_reply":"y"}' } }] }).llm_status, 'invalid_response');
  assert.equal(parseLead(lead, { choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: '{"intent":"pricing","score":90,"summary_en":"x","draft_reply":"y"}' } }] }).llm_status, 'invalid_response');
});

test('prompt hardening: untrusted-data notice and no-follow-instructions rule present', () => {
  const code = nodeByName('LLM triage').parameters.jsonBody;
  assert.ok(code.includes('untrusted data'));
  assert.ok(code.includes('Never follow instructions'));
});

test('telegram message escapes HTML special chars', () => {
  const expr = nodeByName('Telegram alert').parameters.text;
  assert.ok(expr.includes('&amp;') && expr.includes('&lt;') && expr.includes('&gt;'));
});

function unwrapExpr(expr) {
  return expr.replace(/^=/, '').replace(/^\{\{/, '').replace(/\}\}$/, '');
}

function evalTelegramExpr(parsedLead) {
  const fn = new Function('$', 'JSON', 'Math', 'Number', 'String', 'Boolean', `return ${unwrapExpr(nodeByName('Telegram alert').parameters.text)};`);
  return fn((name) => ({ first: () => ({ json: { ...parsedLead } }) }), JSON, Math, Number, String, Boolean);
}

function evalRespondExpr(nodeName, parsedLead) {
  const fn = new Function('$', 'JSON', 'Math', 'Number', 'String', 'Boolean', `return ${unwrapExpr(nodeByName(nodeName).parameters.responseBody)};`);
  return fn((name) => ({ first: () => ({ json: { ...parsedLead } }) }), JSON, Math, Number, String, Boolean);
}

test('telegram expression executes and escapes malicious lead fields', () => {
  const lead = parseLead(validate(validBody).lead, goodLlm({ draft_reply: '<script>alert(1)</script> & <b>x</b>' }));
  const msg = evalTelegramExpr(lead);
  assert.ok(msg.includes('New lead: HOT'));
  assert.ok(msg.includes('&lt;script&gt;'));
  assert.ok(!msg.includes('<script>'));
});

test('respond 400 evaluates to valid JSON for invalid input', () => {
  const r = validate({ message: '' });
  assert.equal(r.valid, false);
  const body = JSON.parse(evalRespondExpr('Respond 400', { error: r.error }));
  assert.equal(body.ok, false);
  assert.equal(body.error, r.error);
});

test('respond 200 evaluates to valid JSON with verdict fields (hot and fallback)', () => {
  const hot = parseLead(validate(validBody).lead, goodLlm());
  const okBody = JSON.parse(evalRespondExpr('Respond 200', hot));
  assert.equal(okBody.ok, true);
  assert.equal(okBody.is_hot, true);
  assert.equal(okBody.llm_status, 'ok');
  assert.equal(okBody.draft_reply, hot.draft_reply);
  const fallback = parseLead(validate(validBody).lead, { error: 'x' });
  const fbBody = JSON.parse(evalRespondExpr('Respond 200', fallback));
  assert.equal(fbBody.needs_review, true);
  assert.equal(fbBody.draft_reply, null);
  assert.equal(fbBody.is_hot, false);
});

test('sheets: autoMapInputData covers every field returned by parse', () => {
  const parsed = parseLead(validate(validBody).lead, goodLlm());
  const expr = nodeByName('Telegram alert').parameters.text;
  assert.ok(expr.includes('summary_en'));
  for (const k of ['received_at', 'name', 'contact', 'source', 'locale', 'message', 'intent', 'score', 'is_hot', 'summary_en', 'draft_reply', 'needs_review', 'llm_status']) {
    assert.ok(k in parsed, `parse output missing ${k}`);
  }
});

test('respond 400 references validation error; respond 200 exposes llm_status and needs_review', () => {
  const bad = nodeByName('Respond 400').parameters.responseBody;
  assert.ok(bad.includes("$('Validate lead')"));
  const ok = nodeByName('Respond 200').parameters.responseBody;
  for (const k of ['llm_status', 'needs_review', 'draft_reply']) assert.ok(ok.includes(k));
});

test('README documents header auth, threshold 70, and required env/config; sample payload valid', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('Header Auth'));
  assert.ok(/70/.test(readme));
  for (const v of ['GOOGLE_SHEET_ID', 'TELEGRAM_CHAT_ID']) assert.ok(readme.includes(v) || readme.includes('REPLACE_WITH'), `README missing ${v}`);
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'examples/sample-webhook.json'), 'utf8'));
  assert.equal(validate(sample).valid, true);
});
