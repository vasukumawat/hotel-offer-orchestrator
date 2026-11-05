import { NativeConnection, Worker } from '@temporalio/worker';
import { config } from '../config';
import * as activities from './activities';

async function main() {
  const connection = await NativeConnection.connect({ address: config.temporal.address });
  const worker = await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  console.log(`[worker] polling task queue "${config.temporal.taskQueue}" on ${config.temporal.address}`);
  await worker.run(); // resolves on SIGINT/SIGTERM
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
