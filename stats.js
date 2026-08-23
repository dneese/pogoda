// Лічильники runtime-подій для /health та /metrics.
// У пам'яті процесу: після рестарту скидаються (це ок для спостережуваності).

const counters = {
  forecast_fetches: 0,
  forecast_cache_hits_db: 0,
  forecast_cache_hits_mem: 0,
  forecast_errors: 0,
  sudden_alerts_sent: 0,
  cards_created: 0,
  cards_updated: 0,
  telegram_send_errors: 0,
  cron_cycles: 0,
  cron_skipped_overlaps: 0,
  blocked_chats_cleaned: 0
};

const startedAt = Date.now();

function inc(name, n = 1) {
  if (!(name in counters)) return;
  counters[name] += n;
}

function snapshot() {
  return {
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    started_at: new Date(startedAt).toISOString(),
    ...counters
  };
}

module.exports = { inc, snapshot };
