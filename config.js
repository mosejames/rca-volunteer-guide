// config.js — No secrets. Committed to repo.
export const CONFIG = {
  SHEET_ID: '1Jz_WyOL3zsSAu35m62zyuIzIYsAwmxz9IDGxE9SClAg',
  WORKER_URL: 'https://rca-guide-worker.YOUR_SUBDOMAIN.workers.dev',
  POLL_INTERVAL: 45000,
  get CSV_BASE() {
    return `https://docs.google.com/spreadsheets/d/${this.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
  }
};
