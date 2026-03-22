# IaC Visualizer
Upload a `.zip` of your AWS Terraform project → get an interactive diagram.

## Disclaimer
Hi everyone, this project is obviously being vibe-coded and is not meant to be used in production.

## Quick start

```bash
# 1. Copy and fill in your API key
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# → open http://localhost:3000
```

## How it works

1. You drag-and-drop a `.zip` containing your `.tf` files onto the web UI
2. The browser extracts the files (client-side, never uploaded as-is)
3. File contents are sent to the local Express server
4. The server calls Claude's API with all `.tf` content
5. Claude extracts resources and relationships and returns structured JSON
6. The frontend renders an interactive React Flow diagram

## Configuration (.env)

| Variable           | Required | Default              | Description                     |
|--------------------|----------|----------------------|---------------------------------|
| `ANTHROPIC_API_KEY`| ✓        | —                    | Your Anthropic API key          |
| `ANTHROPIC_MODEL`  |          | `claude-sonnet-4-6`  | Override the Claude model       |
| `PORT`             |          | `3000`               | Server port                     |

## Contributing
### Adding more IaC providers

The server (`server.js`) sends raw file content to Claude with a system prompt.
To add support for e.g. AWS CDK or Pulumi:
- Add a new POST endpoint (e.g. `/api/analyze/cdk`)
- Adjust the system prompt to describe the new file format
- The frontend can be extended with a provider selector in the upload screen
