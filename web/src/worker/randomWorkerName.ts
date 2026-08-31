// Keep existing UI imports stable while sharing the same catalog with the
// server-side scenario launcher.
export {
  type GenerateWorkerNameOptions,
  generateWorkerName,
  WORKER_NAME_POOL,
} from '../../../src/shared/random-worker-name.js'
