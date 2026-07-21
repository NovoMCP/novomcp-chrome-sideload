# NovoMCP Chrome extension (sideload)

Molecular intelligence for PubChem, ChEMBL, and preprints — configurable engine URL, unpacked/sideload distribution.

This is the **sideload/OSS variant** of the NovoMCP Chrome extension. It differs from the [production build](https://github.com/novomcp/novomcp-chrome-extension) in three ways:

1. **Configurable engine URL** — defaults to `https://api.novomcp.com`, but the popup surfaces an "Engine URL" setting so you can point at `http://localhost:8018` (your local NovoMCP OSS engine) or any self-hosted deployment.
2. **`localhost` in `host_permissions`** — the manifest whitelists `http://localhost/*` and `http://127.0.0.1/*` so the extension can reach a local engine.
3. **No Chrome Web Store distribution** — load unpacked from `dist/` after `npm run build`. No developer-account fees, no store review, no wait.

## Install

Prerequisites: Node 18+, Chrome 116+.

```bash
git clone https://github.com/novomcp/novomcp-chrome-sideload.git
cd novomcp-chrome-sideload
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `dist/` directory in this repo

The NovoMCP icon appears in the toolbar.

## Configure

Click the NovoMCP toolbar icon → popup opens.

**Option A — talk to your local OSS engine:**
1. Start the engine locally (from the [OSS repo](https://github.com/novomcp/novomcp)): `python main_https.py`
2. In the popup, expand **Self-hosted or local NovoMCP engine (advanced)**
3. Set **Engine URL** to `http://localhost:8018`
4. Leave the API key blank (or type any string — `LocalAuthGate` accepts any bearer token)
5. Click **Connect**

**Option B — talk to the hosted API:**
1. Sign up at [app.novomcp.com/signup](https://app.novomcp.com/signup)
2. Copy your `nmcp_*` key from [app.novomcp.com/keys](https://app.novomcp.com/keys)
3. Paste into the popup's **Novo API key** field
4. Click **Connect**

**Option C — talk to your own self-hosted engine:**
1. Set **Engine URL** to your engine's public URL (e.g. `https://novomcp.your-lab.edu`)
2. Paste any API key your engine expects (or leave blank if you're running the OSS LocalAuthGate)
3. Click **Connect**

## Use

Once connected, the extension activates on:
- PubChem
- ChEMBL
- bioRxiv / medRxiv / arXiv
- novomcp.com / app.novomcp.com

Any SMILES string on the page is detectable → click it → the side panel shows ADMET properties, compliance status, drug-likeness scores, and quick actions.

## Development

```bash
npm run dev        # vite dev server for popup + side panel iteration
npm run typecheck  # tsc --noEmit
npm run build      # production build into dist/
npm run package    # build + zip dist/ (for sharing with teammates)
```

Vite + `@crxjs/vite-plugin` handles the manifest transformation and HMR for extension pages.

## What's the same as the production build?

Everything user-visible: ambient SMILES detection, side panel UI, the tool catalog, the audit-trail conventions. When you fix a bug in the production repo, it usually cherry-picks cleanly into the sideload repo (and vice versa).

## What's different from the production build?

| | Production | Sideload |
|---|---|---|
| Distribution | Chrome Web Store (`.zip` submission) | Unpacked from `dist/` |
| Engine URL | Hardcoded `https://api.novomcp.com` | Configurable, defaults to hosted |
| `host_permissions` | Production hosts only | + `http://localhost/*` + `http://127.0.0.1/*` |
| Manifest `key` field | Yes (stable extension ID for the Web Store listing) | No (unpacked extensions don't need it) |
| Extension name | "NovoMCP" | "NovoMCP (Sideload)" |
| API key required? | Yes (`nmcp_*` for the hosted API) | Optional (blank works for local engine) |

## Support

- **NovoMCP OSS engine:** https://github.com/novomcp/novomcp
- **Docs:** https://github.com/novomcp/novomcp/tree/main/docs
- **Issues:** file against this repo for extension bugs, against `novomcp/novomcp` for engine bugs.

## License

Apache-2.0. See `LICENSE`.
