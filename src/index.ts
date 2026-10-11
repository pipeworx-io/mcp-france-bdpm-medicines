interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * france-bdpm-medicines — France's official public medicines database (BDPM:
 * "Base de Donnees Publique des Medicaments"), published by ANSM/CNAM: every
 * authorized medicine with its presentations, reimbursement rates, prices,
 * composition, HAS opinions and generic groups. Fleet #2933.
 *
 * Public surfaces (README, descriptions, `source`) name the publisher and the
 * dataset only, never the download route (CLAUDE.md step 9b, fleet #2938);
 * the route lives in scripts/bdpm/refresh.sh. The site has no API and publishes bulk files only, so
 * scripts/bdpm/refresh.sh downloads the seven official tables weekly, joins
 * them on CIS code (Code Identifiant de Specialite) and loads them into a D1
 * database the gateway hands this pack as `_d1`
 * (pack-manifest "d1Binding": "BDPM_DB"). Design note:
 * docs/bdpm-mirror-design.md.
 *
 * Covers: medicines (CIS), their CIP13 pack presentations and prices, active
 * substance composition, HAS SMR/ASMR opinions (service medical rendu /
 * amelioration du service medical rendu), generic-group membership, and the
 * "usage professionnel" restriction flag -- the French national list with
 * reimbursement rates, distinct from the EU-level eu-ctis / ema-medicines
 * packs.
 *
 * Reuse terms: Licence Ouverte / Open Licence v1.0 (Etalab, October 2011) --
 * free reuse including commercial use and redistribution, on condition of
 * attributing the source and its last-update date. Every response here
 * carries `source` and `data_as_of`.
 */
import {
  type D1Like,
  type MedicineRow,
  LICENCE,
  SOURCE,
  asmrOf,
  compositionOf,
  cpdOf,
  dataAsOf,
  findByCis,
  findByNameExact,
  genericGroupForCis,
  genericGroupMembers,
  normalizeName,
  presentationsOf,
  requireDb,
  searchByName,
  searchBySubstance,
  shapeComposition,
  shapeGroupMember,
  shapeMedicine,
  shapeOpinion,
  shapePresentation,
  smrOf,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'fr_medicine',
    description:
      'One French medicine by its CIS code or exact official name, from the BDPM (France\'s official public medicines database, published by ANSM/CNAM). Returns the specialty\'s status and marketing authorization, every CIP13 pack presentation with its reimbursement rate and price, active-substance composition, HAS SMR/ASMR opinions (service medical rendu / amelioration du service medical rendu), generic-group membership and any "usage professionnel" restriction. Use for "what is the reimbursement rate for Doliprane 1000mg", "what is in CIS 60234100", or looking up a French drug by its exact brand/INN name. For partial or fuzzy name matches use fr_medicine_search first.',
    summary: 'One French medicine (BDPM) by CIS code or exact name: presentations, composition, SMR/ASMR, reimbursement.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cis: { type: 'string', description: 'CIS code (Code Identifiant de Specialite), e.g. "60234100".' },
        name: { type: 'string', description: 'Exact official denomination, e.g. "DOLIPRANE 1000 mg, comprimé". Case/accent-insensitive. Use fr_medicine_search for partial names.' },
      },
    },
  },
  {
    name: 'fr_medicine_search',
    description:
      'Search French medicines in the BDPM by the start of their name and/or by an active substance, returning matching specialties (CIS code, denomination, holder, pharmaceutical form, marketing status). Use for "medicines containing paracetamol", "search Doliprane", or finding a CIS code to pass to fr_medicine. Prefix match only ("DOLIPRANE" finds "DOLIPRANE 1000 mg..." but not "CODOLIPRANE"); pass both name and substance to intersect.',
    summary: 'Search BDPM medicines by name prefix and/or active substance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Start of the medicine\'s official denomination, e.g. "DOLIPRANE".' },
        substance: { type: 'string', description: 'Start of an active substance name, e.g. "PARACETAMOL".' },
        limit: { type: 'number', description: 'Maximum results (1-100, default 20).' },
      },
    },
  },
  {
    name: 'fr_generic_group',
    description:
      'One BDPM generic group by its group id: the reference (princeps) specialty and every generic/substitutable member, each with its CIS code, denomination and generic type. Use after fr_medicine returns a generic_group.group_id, to see every interchangeable specialty in that group.',
    summary: 'BDPM generic group membership (princeps + generics) by group id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group_id: { type: 'string', description: 'Generic group id, from fr_medicine\'s generic_group.group_id.' },
      },
      required: ['group_id'],
    },
  },
];

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}

async function medicinePayload(db: D1Like, row: MedicineRow) {
  const [presentations, composition, smr, asmr, cpd, group, asOf] = await Promise.all([
    presentationsOf(db, row.cis),
    compositionOf(db, row.cis),
    smrOf(db, row.cis),
    asmrOf(db, row.cis),
    cpdOf(db, row.cis),
    genericGroupForCis(db, row.cis),
    dataAsOf(db),
  ]);
  const reimbursementRates = [...new Set(presentations.map((p) => p.taux_remboursement).filter((x): x is string => !!x))];
  let genericGroup: Record<string, unknown> | null = null;
  if (group) {
    const members = await genericGroupMembers(db, group.group_id);
    genericGroup = {
      group_id: group.group_id,
      group_label: group.group_label,
      this_specialty_type: group.type,
      this_specialty_type_label: group.type != null ? shapeGroupMember(group).type_label : null,
      member_count: members.length,
    };
  }
  return {
    found: true,
    medicine: shapeMedicine(row),
    presentations: presentations.map(shapePresentation),
    composition: composition.map(shapeComposition),
    reimbursement_rates: reimbursementRates,
    smr_opinions: smr.map(shapeOpinion),
    asmr_opinions: asmr.map(shapeOpinion),
    restricted_use: cpd.length ? cpd : null,
    generic_group: genericGroup,
    data_as_of: asOf,
    source: SOURCE,
    licence: LICENCE,
  };
}

async function medicineTool(db: D1Like, args: Record<string, unknown>) {
  const cis = args.cis != null && args.cis !== '' ? String(args.cis).trim() : null;
  const name = args.name != null && args.name !== '' ? String(args.name).trim() : null;
  if (!cis && !name) {
    return {
      found: false,
      reason: 'missing_argument',
      message: 'Pass cis or name.',
      data_as_of: null,
      source: SOURCE,
    };
  }
  const asOf = await dataAsOf(db);
  if (cis) {
    const row = await findByCis(db, cis);
    if (!row) {
      return {
        found: false,
        reason: 'not_held',
        cis,
        message: `No medicine with CIS ${cis} is in the BDPM data as of ${asOf ?? 'the last refresh'}.`,
        hint: 'Check the CIS code, or use fr_medicine_search by name/substance.',
        data_as_of: asOf,
        source: SOURCE,
      };
    }
    return medicinePayload(db, row);
  }
  const nameNorm = normalizeName(name);
  const rows = await findByNameExact(db, nameNorm);
  if (!rows.length) {
    return {
      found: false,
      reason: 'not_found',
      name,
      message: `No BDPM medicine has the exact denomination ${JSON.stringify(name)}.`,
      hint: 'Use fr_medicine_search for a partial/prefix match, or pass the CIS code if known.',
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  if (rows.length > 1) {
    return {
      found: false,
      reason: 'ambiguous',
      name,
      message: `${rows.length} BDPM medicines share the exact denomination ${JSON.stringify(name)}.`,
      candidates: rows.map(shapeMedicine),
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  return medicinePayload(db, rows[0]);
}

async function searchTool(db: D1Like, args: Record<string, unknown>) {
  const name = args.name != null && args.name !== '' ? String(args.name).trim() : null;
  const substance = args.substance != null && args.substance !== '' ? String(args.substance).trim() : null;
  if (!name && !substance) throw new Error('Pass name and/or substance.');
  const limit = clamp(args.limit, 1, 100, 20);
  const asOf = await dataAsOf(db);

  let rows: MedicineRow[];
  if (name && substance) {
    const byName = await searchByName(db, normalizeName(name), 500);
    const bySubstanceSet = new Set((await searchBySubstance(db, normalizeName(substance), 500)).map((r) => r.cis));
    rows = byName.filter((r) => bySubstanceSet.has(r.cis)).slice(0, limit);
  } else if (name) {
    rows = await searchByName(db, normalizeName(name), limit);
  } else {
    rows = await searchBySubstance(db, normalizeName(substance as string), limit);
  }

  return {
    name: name ?? null,
    substance: substance ?? null,
    returned: rows.length,
    results: rows.map((r) => ({
      cis: r.cis,
      denomination: r.denomination,
      forme_pharmaceutique: r.forme_pharma,
      titulaire: r.titulaire,
      etat_commercialisation: r.etat_commercialisation,
    })),
    ...(rows.length === 0
      ? {
          found: false,
          reason: 'no_match',
          hint: 'Prefix match only -- try a shorter start of the name, or check spelling/accents.',
        }
      : {}),
    data_as_of: asOf,
    source: SOURCE,
  };
}

async function genericGroupTool(db: D1Like, args: Record<string, unknown>) {
  const groupId = String(args.group_id ?? '').trim();
  if (!groupId) throw new Error('group_id is required');
  const members = await genericGroupMembers(db, groupId);
  const asOf = await dataAsOf(db);
  if (!members.length) {
    return {
      found: false,
      reason: 'not_held',
      group_id: groupId,
      message: `No BDPM generic group ${groupId} is held.`,
      hint: 'group_id comes from fr_medicine\'s generic_group.group_id.',
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  const cisList = members.map((m) => m.cis);
  const placeholders = cisList.map(() => '?').join(',');
  const denomRows = await db
    .prepare(`SELECT cis, denomination FROM bdpm_medicines WHERE cis IN (${placeholders})`)
    .bind(...cisList)
    .all<{ cis: string; denomination: string }>();
  const denomByCis = new Map(denomRows.results.map((r) => [r.cis, r.denomination]));
  return {
    found: true,
    group_id: groupId,
    group_label: members[0].group_label,
    member_count: members.length,
    members: members.map((m) => shapeGroupMember(m, denomByCis.get(m.cis))),
    data_as_of: asOf,
    source: SOURCE,
    licence: LICENCE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const db = requireDb(args._d1);
  switch (name) {
    case 'fr_medicine':
      return medicineTool(db, args);
    case 'fr_medicine_search':
      return searchTool(db, args);
    case 'fr_generic_group':
      return genericGroupTool(db, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
