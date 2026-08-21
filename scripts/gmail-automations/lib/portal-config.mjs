import { readFile } from 'node:fs/promises';

const REQUIRED_URLS = ['purchaseOrders', 'cartonWizard'];
const REQUIRED_SELECTORS = ['username', 'password', 'totp', 'sku', 'size', 'cartonQuantity', 'cartonSize', 'poNumberFilter'];
const REQUIRED_TIMEOUTS = ['navigationMs', 'actionMs', 'downloadMs'];

export function validatePortalConfig(config) {
  if (!config || config.schemaVersion !== 1) throw new Error('portal config schemaVersion must be 1');
  for (const key of REQUIRED_URLS) if (!String(config.urls?.[key] ?? '').startsWith('https://')) throw new Error(`config.urls.${key} must be https`);
  if (!config.urls.cartonWizard.includes('{po}')) throw new Error('config.urls.cartonWizard must include {po}');
  for (const key of REQUIRED_SELECTORS) if (!String(config.selectors?.[key] ?? '').trim()) throw new Error(`config.selectors.${key} is required`);
  for (const key of REQUIRED_TIMEOUTS) if (!Number.isInteger(config.timeouts?.[key]) || config.timeouts[key] < 1000) throw new Error(`config.timeouts.${key} must be at least 1000ms`);
  return config;
}

export async function loadPortalConfig(url = new URL('../portal-config.json', import.meta.url)) {
  return validatePortalConfig(JSON.parse(await readFile(url, 'utf8')));
}
