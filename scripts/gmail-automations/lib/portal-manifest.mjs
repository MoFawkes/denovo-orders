import { createHash, randomUUID } from 'node:crypto';

export const PORTAL_MANIFEST_SCHEMA_VERSION = 1;

const text = (value) => String(value ?? '').trim();

export function normalisePo(value) {
  const digits = text(value).replace(/\D/g, '');
  if (!digits || digits.length > 10) throw new Error('PO must contain at most 10 digits');
  return digits.padStart(10, '0');
}

export function validatePortalManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('manifest must be an object');
  if (value.schemaVersion !== PORTAL_MANIFEST_SCHEMA_VERSION) throw new Error('unsupported manifest schemaVersion');
  const required = ['executionId', 'idempotencyKey', 'po', 'gmailThreadId', 'invoiceId', 'workbookSha256', 'sourceRevision'];
  for (const field of required) if (!text(value[field])) throw new Error(`manifest.${field} is required`);
  if (!/^\d{10}$/.test(value.po)) throw new Error('manifest.po must be a 10-digit string');
  if (!Array.isArray(value.cartons) || value.cartons.length === 0) throw new Error('manifest.cartons must not be empty');
  if (value.expectedCartonCount !== value.cartons.length) throw new Error('expectedCartonCount does not match cartons');
  const ids = new Set();
  for (const carton of value.cartons) {
    if (!Number.isInteger(carton.cartonId) || carton.cartonId < 1 || ids.has(carton.cartonId)) throw new Error('cartonId values must be unique positive integers');
    ids.add(carton.cartonId);
    if (!text(carton.baseSku) || !text(carton.size)) throw new Error('each carton needs baseSku and size');
    if (!Number.isInteger(carton.quantity) || carton.quantity < 1) throw new Error('each carton quantity must be a positive integer');
    if (!['BDCM1', 'BDCM3'].includes(carton.cartonSize)) throw new Error('cartonSize must be BDCM1 or BDCM3');
  }
  return value;
}

export function buildPortalManifest({ po, gmailThreadId, invoiceId, groups, workbookBytes, sourceRevision = 'unknown', executionId = randomUUID() }) {
  const cartons = [];
  for (const group of groups) {
    for (const carton of group.cartons) {
      cartons.push({
        cartonId: cartons.length + 1,
        baseSku: text(group.sku).toUpperCase(),
        size: text(carton.size),
        quantity: Number(carton.qty),
        cartonSize: text(carton.carton_type ?? carton.cartonType ?? (carton.small ? 'BDCM3' : 'BDCM1')).toUpperCase(),
      });
    }
  }
  const workbookSha256 = createHash('sha256').update(workbookBytes).digest('hex');
  const rowDigest = createHash('sha256').update(JSON.stringify(cartons)).digest('hex');
  const normalisedPo = normalisePo(po);
  return validatePortalManifest({
    schemaVersion: PORTAL_MANIFEST_SCHEMA_VERSION,
    executionId,
    idempotencyKey: createHash('sha256').update(`${normalisedPo}:${gmailThreadId}:${invoiceId}:${rowDigest}`).digest('hex'),
    po: normalisedPo,
    gmailThreadId: text(gmailThreadId),
    invoiceId: text(invoiceId),
    expectedCartonCount: cartons.length,
    workbookSha256,
    rowDigest,
    sourceRevision: text(sourceRevision),
    createdAt: new Date().toISOString(),
    cartons,
  });
}
