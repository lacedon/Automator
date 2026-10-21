import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../src/core/db/open';
import { systemClock } from '../../src/core/domain/types';
import { DataDir } from '../../src/core/files/dataDir';
import { QueueService } from '../../src/core/queue/queueService';

const { file, root, barrier } = workerData as { file: string; root: string; barrier: SharedArrayBuffer };
const db = openDb(file);
const queue = new QueueService(db, systemClock, new DataDir(root));

const gate = new Int32Array(barrier);
Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1, 50);

const run = queue.claimNext();
db.close();
parentPort?.postMessage(run ? run.id : null);
