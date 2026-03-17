// config.js — No secrets. Committed to repo.
export const CONFIG = {
  SHEET_ID: 'YOUR_SHEET_ID_HERE',
  WORKER_URL: 'https://rca-guide-worker.YOUR_SUBDOMAIN.workers.dev',
  POLL_INTERVAL: 45000,
  get CSV_BASE() {
    return `https://docs.google.com/spreadsheets/d/${this.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
  }
};
