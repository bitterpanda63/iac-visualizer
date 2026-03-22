import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ─── Claude prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert AWS infrastructure architect.
Analyze Terraform HCL configuration files and extract every AWS resource and the
relationships between them.

Return ONLY valid JSON — no markdown, no code fences, no extra text — with this
exact structure:

{
  "resources": [
    {
      "id": "aws_resource_type.logical_name",
      "type": "aws_resource_type",
      "name": "logical_name",
      "label": "Short human-readable label",
      "props": { "key": "value" }
    }
  ],
  "connections": [
    {
      "from": "source_resource_id",
      "to":   "target_resource_id",
      "label": "relationship"
    }
  ],
  "summary": "One sentence describing the overall infrastructure"
}

Rules:
- Only include actual aws_* resources (not data sources, variables, locals, outputs)
- Derive connections from Terraform references: e.g. subnet_id = aws_subnet.public.id → connection from resource using it TO aws_subnet.public
- Connection labels: "contains", "routes_to", "uses", "triggers", "reads_from", "writes_to", "attached_to", "peered_with"
- props: keep to the 3–5 most important attributes (cidr_block, port, engine, runtime, etc.)
- label: short name like "VPC: production", "RDS: postgres-main", "Lambda: api-handler"
- If a resource references a security group, VPC, subnet, role, etc. — add a connection
- Do not invent resources that are not in the files`;

function extractJSON(text) {
  // Strip markdown code fences if Claude wrapped the output
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }
  // Find raw JSON object
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error('No JSON object found in Claude response');
}

async function repairJSON(brokenText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8096,
      system: 'You are a JSON repair assistant. You receive truncated or malformed JSON. Complete and fix it so it is valid JSON matching the original schema (resources array, connections array, summary string). Return ONLY the complete valid JSON — no markdown, no explanation.',
      messages: [{
        role: 'user',
        content: `This JSON was truncated mid-response. Complete and fix it:\n\n${brokenText}`,
      }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  const data = await response.json();
  return extractJSON(data.content?.[0]?.text ?? '');
}

async function callClaude(files) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to your .env file');
  }

  const fileBlocks = Object.entries(files)
    .map(([name, content]) => `### ${name}\n\`\`\`hcl\n${content}\n\`\`\``)
    .join('\n\n');

  const userMessage =
    `Analyze the following Terraform files and return the infrastructure diagram JSON:\n\n${fileBlocks}`;

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
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  const data = await response.json();
  const raw  = data.content?.[0]?.text ?? '';

  try {
    return extractJSON(raw);
  } catch (e) {
    throw new Error(`Failed to parse Claude response as JSON: ${e.message}\n\nRaw response:\n${raw.slice(0, 500)}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  try {
    const { files } = req.body;

    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'No .tf files provided' });
    }

    const tfFiles = Object.fromEntries(
      Object.entries(files).filter(([name]) => name.endsWith('.tf'))
    );

    if (Object.keys(tfFiles).length === 0) {
      return res.status(400).json({ error: 'Zip contains no .tf files' });
    }

    console.log(`[analyze] Processing ${Object.keys(tfFiles).length} .tf file(s):`,
      Object.keys(tfFiles).join(', '));

    const result = await callClaude(tfFiles);

    console.log(`[analyze] Found ${result.resources?.length ?? 0} resources, ` +
      `${result.connections?.length ?? 0} connections`);

    res.json(result);
  } catch (err) {
    console.error('[analyze] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const keyStatus = ANTHROPIC_API_KEY ? '✓ loaded' : '✗ missing — add to .env';
  console.log(`\n🔍 IaC Visualizer  →  http://localhost:${PORT}`);
  console.log(`   Model    : ${MODEL}`);
  console.log(`   API Key  : ${keyStatus}\n`);
});
