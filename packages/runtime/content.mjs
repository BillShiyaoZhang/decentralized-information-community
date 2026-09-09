import { RuntimeError } from './errors.mjs';

const fail = (code, message, status = 400) => { throw new RuntimeError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function json(value, path = 'data', seen = new Set(), depth = 0) {
  if (depth > 64) fail('INVALID_CONTENT', `${path}: nested JSON is too deep`);
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) || seen.has(value)) fail('INVALID_CONTENT', `${path}: expected portable JSON`);
  if (Object.getOwnPropertySymbols(value).length) fail('INVALID_CONTENT', `${path}: symbol properties are not JSON`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && Object.keys(descriptors).length !== value.length + 1) fail('INVALID_CONTENT', `${path}: sparse arrays are not JSON`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !own(descriptor, 'value')) fail('INVALID_CONTENT', `${path}: accessors are not JSON`);
    json(descriptor.value, `${path}.${key}`, seen, depth + 1);
  }
  seen.delete(value);
}
function identifier(value, name) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value)) fail('INVALID_CONTENT', `${name}: invalid identifier`); }
function text(value, name, max = 20000) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_CONTENT', `${name}: expected nonempty text, maximum ${max}`); }
function date(value, name) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) fail('INVALID_CONTENT', `${name}: expected UTC ISO timestamp`); }
function url(value) { try { const parsed = new URL(value); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && value.length <= 2048) return; } catch {} fail('EVIDENCE_MODE', 'Source URL must use HTTP(S) without credentials'); }
function unique(items, label) {
  if (!Array.isArray(items) || items.length > 40000) fail('INVALID_CONTENT', `${label}: expected bounded array`);
  const result = new Map();
  for (const item of items) { if (!object(item)) fail('INVALID_CONTENT', `${label}: expected objects`); identifier(item.id, `${label}.id`); if (result.has(item.id)) fail('DUPLICATE_ID', `${label}: duplicate ${item.id}`); result.set(item.id, item); }
  return result;
}

/** A deliberately bounded JSON schema subset. Unknown keywords fail instead of being ignored. */
function schemaDefinition(schema, depth = 0) {
  if (!object(schema) || depth > 20) fail('INVALID_PROFILE', 'Invalid domain schema');
  const supported = ['type', 'required', 'properties', 'additionalProperties', 'enum', 'items', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'];
  if (Object.keys(schema).some(key => !supported.includes(key))) fail('INVALID_PROFILE', 'Unsupported domain schema keyword');
  if (schema.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) fail('INVALID_PROFILE', 'Unsupported domain schema type');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) fail('INVALID_PROFILE', 'Schema enum must be nonempty');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) fail('INVALID_PROFILE', 'Schema required must contain field names');
  if (schema.properties !== undefined) { if (!object(schema.properties)) fail('INVALID_PROFILE', 'Schema properties must be an object'); for (const child of Object.values(schema.properties)) schemaDefinition(child, depth + 1); }
  if (schema.items !== undefined) schemaDefinition(schema.items, depth + 1);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') fail('INVALID_PROFILE', 'additionalProperties must be boolean');
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) fail('INVALID_PROFILE', `Invalid ${key}`);
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && typeof schema[key] !== 'number') fail('INVALID_PROFILE', `Invalid ${key}`);
}
function shape(value, schema, path) {
  if (schema.type) {
    const matches = schema.type === 'object' ? object(value) : schema.type === 'array' ? Array.isArray(value) : schema.type === 'null' ? value === null : schema.type === 'integer' ? Number.isSafeInteger(value) : typeof value === schema.type;
    if (!matches) fail('DOMAIN_SCHEMA', `${path}: expected ${schema.type}`);
  }
  if (schema.enum && !schema.enum.some(candidate => same(candidate, value))) fail('DOMAIN_SCHEMA', `${path}: value outside configured enum`);
  if (object(value)) {
    for (const key of schema.required ?? []) if (!own(value, key)) fail('DOMAIN_SCHEMA', `${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) { if (own(schema.properties ?? {}, key)) shape(child, schema.properties[key], `${path}.${key}`); else if (schema.additionalProperties === false) fail('DOMAIN_SCHEMA', `${path}.${key}: unexpected field`); }
  }
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail('DOMAIN_SCHEMA', `${path}: invalid array length`);
    if (schema.items) value.forEach((item, index) => shape(item, schema.items, `${path}[${index}]`));
  }
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) fail('DOMAIN_SCHEMA', `${path}: invalid text length`);
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) fail('DOMAIN_SCHEMA', `${path}: number outside range`);
}

export const defaultContentProfile = {
  id: 'general', entityTypes: [{ id: 'document', role: 'content' }, { id: 'source', role: 'source' }],
  evidence: { factualSentenceKinds: ['fact'], allowedModes: ['link-only', 'excerpt'], excerptRights: ['permission', 'open-license', 'public-domain'] },
  publication: { blockedValues: { impact: ['high'], origin: ['ai_draft'] } },
  scope: { dimensions: [], universal: 'universal', unknown: 'unknown' },
  search: { aliases: {} }, warnings: { reviewOverdue: 'This content is due for review.' },
};

export function validateContentProfile(profile) {
  json(profile); if (!object(profile)) fail('INVALID_PROFILE', 'Content profile must be an object'); identifier(profile.id, 'profile.id');
  const types = unique(profile.entityTypes, 'entityTypes'); if (!types.size) fail('INVALID_PROFILE', 'At least one entity type is required');
  for (const type of types.values()) { if (!['content', 'source'].includes(type.role)) fail('INVALID_PROFILE', 'Entity role must be content or source'); if (type.schema) schemaDefinition(type.schema); }
  for (const field of ['factualSentenceKinds', 'allowedModes', 'excerptRights']) if (!Array.isArray(profile.evidence?.[field]) || profile.evidence[field].some(value => typeof value !== 'string' || !value)) fail('INVALID_PROFILE', `Invalid evidence.${field}`);
  if (profile.evidence.requireCitationsOnWrite !== undefined && typeof profile.evidence.requireCitationsOnWrite !== 'boolean') fail('INVALID_PROFILE', 'requireCitationsOnWrite must be boolean');
  if (!profile.evidence.allowedModes.length || profile.evidence.allowedModes.some(mode => !['link-only', 'excerpt'].includes(mode))) fail('INVALID_PROFILE', 'Invalid evidence modes');
  if (!object(profile.publication?.blockedValues) || Object.values(profile.publication.blockedValues).some(values => !Array.isArray(values))) fail('INVALID_PROFILE', 'Invalid publication restrictions');
  if (!Array.isArray(profile.scope?.dimensions) || new Set(profile.scope.dimensions).size !== profile.scope.dimensions.length || profile.scope.dimensions.some(value => typeof value !== 'string' || !value)) fail('INVALID_PROFILE', 'Invalid scope dimensions');
  text(profile.scope.universal, 'universal'); text(profile.scope.unknown, 'unknown'); if (profile.scope.universal === profile.scope.unknown) fail('INVALID_PROFILE', 'universal and unknown must differ');
  if (!object(profile.search?.aliases) || Object.values(profile.search.aliases).some(values => !Array.isArray(values) || values.some(value => typeof value !== 'string' || !value))) fail('INVALID_PROFILE', 'Invalid search aliases');
  text(profile.warnings?.reviewOverdue, 'reviewOverdue', 500);
  return profile;
}

function initialState({ profile = defaultContentProfile } = {}) {
  return { schemaVersion: 1, profile: structuredClone(validateContentProfile(profile)), entities: [], revisions: [], citations: [], links: [] };
}
function maps(data) { return { entities: new Map(data.entities.map(item => [item.id, item])), revisions: new Map(data.revisions.map(item => [item.id, item])), types: new Map(data.profile.entityTypes.map(item => [item.id, item])) }; }
const roleOf = (indexes, entity) => indexes.types.get(entity.type)?.role;
const stateFields = ['version', 'publicRevisionId', 'publishedRevisionIds', 'hidden', 'disposition'];
const immutableEntity = entity => Object.fromEntries(Object.entries(entity).filter(([key]) => !stateFields.includes(key)));

function validateSource(revision, profile) {
  const data = revision.data;
  url(data.url);
  if (!profile.evidence.allowedModes.includes(data.mode)) fail('EVIDENCE_MODE', 'Source mode is not enabled');
  if (data.mode === 'link-only') {
    // The complete source revision is allowlisted, including its extension container.
    const fields = ['title', 'url', 'mode', 'publisher', 'issuedAt', 'accessedAt', 'rights'];
    if (Object.keys(data).some(key => !fields.includes(key))) fail('EVIDENCE_MODE', 'link-only source cannot retain body, screenshots, hashes, or untyped payload fields');
    for (const key of ['publisher', 'issuedAt', 'accessedAt']) if (own(data, key)) text(data[key], key, 300);
    if (own(data, 'rights') && (!object(data.rights) || Object.keys(data.rights).some(key => key !== 'expiresAt'))) fail('EVIDENCE_MODE', 'link-only rights only support expiresAt metadata');
    if (revision.extensions !== undefined && (!object(revision.extensions) || Object.keys(revision.extensions).some(key => !['externalId', 'externalRevision'].includes(key)) || Object.values(revision.extensions).some(value => !['string', 'number'].includes(typeof value)))) fail('EVIDENCE_MODE', 'link-only extensions only support externalId and externalRevision metadata');
    const allowed = ['id', 'entityId', 'number', 'parentRevisionId', 'createdAt', 'data', 'extensions'];
    if (Object.keys(revision).some(key => !allowed.includes(key))) fail('EVIDENCE_MODE', 'link-only revision contains untyped payload');
  } else {
    text(data.text, 'source.text', 100000);
    if (!object(data.rights) || !profile.evidence.excerptRights.includes(data.rights.basis)) fail('RIGHTS_REQUIRED', 'Excerpt sources require a configured rights basis');
    text(data.rights.reference, 'rights.reference', 2048);
  }
  if (data.rights?.expiresAt !== undefined) date(data.rights.expiresAt, 'rights.expiresAt');
}

export function validateContent(data, previous) {
  json(data); if (!object(data) || data.schemaVersion !== 1) fail('INVALID_CONTENT', 'Expected content schemaVersion 1'); validateContentProfile(data.profile);
  const entities = unique(data.entities, 'entities'), revisions = unique(data.revisions, 'revisions'), citations = unique(data.citations, 'citations'); unique(data.links, 'links');
  const indexes = { entities, revisions, types: new Map(data.profile.entityTypes.map(item => [item.id, item])) };
  for (const entity of entities.values()) {
    if (!indexes.types.has(entity.type)) fail('DOMAIN_SCHEMA', 'Unknown entity type');
    if (!Number.isSafeInteger(entity.version) || entity.version < 0 || typeof entity.hidden !== 'boolean' || !['active', 'withdrawn', 'rights-expired'].includes(entity.disposition)) fail('INVALID_CONTENT', 'Invalid entity state');
    if (!Array.isArray(entity.publishedRevisionIds) || new Set(entity.publishedRevisionIds).size !== entity.publishedRevisionIds.length) fail('INVALID_CONTENT', 'Invalid publication history');
    for (const id of entity.publishedRevisionIds) if (revisions.get(id)?.entityId !== entity.id) fail('REFERENCE_ENTITY', 'Publication history crosses entities');
    if (entity.publicRevisionId !== null && (!entity.publishedRevisionIds.includes(entity.publicRevisionId) || revisions.get(entity.publicRevisionId)?.entityId !== entity.id)) fail('REFERENCE_ENTITY', 'Invalid public revision pointer');
    if (roleOf(indexes, entity) === 'source' && (entity.publicRevisionId !== null || entity.publishedRevisionIds.length)) fail('INVALID_CONTENT', 'Sources are exposed only through governed citations');
    if (roleOf(indexes, entity) === 'source') {
      if (Object.keys(immutableEntity(entity)).some(key => !['id', 'type', 'externalId', 'externalRevision'].includes(key))) fail('EVIDENCE_MODE', 'Source entity identity cannot store untyped content');
      for (const field of ['externalId', 'externalRevision']) if (entity[field] !== undefined && !['string', 'number'].includes(typeof entity[field])) fail('EVIDENCE_MODE', 'Source external identity must be a string or number');
    }
  }
  const sequence = new Set();
  for (const revision of revisions.values()) {
    const entity = entities.get(revision.entityId); if (!entity) fail('REFERENCE_MISSING', 'Revision entity does not exist');
    if (!Number.isSafeInteger(revision.number) || revision.number < 1) fail('INVALID_CONTENT', 'Revision number must be a positive safe integer');
    const key = `${entity.id}|${revision.number}`; if (sequence.has(key)) fail('DUPLICATE_REVISION', 'Revision number already exists for this entity'); sequence.add(key);
    date(revision.createdAt, 'revision.createdAt'); if (!object(revision.data)) fail('DOMAIN_SCHEMA', 'Revision data must be an object'); text(revision.data.title, 'title', 160);
    if (revision.parentRevisionId !== null) {
      const parent = revisions.get(revision.parentRevisionId); if (!parent) fail('REFERENCE_MISSING', 'Parent revision does not exist');
      if (parent.entityId !== entity.id) fail('REFERENCE_ENTITY', 'Parent revision belongs to another entity');
      if (parent.number >= revision.number) fail('PARENT_CHAIN', 'Parent revision number must precede its child');
    }
    const type = indexes.types.get(entity.type); if (type.schema) shape(revision.data, type.schema, `revision.${revision.id}`);
    if (type.role === 'source') validateSource(revision, data.profile);
    else {
      const sentences = unique(revision.data.sentences, 'sentences');
      for (const sentence of sentences.values()) { text(sentence.text, 'sentence.text'); text(sentence.kind, 'sentence.kind', 80); }
      if (revision.data.reviewDueAt !== undefined) date(revision.data.reviewDueAt, 'reviewDueAt');
      if (revision.data.scope !== undefined) validateScope(revision.data.scope, data.profile);
    }
  }
  const orders = new Set();
  for (const citation of citations.values()) {
    const answer = revisions.get(citation.revisionId), source = revisions.get(citation.sourceRevisionId);
    if (!answer || !source) fail('REFERENCE_MISSING', 'Citation revision does not exist');
    if (source.entityId !== citation.sourceEntityId) fail('REFERENCE_ENTITY', 'Citation source revision belongs to another entity');
    if (roleOf(indexes, entities.get(answer.entityId)) !== 'content' || roleOf(indexes, entities.get(source.entityId)) !== 'source') fail('REFERENCE_ENTITY', 'Citation must connect content to a source');
    if (!answer.data.sentences.some(sentence => sentence.id === citation.sentenceId)) fail('REFERENCE_POSITION', 'Citation sentence does not exist');
    if (!Number.isSafeInteger(citation.order) || citation.order < 0) fail('REFERENCE_POSITION', 'Citation order must be a nonnegative integer');
    const key = `${citation.revisionId}|${citation.sentenceId}|${citation.order}`; if (orders.has(key)) fail('REFERENCE_POSITION', 'Citation order is duplicated for this sentence'); orders.add(key);
    const position = citation.position;
    if (!object(position)) fail('REFERENCE_POSITION', 'Citation requires a position');
    if (source.data.mode === 'link-only') {
      if (position.kind !== 'link' || Object.keys(position).length !== 1) fail('REFERENCE_POSITION', 'link-only citations cannot store excerpts or hashes');
      if (Object.keys(citation).some(key => !['id', 'revisionId', 'sentenceId', 'sourceEntityId', 'sourceRevisionId', 'position', 'order', 'externalId'].includes(key))) fail('EVIDENCE_MODE', 'link-only citations cannot retain untyped payload');
      if (citation.externalId !== undefined) text(citation.externalId, 'citation.externalId', 300);
    } else if (position.kind !== 'text' || !Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end) || position.start < 0 || position.end <= position.start || position.end > source.data.text.length || Object.keys(position).some(key => !['kind', 'start', 'end'].includes(key))) fail('REFERENCE_POSITION', 'Excerpt positions are UTF-16 half-open offsets within the exact source revision');
  }
  for (const link of data.links) { if (!entities.has(link.from) || !entities.has(link.to)) fail('REFERENCE_MISSING', 'Related entity does not exist'); if (link.from === link.to) fail('REFERENCE_ENTITY', 'Self links are not allowed'); text(link.reason, 'link.reason', 500); }
  if (data.profile.evidence.requireCitationsOnWrite) for (const revision of data.revisions) if (roleOf(indexes, entities.get(revision.entityId)) === 'content') for (const sentence of revision.data.sentences) if (data.profile.evidence.factualSentenceKinds.includes(sentence.kind) && !data.citations.some(citation => citation.revisionId === revision.id && citation.sentenceId === sentence.id)) fail('EVIDENCE_REQUIRED', `Fact sentence ${sentence.id} requires valid evidence`);
  if (previous) {
    if (!same(data.profile, previous.profile)) fail('IMMUTABLE', 'Profile changes require an explicit schema migration');
    for (const collection of ['revisions', 'citations', 'links']) {
      const next = new Map(data[collection].map(item => [item.id, item]));
      for (const item of previous[collection]) if (!next.has(item.id) || !same(item, next.get(item.id))) fail('IMMUTABLE', `${collection} cannot be changed or deleted`);
    }
    const oldRevisionIds = new Set(previous.revisions.map(item => item.id)), oldCitationIds = new Set(previous.citations.map(item => item.id));
    if (data.citations.some(item => !oldCitationIds.has(item.id) && oldRevisionIds.has(item.revisionId))) fail('IMMUTABLE', 'Evidence is fixed when its content revision is created');
    for (const old of previous.entities) {
      const next = entities.get(old.id);
      if (!next || !same(immutableEntity(old), immutableEntity(next)) || old.publishedRevisionIds.some(id => !next.publishedRevisionIds.includes(id))) fail('IMMUTABLE', 'Entity identity and publication history cannot be rewritten');
      if (!same(old, next) && next.version !== old.version + 1) fail('CONFLICT', 'Entity state changes must increment the version exactly once', 409);
      if (next.publicRevisionId !== old.publicRevisionId && next.publicRevisionId !== null) assertPublishable(data, revisions.get(next.publicRevisionId), { now: new Date().toISOString() });
      for (const id of next.publishedRevisionIds) if (!old.publishedRevisionIds.includes(id) && id !== next.publicRevisionId) fail('INVALID_CONTENT', 'Publication history can only append the current published revision');
    }
    for (const entity of data.entities) if (!previous.entities.some(old => old.id === entity.id) && (entity.publicRevisionId !== null || entity.publishedRevisionIds.length || entity.version !== 0 || entity.hidden || entity.disposition !== 'active')) fail('INVALID_CONTENT', 'New entities cannot arrive prepublished or disposed');
  }
  return data;
}

export const contentModule = { name: 'content', schemaVersion: 1, initialState, validate: validateContent };

/** Offline configuration migration: all retained history must satisfy the replacement profile. */
export function configureContent(data, profile) {
  validateContent(data); const next = structuredClone(data);
  next.profile = structuredClone(validateContentProfile(profile));
  validateContent(next); return next;
}

/** Append a versioned interchange bundle. Equal records are idempotent; changed IDs fail. */
export function importContent(data, bundle, { validate = null } = {}) {
  validateContent(data); json(bundle);
  if (!object(bundle) || bundle.schemaVersion !== 1 || Object.keys(bundle).some(key => !['schemaVersion', 'entities', 'revisions', 'citations', 'links'].includes(key))) fail('INVALID_CONTENT', 'Expected content interchange schemaVersion 1');
  const next = structuredClone(data);
  for (const key of ['entities', 'revisions', 'citations', 'links']) {
    unique(bundle[key] ?? [], `import.${key}`);
    for (const record of bundle[key] ?? []) {
      const previous = next[key].find(item => item.id === record.id);
      if (key === 'entities' && stateFields.some(field => own(record, field))) fail('INVALID_CONTENT', 'Interchange entities cannot set publication or lifecycle state');
      if (previous) { if (!same(key === 'entities' ? immutableEntity(previous) : previous, record)) fail('IMMUTABLE', `${key}: ID ${record.id} already has different data`); }
      else next[key].push(key === 'entities' ? { ...structuredClone(record), version: 0, publicRevisionId: null, publishedRevisionIds: [], hidden: false, disposition: 'active' } : structuredClone(record));
    }
  }
  validateContent(next, data); if (validate) validate(next); return next;
}
export const appendContent = importContent;
export function exportContent(data) { validateContent(data); return structuredClone({ schemaVersion: 1, entities: data.entities.map(immutableEntity), revisions: data.revisions, citations: data.citations, links: data.links }); }
export function getEntity(data, id) { const entity = data.entities.find(item => item.id === id); if (!entity) fail('NOT_FOUND', 'Entity not found', 404); return structuredClone(entity); }
export function readRevision(data, id) { const revision = data.revisions.find(item => item.id === id); if (!revision) fail('NOT_FOUND', 'Revision not found', 404); return structuredClone(revision); }
function checkVersion(entity, expectedVersion) { if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== entity.version) fail('CONFLICT', 'Entity version changed', 409); }
function nowValue(now) { const value = now ?? new Date().toISOString(); date(value, 'now'); return value; }

function sourceAvailable(data, revision, now, indexes = maps(data)) {
  const entity = indexes.entities.get(revision.entityId);
  const expiresAt = revision.data.rights?.expiresAt;
  return roleOf(indexes, entity) === 'source' && !entity.hidden && entity.disposition === 'active' && (expiresAt === undefined || Date.parse(expiresAt) > Date.parse(now));
}
function assertPublishable(data, revision, { now = new Date().toISOString() } = {}) {
  const indexes = maps(data), entity = indexes.entities.get(revision?.entityId);
  if (!entity || roleOf(indexes, entity) !== 'content') fail('POLICY_REJECTED', 'Only content revisions can be published');
  for (const [field, values] of Object.entries(data.profile.publication.blockedValues)) if (values.some(value => same(value, revision.data[field]))) fail('POLICY_REJECTED', `Publication blocked by configured ${field} rule`, 422);
  const citations = data.citations.filter(item => item.revisionId === revision.id);
  for (const citation of citations) if (!sourceAvailable(data, indexes.revisions.get(citation.sourceRevisionId), now, indexes)) fail('SOURCE_UNAVAILABLE', 'A cited source is hidden, withdrawn, or lacks current rights', 422);
  for (const sentence of revision.data.sentences) if (data.profile.evidence.factualSentenceKinds.includes(sentence.kind) && !citations.some(item => item.sentenceId === sentence.id)) fail('EVIDENCE_REQUIRED', `Fact sentence ${sentence.id} requires valid evidence`, 422);
}
export function publishContent(data, { entityId, revisionId, expectedVersion, now } = {}) {
  validateContent(data); const next = structuredClone(data), entity = next.entities.find(item => item.id === entityId), revision = next.revisions.find(item => item.id === revisionId);
  if (!entity || !revision) fail('NOT_FOUND', 'Entity or revision not found', 404); checkVersion(entity, expectedVersion);
  if (revision.entityId !== entityId) fail('REFERENCE_ENTITY', 'Publication revision belongs to another entity');
  assertPublishable(next, revision, { now: nowValue(now) }); entity.publicRevisionId = revisionId; entity.hidden = false; entity.version++;
  if (!entity.publishedRevisionIds.includes(revisionId)) entity.publishedRevisionIds.push(revisionId);
  validateContent(next); return next;
}
export function hideContent(data, { entityId, expectedVersion, hidden = true } = {}) {
  validateContent(data); const next = structuredClone(data), entity = next.entities.find(item => item.id === entityId);
  if (!entity) fail('NOT_FOUND', 'Entity not found', 404); checkVersion(entity, expectedVersion); if (typeof hidden !== 'boolean') fail('INVALID_CONTENT', 'hidden must be boolean');
  entity.hidden = hidden; entity.version++; validateContent(next); return next;
}
export function setSourceDisposition(data, { entityId, expectedVersion, disposition } = {}) {
  validateContent(data); const next = structuredClone(data), entity = next.entities.find(item => item.id === entityId);
  if (!entity) fail('NOT_FOUND', 'Source not found', 404); checkVersion(entity, expectedVersion);
  if (roleOf(maps(next), entity) !== 'source' || !['active', 'withdrawn', 'rights-expired'].includes(disposition)) fail('INVALID_CONTENT', 'Invalid source disposition');
  entity.disposition = disposition; entity.version++; validateContent(next); return next;
}

function validateScope(scope, profile) {
  if (!object(scope) || Object.keys(scope).some(key => !profile.scope.dimensions.includes(key))) fail('DOMAIN_SCHEMA', 'Unknown scope dimension');
  for (const values of Object.values(scope)) if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value || value.length > 120) || new Set(values).size !== values.length) fail('DOMAIN_SCHEMA', 'Scope dimensions must contain nonempty unique string arrays');
}
/** OR within a dimension, AND across dimensions. Missing scope is unknown. */
export function matchesScope(scope = {}, filters = {}, profile = defaultContentProfile) {
  validateScope(scope, profile); validateScope(filters, profile);
  return Object.entries(filters).every(([dimension, selected]) => {
    const applicable = scope[dimension] ?? [profile.scope.unknown];
    return applicable.includes(profile.scope.universal) || applicable.some(value => value !== profile.scope.unknown && selected.includes(value));
  });
}
function publicRevisionAllowed(data, revision, now, indexes) {
  const entity = indexes.entities.get(revision.entityId);
  if (!entity || entity.hidden || entity.disposition !== 'active' || !entity.publicRevisionId || !entity.publishedRevisionIds.includes(revision.id)) return false;
  try {
    // Entity history follows the current entity's visibility as well as its own
    // evidence; an old revision URL must not bypass a suppressed current page.
    assertPublishable(data, indexes.revisions.get(entity.publicRevisionId), { now });
    if (revision.id !== entity.publicRevisionId) assertPublishable(data, revision, { now });
    return true;
  } catch (error) { if (error instanceof RuntimeError) return false; throw error; }
}
function publicNode(data, revision, now, indexes) {
  const entity = indexes.entities.get(revision.entityId), content = revision.data;
  const citations = data.citations.filter(item => item.revisionId === revision.id).sort((left, right) => content.sentences.findIndex(item => item.id === left.sentenceId) - content.sentences.findIndex(item => item.id === right.sentenceId) || left.order - right.order).map(citation => {
    const source = indexes.revisions.get(citation.sourceRevisionId), position = structuredClone(citation.position);
    const value = { id: citation.id, sentenceId: citation.sentenceId, sourceEntityId: citation.sourceEntityId, sourceRevisionId: citation.sourceRevisionId, position, order: citation.order, title: source.data.title, url: source.data.url, mode: source.data.mode };
    if (position.kind === 'text') value.excerpt = source.data.text.slice(position.start, position.end);
    return value;
  });
  return { id: entity.id, type: entity.type, title: content.title, body: content.sentences.map(item => item.text).join('\n'), source: citations[0]?.url ?? '', author: 'Community', tags: [], updatedAt: revision.createdAt,
    revisionId: revision.id, revisionNumber: revision.number, sentences: content.sentences.map(item => ({ id: item.id, text: item.text, kind: item.kind })), citations, scope: structuredClone(content.scope ?? {}),
    warnings: content.reviewDueAt && Date.parse(content.reviewDueAt) <= Date.parse(now) ? [data.profile.warnings.reviewOverdue] : [] };
}
export function readPublicRevision(data, revisionId, { now } = {}) {
  validateContent(data); const time = nowValue(now), indexes = maps(data), revision = indexes.revisions.get(revisionId);
  if (!revision || !publicRevisionAllowed(data, revision, time, indexes)) return null;
  return publicNode(data, revision, time, indexes);
}
/** Public export is a projection DTO, not a private restore/interchange bundle. */
export function publicContentExport(data, { now } = {}) {
  validateContent(data); const time = nowValue(now), indexes = maps(data);
  const revisions = data.revisions.filter(revision => publicRevisionAllowed(data, revision, time, indexes)).map(revision => publicNode(data, revision, time, indexes));
  const revisionIds = new Set(revisions.map(revision => revision.revisionId));
  return { kind: 'public-content-projection', schemaVersion: 1, revisions, entities: data.entities.filter(entity => revisionIds.has(entity.publicRevisionId)).map(entity => ({ id: entity.id, type: entity.type, publicRevisionId: entity.publicRevisionId })), links: projectPublic(data, { now: time }).edges };
}
const normalize = value => value.normalize('NFKC').toLowerCase();
function searchMatches(node, query, profile) {
  const haystack = normalize(`${node.title} ${node.body}`);
  return normalize(query).trim().split(/\s+/).filter(Boolean).every(token => {
    const alternatives = new Set([token]);
    for (const [canonical, aliases] of Object.entries(profile.search.aliases)) if ([canonical, ...aliases].some(alias => normalize(alias) === token)) [canonical, ...aliases].forEach(alias => alternatives.add(normalize(alias)));
    return [...alternatives].some(term => haystack.includes(term));
  });
}
/** Every public API consumes this allowlisted projection; it never spreads private payloads. */
export function projectPublic(data, { now, query = '', scope = {}, communityId = 'governed-community', revision = 0 } = {}) {
  validateContent(data); if (typeof query !== 'string' || query.length > 500) fail('INVALID_QUERY', 'Query must contain at most 500 characters'); validateScope(scope, data.profile);
  const time = nowValue(now), indexes = maps(data);
  const nodes = [];
  for (const entity of data.entities) {
    const content = indexes.revisions.get(entity.publicRevisionId);
    if (content && publicRevisionAllowed(data, content, time, indexes)) { const node = publicNode(data, content, time, indexes); if (matchesScope(node.scope, scope, data.profile) && searchMatches(node, query, data.profile)) nodes.push(node); }
  }
  const visible = new Set(nodes.map(node => node.id)), seen = new Set();
  const edges = data.links.filter(link => visible.has(link.from) && visible.has(link.to)).filter(link => { const key = `${link.from}|${link.to}`; if (seen.has(key)) return false; seen.add(key); return true; }).map(link => ({ id: link.id, from: link.from, to: link.to, type: 'related', reason: link.reason }));
  const types = data.profile.entityTypes.filter(type => type.role === 'content').map(type => ({ id: type.id, label: type.label ?? type.id }));
  if (!types.length) types.push({ id: 'document', label: 'Document' });
  return { schemaVersion: 1, id: communityId, title: 'Community', revision, ontology: { nodeTypes: types, relationTypes: [{ id: 'related', label: 'Related', from: types.map(type => type.id), to: types.map(type => type.id) }] }, nodes, edges };
}
