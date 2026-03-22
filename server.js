import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT              = process.env.PORT            || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL             = process.env.ANTHROPIC_MODEL  || 'claude-sonnet-4-6';

// ─── SQLite ───────────────────────────────────────────────────────────────────

const db = new DatabaseSync(join(__dirname, 'diagrams.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS diagrams (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL DEFAULT 'Untitled',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    files      TEXT    NOT NULL,
    data       TEXT    NOT NULL
  )
`);

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert AWS infrastructure architect.
Analyze Terraform HCL configuration files and produce a structured JSON diagram.

Return ONLY valid JSON — no markdown fences, no prose, no extra text.
Schema:

{
  "resources": [
    {
      "id":             "aws_resource_type.logical_name",
      "type":           "aws_resource_type",
      "name":           "logical_name",
      "label":          "Short human-readable label",
      "level":          1,
      "internet_facing": false,
      "props":          { "key": "value" }
    }
  ],
  "connections": [
    {
      "from":  "source_resource_id",
      "to":    "target_resource_id",
      "label": "relationship"
    }
  ],
  "internet_paths": [
    {
      "entry":  "outermost_internet_facing_resource_id",
      "target": "compute_or_data_resource_id",
      "path":   ["entry_id", "intermediate_id", "target_id"],
      "label":  "e.g. HTTPS via ALB"
    }
  ],
  "summary": "One sentence describing the overall infrastructure."
}

━━━ LEVEL ASSIGNMENTS ━━━
Assign every resource a level 1, 2, or 3:

  Level 1 — Entry / Critical  (shown in "Overview" mode)
    Internet Gateways, VPCs, CloudFront distributions, API Gateways
    (aws_api_gateway_rest_api, aws_api_gateway_v2_api), Load Balancers
    (aws_lb, aws_alb), Route 53 zones, NAT Gateways.
    These are the outermost entry points and network foundations.

  Level 2 — Core Services  (also shown in "Services" mode)
    EC2 instances, Lambda functions, ECS services/clusters, EKS clusters,
    RDS/Aurora instances, DynamoDB tables, S3 buckets, ElastiCache clusters,
    Autoscaling groups, SNS topics, SQS queues, Kinesis streams,
    ECR repositories.  The actual compute and data plane.

  Level 3 — Support / Config  (only in "Full" mode)
    Subnets, Route tables, Security Groups, IAM roles/policies,
    Target Groups, Listeners, Launch Templates, ECS task definitions,
    CloudWatch log groups, SSM parameters, Secrets Manager secrets,
    CodePipeline, CodeCommit, and all other config/support resources.

━━━ INTERNET PATHS ━━━
For every real path traffic can take from the public internet to a
compute or data resource, produce one entry.
  • entry  = the outermost internet-facing resource (CloudFront, API GW,
             ALB, or an EC2 with a public IP / Elastic IP).
  • path   = ordered array of resource IDs from entry to final target.
  • Only include paths supported by the actual Terraform references.
  • If no public-internet path exists, return an empty array.

━━━ GENERAL RULES ━━━
  • Only include actual aws_* resources — no data sources, variables, locals.
  • Derive connections from explicit Terraform references
    (subnet_id, vpc_id, security_group_ids, role_arn, function_name, etc.).
  • Connection labels: contains, routes_to, uses, triggers,
    reads_from, writes_to, attached_to, in_front_of, peered_with.
  • props: 3–5 most informative attributes
    (cidr_block, instance_type, engine, runtime, port, etc.).
  • label: concise — "VPC: production", "RDS: postgres-main", "Lambda: api-handler".
  • Do NOT invent resources absent from the files.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return JSON.parse(fence[1].trim());
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e !== -1) return JSON.parse(text.slice(s, e + 1));
  throw new Error('No JSON object found in Claude response');
}

async function repairJSON(broken) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8096,
      system: 'You are a JSON repair assistant. Return ONLY complete valid JSON matching the original schema: resources (with level, internet_facing fields), connections, internet_paths, summary. No markdown.',
      messages: [{ role: 'user', content: `Fix this truncated JSON:\n\n${broken}` }],
    }),
  });
  if (!r.ok) throw new Error(`Repair error ${r.status}`);
  const d = await r.json();
  return extractJSON(d.content?.[0]?.text ?? '');
}

async function callClaude(files) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set — add it to your .env file');

  const fileBlocks = Object.entries(files)
    .map(([name, content]) => `### ${name}\n\`\`\`hcl\n${content}\n\`\`\``)
    .join('\n\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'output-128k-2025-02-19',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze these Terraform files and return the infrastructure JSON:\n\n${fileBlocks}` }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);
  const raw = (await response.json()).content?.[0]?.text ?? '';

  try {
    return extractJSON(raw);
  } catch (_) {
    console.warn('[analyze] Parse failed — attempting repair…');
    try {
      return await repairJSON(raw);
    } catch (e2) {
      throw new Error(`Could not parse Claude response: ${e2.message}\n\n${raw.slice(0, 500)}`);
    }
  }
}

function diagramSummaryRow(row) {
  const data = JSON.parse(row.data);
  const resources = data.resources || [];
  return {
    id:               row.id,
    name:             row.name,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
    resource_count:   resources.length,
    connection_count: (data.connections || []).length,
    summary:          data.summary || '',
    preview_types:    [...new Set(resources.map(r => r.type))].slice(0, 8),
    level_counts: {
      l1: resources.filter(r => r.level === 1).length,
      l2: resources.filter(r => r.level === 2).length,
      l3: resources.filter(r => r.level === 3).length,
    },
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// List all diagrams
app.get('/api/diagrams', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, name, created_at, updated_at, data FROM diagrams ORDER BY updated_at DESC'
    ).all();
    res.json(rows.map(diagramSummaryRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze + save new diagram
app.post('/api/diagrams/analyze', async (req, res) => {
  try {
    const { files, zipName } = req.body;
    if (!files || Object.keys(files).length === 0)
      return res.status(400).json({ error: 'No files provided' });

    const tfFiles = Object.fromEntries(
      Object.entries(files).filter(
        ([name]) => !name.startsWith('__MACOSX') && name.endsWith('.tf')
      )
    );
    if (Object.keys(tfFiles).length === 0)
      return res.status(400).json({ error: 'No .tf files found in the zip' });

    console.log(`[analyze] ${Object.keys(tfFiles).length} file(s): ${Object.keys(tfFiles).join(', ')}`);

    const result = await callClaude(tfFiles);
    console.log(`[analyze] ${result.resources?.length ?? 0} resources, ` +
      `${result.connections?.length ?? 0} connections, ` +
      `${result.internet_paths?.length ?? 0} internet paths`);

    const now  = new Date().toISOString();
    const name = (zipName || 'diagram').replace(/\.zip$/i, '').replace(/[-_]/g, ' ').trim() || 'Untitled';

    const { lastInsertRowid } = db.prepare(
      'INSERT INTO diagrams (name, created_at, updated_at, files, data) VALUES (?, ?, ?, ?, ?)'
    ).run(name, now, now, JSON.stringify(tfFiles), JSON.stringify(result));

    res.json({ id: Number(lastInsertRowid), name, created_at: now, updated_at: now, ...result });
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single diagram
app.get('/api/diagrams/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Diagram not found' });
    const data = JSON.parse(row.data);
    res.json({ id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update diagram: rename or re-analyze
app.put('/api/diagrams/:id', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Diagram not found' });

    const now = new Date().toISOString();
    const { name, reanalyze } = req.body;

    if (reanalyze) {
      const files = JSON.parse(row.files);
      const result = await callClaude(files);
      db.prepare('UPDATE diagrams SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(result), now, req.params.id);
      const updated = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(req.params.id);
      const data = JSON.parse(updated.data);
      return res.json({ id: updated.id, name: updated.name, updated_at: now, ...data });
    }

    if (name !== undefined) {
      db.prepare('UPDATE diagrams SET name = ?, updated_at = ? WHERE id = ?')
        .run(name.trim() || 'Untitled', now, req.params.id);
    }

    res.json({ id: Number(req.params.id), name: name ?? row.name, updated_at: now });
  } catch (err) {
    console.error('[update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete diagram
app.delete('/api/diagrams/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM diagrams WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming node chat
app.post('/api/chat', async (req, res) => {
  const { nodeData, diagramContext, messages } = req.body;

  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    return;
  }

  const levelName = nodeData.level === 1 ? 'Entry/Critical'
    : nodeData.level === 2 ? 'Core Service'
    : 'Support/Config';

  const connectedLines = (diagramContext.connections || [])
    .filter(c => c.from === nodeData.id || c.to === nodeData.id)
    .map(c => c.from === nodeData.id
      ? `  → ${c.to} [${c.label}]`
      : `  ← ${c.from} [${c.label}]`)
    .join('\n') || '  (none)';

  const systemPrompt = `You are an AWS infrastructure expert helping a developer understand their Terraform-defined infrastructure.

The user has selected this resource in their diagram:
  Type:           ${nodeData.type}
  Label:          ${nodeData.label}
  Level:          ${levelName}
  Internet-facing:${nodeData.internet_facing ? ' Yes' : ' No'}
  Properties:
${Object.entries(nodeData.props || {}).map(([k,v]) => `    ${k}: ${v}`).join('\n') || '    (none)'}

Direct connections in the diagram:
${connectedLines}

Overall infrastructure: ${diagramContext.summary || '(not available)'}

Keep responses concise, practical, and specific to their configuration.
Use markdown for structure where helpful (bold, code, short bullet lists).
For the initial "explain" request, aim for 2–3 short paragraphs.`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        stream: true,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.write(`data: ${JSON.stringify({ error: `API error ${upstream.status}: ${errText}` })}\n\n`);
      res.end();
      return;
    }

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
          } else if (ev.type === 'message_stop') {
            res.write('data: [DONE]\n\n');
          }
        } catch { /* ignore parse errors on partial chunks */ }
      }
    }
    res.end();
  } catch (err) {
    console.error('[chat]', err.message);
    try {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } catch { /* response may already be closed */ }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const keyStatus = ANTHROPIC_API_KEY ? '✓ loaded' : '✗ missing — add to .env';
  console.log(`\n🔍 IaC Visualizer  →  http://localhost:${PORT}`);
  console.log(`   Model    : ${MODEL}`);
  console.log(`   API Key  : ${keyStatus}`);
  console.log(`   Database : diagrams.db\n`);
});
