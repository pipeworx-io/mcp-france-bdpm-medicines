# @pipeworx/france-bdpm-medicines

France's official public medicines database (BDPM — "Base de Donnees
Publique des Medicaments"), published by ANSM/CNAM: every authorized specialty (CIS),
its CIP13 pack presentations with reimbursement rate and price, active-substance
composition, HAS SMR/ASMR opinions (service medical rendu / amelioration du
service medical rendu) and generic-group membership. Fleet #2933.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

The BDPM is published as bulk tables rather than an API, so Pipeworx keeps a
weekly-refreshed copy of the official tables. This is the French *national* list with reimbursement data, distinct
from the EU-level `eu-ctis` / `ema-medicines` packs, which cover
EU-centralized authorizations and clinical-trial information rather than
France's own AMM (autorisation de mise sur le marche) and Assurance Maladie
reimbursement rates.

## Tools

- `fr_medicine(cis?, name?)` — one medicine by its CIS code or exact official
  denomination: marketing-authorization status, every CIP13 presentation
  (pack size, reimbursement rate, price before/after dispensing fee),
  active-substance composition, SMR/ASMR opinions, any "usage professionnel"
  restriction, and generic-group membership if it belongs to one. For a
  partial/fuzzy name, use `fr_medicine_search` first to find the CIS.
- `fr_medicine_search(name?, substance?, limit?)` — search by the start of a
  medicine's name and/or an active substance (prefix match only — "DOLIPRANE"
  finds "DOLIPRANE 1000 mg..." but not "CODOLIPRANE"). Pass both to
  intersect. Returns CIS, denomination, holder and marketing status per match.
- `fr_generic_group(group_id)` — one generic group's full membership (the
  reference/princeps specialty plus every generic and substitutable generic),
  from the `group_id` a `fr_medicine` response returns.

Every response carries `data_as_of` (the week the mirror was last refreshed),
`source` and `licence`.

### Reading reimbursement rate

`taux_remboursement` is per CIP13 *presentation*, not per CIS — different pack
sizes of the same medicine can carry different rates, and a presentation that
is marketed-but-not-reimbursed returns `null`. `fr_medicine`'s top-level
`reimbursement_rates` is the distinct set across all of a medicine's
presentations, for a quick answer when they all agree.

### Generic groups

`type` on a group member: `0` = princeps (reference specialty), `1` =
generic, `2` = generic (range complement), `4` = substitutable generic
(`type_label` spells these out). A meaningful fraction of CIS codes in the
generic-group table (~23% measured 2026-10-11) reference specialties that have
since been withdrawn and no longer appear in the medicines table — `fr_generic_group`
still lists them (by CIS and type) with `denomination: null` rather than
silently dropping them, since the group composition itself is still accurate.

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds the
copy of the tables; a standalone `npm install` has no data to read, and every
tool throws a clear "not bound in this runtime" error there instead of
returning an empty list.

## Data sources

- ANSM/CNAM, Base de Donnees Publique des Medicaments (BDPM) — the seven
  official BDPM tables (specialties, presentations, composition, HAS SMR and
  ASMR opinions, generic groups, prescribing restrictions), joined on CIS code.
  Every response carries `data_as_of` (the week the copy was last refreshed).

**Licence: Licence Ouverte / Open Licence v1.0 (Etalab, October 2011)** — free
to reproduce, copy, publish, transmit, redistribute, adapt, modify and exploit
commercially, including combined with other data or embedded in a product, on
condition of mentioning the source and the date of its last update — exactly
the `source` + `data_as_of` every response here carries. Reciting it does not
confer official status or imply ANSM/CNAM endorsement of this reuse.

The prescribing-restriction ("usage professionnel") table has far more rows
than there are medicines, because the same CIS can carry several restriction
texts (dentistry, hospital-only, etc); `fr_medicine` returns the distinct set.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "france-bdpm-medicines": {
      "url": "https://gateway.pipeworx.io/france-bdpm-medicines/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/france-bdpm-medicines/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fr_medicine \
  -H 'Content-Type: application/json' \
  -d '{"cis":"60234100"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fr_medicine`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-france-bdpm-medicines` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/france-bdpm-medicines/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "france-bdpm-medicines": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-france-bdpm-medicines"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about France Bdpm Medicines data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
