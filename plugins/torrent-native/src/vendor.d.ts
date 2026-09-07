declare module "memory-chunk-store" {
  export default class MemoryChunkStore {
    constructor(chunkLength: number, opts?: { length?: number });
  }
}
