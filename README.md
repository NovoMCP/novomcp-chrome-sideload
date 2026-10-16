# NovoMCP Chrome extension (sideload)

Molecular intelligence for PubChem, ChEMBL, and preprints — configurable engine URL, unpacked/sideload distribution.

This is the **sideload/OSS variant** of the NovoMCP Chrome extension. It differs from the [production build](https://github.com/novomcp/novomcp-chrome-extension) in three ways:

1. **Configurable engine URL** — defaults to `http://localhost:8018` (your local NovoMCP engine); the popup's "Engine URL" setting points it at a DGX Spark on your network or any self-hosted deployment.
2. **Self-hosted engine access** — the manifest grants `http://localhost/*` and `http://127.0.0.1/*` up front, and lists `http(s)://*/*` under `optional_host_permissions` so the popup can request access to exactly the engine host you configure (e.g. a Spark on the LAN).
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

Click the NovoMCP toolbar icon → popup opens. Enter an **Engine URL**, leave the API key blank for a single-user engine (`LocalAuthGate` accepts any bearer token), and click **Connect**.

**Option A — an engine on this machine:**
1. Start the engine (from the [engine repo](https://github.com/novomcp/novomcp)): `docker compose up -d` — see the [quickstart](https://docs.novomcp.com/quickstart/)
2. Leave **Engine URL** at the default, `http://localhost:8018`
3. Click **Connect**

**Option B — a DGX Spark (or any engine) on your network:**
1. Bring the engine up on the Spark: [Run the whole engine on an NVIDIA DGX Spark](https://docs.novomcp.com/novo-station-dgx-spark/) (`docker compose -f compose.spark.yml up -d`)
2. Set **Engine URL** to the Spark's address, e.g. `http://spark-xxxx.local:8018` or `http://192.168.1.50:8018`
3. Click **Connect** — Chrome asks once for permission to reach that address (requested from `optional_host_permissions`, scoped to just that host)

**Option C — a self-hosted deployment behind a domain:**
1. Set **Engine URL** to your engine's URL (e.g. `https://novomcp.your-lab.edu`)
2. Paste any API key your engine expects (or leave blank for `LocalAuthGate`)
3. Click **Connect** and allow access when prompted

## Use

Once connected, the extension activates on:
- PubChem
- ChEMBL
- bioRxiv / medRxiv / arXiv
- novomcp.com / app.novomcp.com

Any SMILES string on the page is detectable → click it → the side panel shows ADMET properties, compliance status, drug-likeness scores, and quick actions.

- Detected SMILES get a **dashed underline**. Hover the underlined **text** for a preview card; click it to run the profile, then **Open in sidebar**. The extension reacts to SMILES text, not to structure images. (On PubChem the canonical SMILES is under *Names and Identifiers → Computed Descriptors → SMILES*.)
- **Reload tabs that were open before you clicked Connect.** The extension decorates pages that load after it's connected, so an already-open tab shows no underlines until you reload it.

Full guide (both add-ins, remote engines, troubleshooting): [docs.novomcp.com/sideload-add-ins](https://docs.novomcp.com/sideload-add-ins/).

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
| Engine URL | Hardcoded `https://api.novomcp.com` | Configurable, defaults to `http://localhost:8018` |
| `host_permissions` | Production hosts only | + `http://localhost/*` + `http://127.0.0.1/*`; other engine hosts requested at Connect |
| Manifest `key` field | Yes (stable extension ID for the Web Store listing) | No (unpacked extensions don't need it) |
| Extension name | "NovoMCP" | "NovoMCP (Sideload)" |
| API key required? | Yes (`nmcp_*` for the hosted API) | Optional (blank works for a single-user engine) |

## Support

- **NovoMCP OSS engine:** https://github.com/novomcp/novomcp
- **Docs:** https://docs.novomcp.com/
- **Issues:** file against this repo for extension bugs, against `novomcp/novomcp` for engine bugs.

## License

Apache-2.0. See `LICENSE`.
