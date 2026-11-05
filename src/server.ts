import { createApp } from './app';
import { RedisOfferStore } from './cache';
import { config } from './config';
import { LocalOrchestrator, SingleFlightOrchestrator, TemporalOrchestrator, type Orchestrator } from './orchestrator';

async function main() {
  const store = RedisOfferStore.connect();
  const inner: Orchestrator =
    config.orchestrator === 'temporal' ? await TemporalOrchestrator.connect() : new LocalOrchestrator(store);
  const orchestrator = new SingleFlightOrchestrator(inner);

  const server = createApp({ store, orchestrator }).listen(config.port, () =>
    console.log(`[api] listening on :${config.port} (orchestrator=${config.orchestrator})`),
  );

  const shutdown = () => {
    server.close(async () => {
      await Promise.allSettled([orchestrator.close(), store.close()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[api] fatal', err);
  process.exit(1);
});
