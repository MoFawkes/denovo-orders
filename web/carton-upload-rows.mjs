export const CARTON_UPLOAD_HEADERS = [
  'sku',
  'size',
  'colour',
  'expectedQuantity',
  'cartonSize',
  'quantity',
  'cartonId',
  'cartonNote',
];

const CARTON_SIZES = new Set(['bdcm1', 'bdcm3']);

export function fullSkuFromProductCode(code) {
  return String(code ?? '').trim();
}

export function extractBuyerSize(productName) {
  const match = String(productName ?? '').match(/-\s*(?:UK\s*)?(\d+)(?:\s*,\s*US\s*\d+)?\s*$/i);
  return match ? match[1] : null;
}

function normalizedPo(value) {
  return String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

export function buildSkuAndExpectedBySize(rows, po) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('The buyer PO reference has no data rows.');
  const required = ['productCode', 'productName', 'PONumber', 'orderQty'];
  const missing = required.filter((column) => !Object.hasOwn(rows[0], column));
  if (missing.length) throw new Error(`Buyer PO reference is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);

  const wantedPo = normalizedPo(po);
  const matchingRows = rows.filter((row) => normalizedPo(row.PONumber) === wantedPo);
  if (!matchingRows.length) throw new Error(`The buyer PO reference contains no rows for PO ${po}.`);

  const mapping = {};
  for (const row of matchingRows) {
    const size = extractBuyerSize(row.productName);
    const sku = fullSkuFromProductCode(row.productCode);
    const expectedQuantity = Number(row.orderQty);
    if (!size || !sku || !Number.isInteger(expectedQuantity) || expectedQuantity <= 0) {
      throw new Error(`Buyer PO reference has an invalid product code, size, or order quantity for PO ${po}.`);
    }
    if (mapping[size] && (mapping[size].sku !== sku || mapping[size].expectedQuantity !== expectedQuantity)) {
      throw new Error(`Buyer PO reference has conflicting SKU or quantity values for size ${size}.`);
    }
    mapping[size] = { sku, expectedQuantity };
  }
  return mapping;
}

export class CartonUploadValidationError extends Error {
  constructor(errors) {
    super(errors.map(({ message }) => message).join('\n'));
    this.name = 'CartonUploadValidationError';
    this.errors = errors;
  }
}

function error(code, message, cartonIndex) {
  return { code, message, ...(cartonIndex == null ? {} : { cartonIndex }) };
}

export function buildCartonUploadRows({ cartons, skuAndExpectedBySize = {} } = {}) {
  const errors = [];
  if (!Array.isArray(cartons) || cartons.length === 0) {
    throw new CartonUploadValidationError([error('NO_CARTONS', 'At least one carton is required.')]);
  }

  const expectedBySku = new Map();
  const rowsSeenSku = new Set();
  const rows = cartons.map((carton, index) => {
    const number = index + 1;
    const size = String(carton?.size ?? '').trim();
    const colour = String(carton?.colour ?? '').trim();
    const mapping = skuAndExpectedBySize[size] ?? {};
    const sku = String(carton?.sku || mapping.sku || '').trim();
    const cartonExpected = carton?.expectedQuantity;
    const expectedRaw = cartonExpected === '' || cartonExpected == null ? mapping.expectedQuantity : cartonExpected;
    const quantity = Number(carton?.quantity ?? carton?.qty);
    const expectedQuantity = Number(expectedRaw);
    const cartonSize = String(carton?.cartonType ?? carton?.cartonSize ?? '').trim().toLowerCase();

    if (Array.isArray(carton?.skus) && carton.skus.length !== 1) {
      errors.push(error('MIXED_SKU_CARTON', `Carton ${number} contains more than one SKU.`, index));
    }
    if (!size) errors.push(error('MISSING_SIZE', `Carton ${number} has no size.`, index));
    if (!colour) errors.push(error('MISSING_COLOUR', `Carton ${number} has no colour.`, index));
    if (!sku) errors.push(error('UNRESOLVED_SKU', `No buyer SKU found for size ${size || number} — load the buyer PO reference or enter it manually.`, index));
    if (!Number.isInteger(expectedQuantity) || expectedQuantity <= 0) {
      errors.push(error('UNRESOLVED_EXPECTED_QUANTITY', `Enter a positive whole expected quantity for size ${size || number}.`, index));
    }
    if (sku && Number.isInteger(expectedQuantity) && expectedQuantity > 0) {
      if (expectedBySku.has(sku) && expectedBySku.get(sku) !== expectedQuantity) {
        errors.push(error('CONFLICTING_EXPECTED_QUANTITY', `Buyer SKU ${sku} has conflicting expected quantities.`, index));
      } else {
        expectedBySku.set(sku, expectedQuantity);
      }
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      errors.push(error('INVALID_QUANTITY', `Carton ${number} quantity must be a positive whole number.`, index));
    }
    if (!CARTON_SIZES.has(cartonSize)) {
      errors.push(error('INVALID_CARTON_SIZE', `Carton ${number} must use BDCM1 or BDCM3.`, index));
    }

    const firstForSku = sku && !rowsSeenSku.has(sku);
    if (sku) rowsSeenSku.add(sku);
    return {
      sku,
      size,
      colour,
      expectedQuantity: firstForSku && Number.isInteger(expectedQuantity) && expectedQuantity > 0 ? expectedQuantity : '',
      cartonSize,
      quantity,
      cartonId: number,
      cartonNote: String(carton?.cartonNote ?? '').trim(),
    };
  });

  if (rows.length !== cartons.length) errors.push(error('DROPPED_CARTON', 'A carton was dropped while building the upload.'));
  if (errors.length) throw new CartonUploadValidationError(errors);
  return { headers: [...CARTON_UPLOAD_HEADERS], rows };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCartonUploadCsv(input) {
  const { headers, rows } = buildCartonUploadRows(input);
  return [headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n') + '\r\n';
}

// The manager site has a classic-script codebase. Exposing the same function
// there keeps the browser and Node automation paths on this single ruleset.
if (typeof window !== 'undefined') {
  window.buildCartonUploadRows = buildCartonUploadRows;
  window.CartonUploadValidationError = CartonUploadValidationError;
  window.fullSkuFromProductCode = fullSkuFromProductCode;
  window.buildSkuAndExpectedBySize = buildSkuAndExpectedBySize;
  window.serializeCartonUploadCsv = serializeCartonUploadCsv;
}
