import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function validateBelPdf(path, { po, expectedCartonCount }) {
  const bytes = await readFile(path);
  if (bytes.length < 1000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('BEL output is not a non-empty PDF');
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
  if (document.numPages !== expectedCartonCount) {
    throw new Error(`BEL page count ${document.numPages} does not match ${expectedCartonCount} cartons`);
  }
  const expectedPo = String(po).replace(/^0+/, '');
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const shortEdge = Math.min(viewport.width, viewport.height);
    const longEdge = Math.max(viewport.width, viewport.height);
    if (Math.abs(shortEdge - 288) > 3 || Math.abs(longEdge - 432) > 3) {
      throw new Error(`BEL page ${pageNumber} is not 4x6 inches`);
    }
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(' ');
    if (!pageText.includes(po) && !pageText.includes(expectedPo)) throw new Error(`BEL page ${pageNumber} does not contain PO ${po}`);
    if (!new RegExp(`Carton\\s+No:?\\s*${pageNumber}\\s+of\\s+${expectedCartonCount}`, 'i').test(pageText)) {
      throw new Error(`BEL page ${pageNumber} has no matching carton sequence`);
    }
  }
  return { bytes: bytes.length, pages: document.numPages };
}
