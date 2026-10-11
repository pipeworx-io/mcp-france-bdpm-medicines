/**
 * Reads for france-bdpm-medicines (fleet #2933).
 *
 * The data comes from the official BDPM ("Base de Donnees Publique des
 * Medicaments"), the ANSM/CNAM public medicines database published as
 * bulk tables (route: scripts/bdpm/refresh.sh -- kept out of every public
 * surface, fleet #2938). The site publishes no API, so refresh.sh downloads the seven tables,
 * joins them on CIS code and loads them into a D1 database the gateway hands
 * this pack as `_d1` (pack-manifest "d1Binding": "BDPM_DB"). The table and
 * column names here must match scripts/bdpm/schema.sql / build-sqlite.py.
 * Refreshed weekly by .github/workflows/bdpm-refresh.yml. Design note:
 * docs/bdpm-mirror-design.md.
 *
 * Reuse terms: Licence Ouverte / Open Licence v1.0 (Etalab, October 2011) --
 * free reuse including commercial, redistribution and adaptation, on
 * condition of attributing the source and its last-update date. Every
 * response here carries `source` and `data_as_of` to satisfy that.
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export const SOURCE = 'ANSM/CNAM, Base de Donnees Publique des Medicaments (BDPM)';
export const LICENCE =
  'Licence Ouverte / Open Licence v1.0 (Etalab, October 2011) -- free reuse including commercial use, ' +
  'redistribution and adaptation, on condition of attributing the source and its last-update date.';

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'france-bdpm-medicines: the BDPM store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

/** Lookup key for a medicine/substance name. MUST match normalize_name() in
 *  scripts/bdpm/build-sqlite.py. Accents folded, upper-cased, punctuation
 *  collapsed to single spaces. */
export function normalizeName(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export async function dataAsOf(db: D1Like): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM bdpm_meta WHERE key = 'data_as_of'`).first<{ value: string }>();
  return r?.value ?? null;
}

export async function meta(db: D1Like): Promise<Record<string, string>> {
  const r = await db.prepare(`SELECT key, value FROM bdpm_meta`).all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((row) => [row.key, row.value]));
}

export interface MedicineRow {
  cis: string;
  denomination: string;
  denomination_norm: string;
  forme_pharma: string | null;
  voies_administration: string | null;
  statut_amm: string | null;
  type_procedure: string | null;
  etat_commercialisation: string | null;
  date_amm: string | null;
  statut_bdm: string | null;
  num_autorisation_europeenne: string | null;
  titulaire: string | null;
  surveillance_renforcee: string | null;
}
const MED_COLS = `cis, denomination, denomination_norm, forme_pharma, voies_administration, statut_amm,
  type_procedure, etat_commercialisation, date_amm, statut_bdm, num_autorisation_europeenne, titulaire,
  surveillance_renforcee`;

export async function findByCis(db: D1Like, cis: string): Promise<MedicineRow | null> {
  return db.prepare(`SELECT ${MED_COLS} FROM bdpm_medicines WHERE cis = ?`).bind(cis).first<MedicineRow>();
}

export async function findByNameExact(db: D1Like, nameNorm: string): Promise<MedicineRow[]> {
  const r = await db
    .prepare(`SELECT ${MED_COLS} FROM bdpm_medicines WHERE denomination_norm = ? ORDER BY cis`)
    .bind(nameNorm)
    .all<MedicineRow>();
  return r.results;
}

export async function searchByName(db: D1Like, prefixNorm: string, limit: number): Promise<MedicineRow[]> {
  const r = await db
    .prepare(
      `SELECT ${MED_COLS} FROM bdpm_medicines WHERE denomination_norm >= ? AND denomination_norm < ? ORDER BY denomination_norm LIMIT ?`,
    )
    .bind(prefixNorm, `${prefixNorm}￿`, limit)
    .all<MedicineRow>();
  return r.results;
}

export async function searchBySubstance(db: D1Like, prefixNorm: string, limit: number): Promise<MedicineRow[]> {
  const r = await db
    .prepare(
      `SELECT DISTINCT ${MED_COLS.split(',')
        .map((c) => `m.${c.trim()}`)
        .join(', ')}
       FROM bdpm_medicines m JOIN bdpm_composition c ON c.cis = m.cis
       WHERE c.denomination_substance_norm >= ? AND c.denomination_substance_norm < ?
       ORDER BY m.denomination_norm LIMIT ?`,
    )
    .bind(prefixNorm, `${prefixNorm}￿`, limit)
    .all<MedicineRow>();
  return r.results;
}

export interface PresentationRow {
  cip13: string;
  cis: string;
  cip7: string | null;
  libelle: string | null;
  statut_admin: string | null;
  etat_commercialisation: string | null;
  date_declaration: string | null;
  agrement_collectivites: string | null;
  taux_remboursement: string | null;
  prix_sans_honoraires: number | null;
  prix_avec_honoraires: number | null;
  honoraires: number | null;
  indications_remboursement: string | null;
}
export async function presentationsOf(db: D1Like, cis: string): Promise<PresentationRow[]> {
  const r = await db
    .prepare(`SELECT * FROM bdpm_presentations WHERE cis = ? ORDER BY cip13`)
    .bind(cis)
    .all<PresentationRow>();
  return r.results;
}
export async function presentationByCip13(db: D1Like, cip13: string): Promise<PresentationRow | null> {
  return db.prepare(`SELECT * FROM bdpm_presentations WHERE cip13 = ?`).bind(cip13).first<PresentationRow>();
}

export interface CompositionRow {
  forme_element: string | null;
  code_substance: string | null;
  denomination_substance: string | null;
  dosage_substance: string | null;
  reference_dosage: string | null;
  nature_composant: string | null;
  numero_liaison: string | null;
}
export async function compositionOf(db: D1Like, cis: string): Promise<CompositionRow[]> {
  const r = await db
    .prepare(
      `SELECT forme_element, code_substance, denomination_substance, dosage_substance, reference_dosage, nature_composant, numero_liaison
       FROM bdpm_composition WHERE cis = ? ORDER BY numero_liaison, id`,
    )
    .bind(cis)
    .all<CompositionRow>();
  return r.results;
}

export interface OpinionRow {
  code_ct: string | null;
  motif: string | null;
  date_avis: string | null;
  valeur: string | null;
  libelle: string | null;
}
export async function smrOf(db: D1Like, cis: string): Promise<OpinionRow[]> {
  const r = await db
    .prepare(`SELECT code_ct, motif, date_avis, valeur, libelle FROM bdpm_smr WHERE cis = ? ORDER BY date_avis DESC`)
    .bind(cis)
    .all<OpinionRow>();
  return r.results;
}
export async function asmrOf(db: D1Like, cis: string): Promise<OpinionRow[]> {
  const r = await db
    .prepare(`SELECT code_ct, motif, date_avis, valeur, libelle FROM bdpm_asmr WHERE cis = ? ORDER BY date_avis DESC`)
    .bind(cis)
    .all<OpinionRow>();
  return r.results;
}

export async function cpdOf(db: D1Like, cis: string): Promise<string[]> {
  const r = await db.prepare(`SELECT DISTINCT restriction FROM bdpm_cpd WHERE cis = ?`).bind(cis).all<{ restriction: string }>();
  return r.results.map((x) => x.restriction);
}

export interface GenericGroupRow {
  group_id: string;
  group_label: string | null;
  cis: string;
  type: number | null;
  tri: number | null;
}
export async function genericGroupForCis(db: D1Like, cis: string): Promise<GenericGroupRow | null> {
  return db
    .prepare(`SELECT group_id, group_label, cis, type, tri FROM bdpm_generic_groups WHERE cis = ? ORDER BY group_id LIMIT 1`)
    .bind(cis)
    .first<GenericGroupRow>();
}
export async function genericGroupMembers(db: D1Like, groupId: string): Promise<GenericGroupRow[]> {
  const r = await db
    .prepare(
      `SELECT g.group_id, g.group_label, g.cis, g.type, g.tri FROM bdpm_generic_groups g WHERE g.group_id = ? ORDER BY g.tri, g.cis`,
    )
    .bind(groupId)
    .all<GenericGroupRow>();
  return r.results;
}

export const GENERIC_TYPE_LABELS: Record<number, string> = {
  0: 'princeps (reference specialty)',
  1: 'generic',
  2: 'generic (range complement)',
  4: 'substitutable generic',
};

export function shapeMedicine(r: MedicineRow) {
  return {
    cis: r.cis,
    denomination: r.denomination,
    forme_pharmaceutique: r.forme_pharma,
    voies_administration: r.voies_administration,
    statut_amm: r.statut_amm,
    type_procedure: r.type_procedure,
    etat_commercialisation: r.etat_commercialisation,
    date_amm: r.date_amm,
    statut_bdm: r.statut_bdm || null,
    numero_autorisation_europeenne: r.num_autorisation_europeenne || null,
    titulaire: r.titulaire,
    surveillance_renforcee: r.surveillance_renforcee === 'Oui',
  };
}

export function shapePresentation(p: PresentationRow) {
  return {
    cip13: p.cip13,
    cip7: p.cip7,
    libelle: p.libelle,
    statut_admin: p.statut_admin,
    etat_commercialisation: p.etat_commercialisation,
    date_declaration_commercialisation: p.date_declaration,
    agrement_collectivites: p.agrement_collectivites,
    taux_remboursement: p.taux_remboursement,
    prix_sans_honoraires_eur: p.prix_sans_honoraires,
    prix_avec_honoraires_eur: p.prix_avec_honoraires,
    honoraires_eur: p.honoraires,
    indications_remboursement: p.indications_remboursement,
  };
}

export function shapeComposition(c: CompositionRow) {
  return {
    forme_pharmaceutique: c.forme_element,
    code_substance: c.code_substance,
    substance: c.denomination_substance,
    dosage: c.dosage_substance,
    reference_dosage: c.reference_dosage,
    nature_composant: c.nature_composant === 'SA' ? 'active_substance' : c.nature_composant === 'FT' ? 'therapeutic_fraction' : c.nature_composant,
    numero_liaison: c.numero_liaison,
  };
}

export function shapeOpinion(o: OpinionRow) {
  return {
    code_avis_ct: o.code_ct,
    motif: o.motif,
    date_avis: o.date_avis,
    valeur: o.valeur,
    libelle: o.libelle,
  };
}

export function shapeGroupMember(g: GenericGroupRow, denomination?: string) {
  return {
    cis: g.cis,
    denomination: denomination ?? null,
    type: g.type,
    type_label: g.type != null ? (GENERIC_TYPE_LABELS[g.type] ?? `type ${g.type}`) : null,
    tri: g.tri,
  };
}
