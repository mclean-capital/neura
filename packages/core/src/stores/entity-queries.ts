import type { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import type {
  FactEntry,
  EntityEntry,
  EntityRelationship,
  TimelineEntry,
  MemoryStats,
} from '@neura/types';
import { mapFact } from './mappers.js';
import type { FactRow } from './mappers.js';

// --- Phase 5b: Temporal Tracking ---

export async function invalidateFact(db: PGlite, id: string): Promise<void> {
  await db.query('UPDATE facts SET valid_to = NOW(), updated_at = NOW() WHERE id = $1', [id]);
}

export async function supersedeFact(db: PGlite, oldId: string, newId: string): Promise<void> {
  await db.query(
    'UPDATE facts SET valid_to = NOW(), superseded_by = $2, updated_at = NOW() WHERE id = $1',
    [oldId, newId]
  );
}

export async function getFactHistory(
  db: PGlite,
  content: string,
  category: string
): Promise<FactEntry[]> {
  const result = await db.query<FactRow>(
    `SELECT * FROM facts WHERE content = $1 AND category = $2 ORDER BY created_at DESC`,
    [content, category]
  );
  return result.rows.map((r) => mapFact(r));
}

// --- Phase 5b: Entities ---

export async function upsertEntity(db: PGlite, name: string, type: string): Promise<string> {
  const id = crypto.randomUUID();
  const canonicalName = name.toLowerCase().trim();
  const result = await db.query<{ id: string }>(
    `INSERT INTO entities (id, name, type, canonical_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (canonical_name, type) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [id, name, type, canonicalName]
  );
  return result.rows[0].id;
}

export async function getEntities(db: PGlite, type?: string): Promise<EntityEntry[]> {
  if (type) {
    const result = await db.query<{
      id: string;
      name: string;
      type: string;
      canonical_name: string;
      created_at: string;
    }>('SELECT * FROM entities WHERE type = $1 ORDER BY name', [type]);
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as EntityEntry['type'],
      canonicalName: r.canonical_name,
      createdAt: r.created_at,
    }));
  }
  const result = await db.query<{
    id: string;
    name: string;
    type: string;
    canonical_name: string;
    created_at: string;
  }>('SELECT * FROM entities ORDER BY name');
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type as EntityEntry['type'],
    canonicalName: r.canonical_name,
    createdAt: r.created_at,
  }));
}

export async function linkFactEntity(db: PGlite, factId: string, entityId: string): Promise<void> {
  await db.query(
    'INSERT INTO fact_entities (fact_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [factId, entityId]
  );
}

export async function getRelatedFacts(db: PGlite, factId: string, limit = 5): Promise<FactEntry[]> {
  const result = await db.query<FactRow>(
    `SELECT DISTINCT f2.* FROM fact_entities fe1
     JOIN fact_entities fe2 ON fe1.entity_id = fe2.entity_id
     JOIN facts f2 ON fe2.fact_id = f2.id
     WHERE fe1.fact_id = $1
       AND fe2.fact_id != $1
       AND f2.valid_to IS NULL
       AND (f2.expires_at IS NULL OR f2.expires_at > NOW())
     LIMIT $2`,
    [factId, limit]
  );
  return result.rows.map((r) => mapFact(r));
}

export async function getEntityRelationships(
  db: PGlite,
  entityId: string
): Promise<EntityRelationship[]> {
  const result = await db.query<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relationship: string;
    valid_from: string;
    valid_to: string | null;
    source_fact_id: string | null;
    created_at: string;
  }>('SELECT * FROM entity_relationships WHERE source_entity_id = $1 OR target_entity_id = $1', [
    entityId,
  ]);
  return result.rows.map((r) => ({
    id: r.id,
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    relationship: r.relationship,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    sourceFactId: r.source_fact_id,
    createdAt: r.created_at,
  }));
}

export async function createEntityRelationship(
  db: PGlite,
  sourceEntityId: string,
  targetEntityId: string,
  relationship: string,
  sourceFactId?: string
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, relationship, source_fact_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sourceEntityId, targetEntityId, relationship, sourceFactId ?? null]
  );
  return id;
}

// --- Phase 5b: Timeline & Stats ---

export async function getTimeline(
  db: PGlite,
  from: Date,
  to: Date,
  entityFilter?: string
): Promise<TimelineEntry[]> {
  const params: unknown[] = [from.toISOString(), to.toISOString()];

  let entityJoin = '';
  let entityWhere = '';
  if (entityFilter) {
    entityJoin =
      'JOIN fact_entities fe ON f.id = fe.fact_id JOIN entities e ON fe.entity_id = e.id';
    entityWhere = `AND e.canonical_name = $${params.length + 1}`;
    params.push(entityFilter.toLowerCase().trim());
  }

  const query = `
    SELECT 'fact_created' AS type, f.created_at AS timestamp, f.content, f.id AS fact_id, NULL AS entity_name
    FROM facts f ${entityJoin}
    WHERE f.created_at BETWEEN $1 AND $2 ${entityWhere}

    UNION ALL

    SELECT 'fact_invalidated' AS type, f.valid_to AS timestamp, f.content, f.id AS fact_id, NULL AS entity_name
    FROM facts f ${entityJoin}
    WHERE f.valid_to IS NOT NULL AND f.valid_to BETWEEN $1 AND $2 ${entityWhere}

    UNION ALL

    SELECT 'entity_created' AS type, e2.created_at AS timestamp, e2.name AS content, NULL AS fact_id, e2.name AS entity_name
    FROM entities e2
    WHERE e2.created_at BETWEEN $1 AND $2
    ${entityFilter ? `AND e2.canonical_name = $${params.length}` : ''}

    UNION ALL

    SELECT 'relationship_created' AS type, er.created_at AS timestamp,
           er.relationship AS content, er.source_fact_id AS fact_id, NULL AS entity_name
    FROM entity_relationships er
    ${entityFilter ? `JOIN entities esrc ON er.source_entity_id = esrc.id JOIN entities etgt ON er.target_entity_id = etgt.id` : ''}
    WHERE er.created_at BETWEEN $1 AND $2
    ${entityFilter ? `AND (esrc.canonical_name = $${params.length} OR etgt.canonical_name = $${params.length})` : ''}

    ORDER BY timestamp ASC
  `;

  const result = await db.query<{
    type: TimelineEntry['type'];
    timestamp: string;
    content: string;
    fact_id: string | null;
    entity_name: string | null;
  }>(query, params);

  return result.rows.map((r) => ({
    type: r.type,
    timestamp: r.timestamp,
    content: r.content,
    factId: r.fact_id ?? undefined,
    entityName: r.entity_name ?? undefined,
  }));
}

export async function getMemoryStats(db: PGlite): Promise<MemoryStats> {
  const [
    totalFacts,
    activeFacts,
    expiredFacts,
    categories,
    entities,
    relationships,
    dateRange,
    transcripts,
  ] = await Promise.all([
    db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM facts'),
    db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM facts WHERE valid_to IS NULL'),
    db.query<{ count: string }>(
      'SELECT COUNT(*)::TEXT as count FROM facts WHERE valid_to IS NOT NULL'
    ),
    db.query<{ category: string; count: string }>(
      'SELECT COALESCE(tag_path, category) as category, COUNT(*)::TEXT as count FROM facts WHERE valid_to IS NULL GROUP BY COALESCE(tag_path, category) ORDER BY count DESC LIMIT 10'
    ),
    db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM entities'),
    db.query<{ count: string }>('SELECT COUNT(*)::TEXT as count FROM entity_relationships'),
    db.query<{ oldest: string | null; newest: string | null }>(
      'SELECT MIN(created_at)::TEXT as oldest, MAX(created_at)::TEXT as newest FROM facts'
    ),
    db.query<{ count: string }>(
      'SELECT ((SELECT COUNT(*) FROM transcript_chunks) + (SELECT COUNT(*) FROM transcripts WHERE embedding IS NOT NULL))::TEXT as count'
    ),
  ]);

  const topCategories: Record<string, number> = {};
  for (const row of categories.rows) {
    topCategories[row.category] = parseInt(row.count, 10);
  }

  return {
    totalFacts: parseInt(totalFacts.rows[0].count, 10),
    activeFacts: parseInt(activeFacts.rows[0].count, 10),
    expiredFacts: parseInt(expiredFacts.rows[0].count, 10),
    topCategories,
    totalEntities: parseInt(entities.rows[0].count, 10),
    totalRelationships: parseInt(relationships.rows[0].count, 10),
    oldestFact: dateRange.rows[0].oldest,
    newestFact: dateRange.rows[0].newest,
    totalTranscriptsIndexed: parseInt(transcripts.rows[0].count, 10),
    storageEstimate: `${totalFacts.rows[0].count} facts`,
  };
}
