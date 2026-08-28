import { buildSkuAndExpectedBySize, serializeCartonUploadCsv } from '../../../web/carton-upload-rows.mjs';

export function parseBuyerCsv(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const parseLine = (line) => {
    const values = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character === '"' && quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === ',' && !quoted) {
        values.push(current);
        current = '';
      } else {
        current += character;
      }
    }
    values.push(current);
    return values.map((value) => value.trim());
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseLine(line)[index] ?? ''])));
}

export function cartonsFromGroups(groups) {
  return (groups ?? []).flatMap((group) => (group.cartons ?? []).map((carton) => ({
    size: carton.size,
    colour: group.colour,
    quantity: carton.qty,
    cartonType: carton.carton_type ?? carton.cartonType ?? (carton.small ? 'BDCM3' : 'BDCM1'),
  })));
}

export function buildPortalCsvFromBuyerReference({ csvText, po, groups }) {
  const buyerRows = parseBuyerCsv(csvText);
  const skuAndExpectedBySize = buildSkuAndExpectedBySize(buyerRows, po);
  return serializeCartonUploadCsv({ cartons: cartonsFromGroups(groups), skuAndExpectedBySize });
}
