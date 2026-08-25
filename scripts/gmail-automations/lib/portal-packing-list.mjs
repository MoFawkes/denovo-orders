import ExcelJS from 'exceljs';

const LABELS = {
  invoiceId: 'INVOICE SERIAL NUMBER :',
  dispatchDate: 'INVOICE DATE :',
};

function ukDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? '').trim());
  if (!match) throw new Error('dispatchDate must be YYYY-MM-DD');
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function findValueCell(worksheet, label) {
  for (let row = 1; row <= worksheet.rowCount; row += 1) {
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const cell = worksheet.getCell(row, column);
      if (cell.master.address !== cell.address) continue;
      if (String(cell.value ?? '').trim().toUpperCase() !== label) continue;
      const labelMaster = cell.address;
      let nextColumn = column + 1;
      while (nextColumn <= worksheet.columnCount && worksheet.getCell(row, nextColumn).master.address === labelMaster) {
        nextColumn += 1;
      }
      if (nextColumn > worksheet.columnCount) throw new Error(`no value cell follows ${label}`);
      return worksheet.getCell(row, nextColumn).master;
    }
  }
  throw new Error(`Portal packing list is missing ${label}`);
}

export async function stampPortalPackingList(workbookBytes, { invoiceId, dispatchDate }) {
  if (!String(invoiceId ?? '').trim()) throw new Error('invoiceId is required');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBytes);
  const worksheet = workbook.worksheets.find((sheet) => {
    try {
      findValueCell(sheet, LABELS.invoiceId);
      findValueCell(sheet, LABELS.dispatchDate);
      return true;
    } catch {
      return false;
    }
  });
  if (!worksheet) throw new Error('Portal packing list has no Invoice Details fields');
  findValueCell(worksheet, LABELS.invoiceId).value = String(invoiceId).trim();
  findValueCell(worksheet, LABELS.dispatchDate).value = ukDate(dispatchDate);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
