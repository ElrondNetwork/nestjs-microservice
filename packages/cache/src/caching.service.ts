import { forwardRef, Inject, Injectable } from "@nestjs/common";
const { promisify } = require('util');
import { createClient } from 'redis';
import asyncPool from 'tiny-async-pool';
// CHANGE HERE
import '@multiversx/sdk-nestjs-common/src/utils/extensions/array.extensions';
import { PerformanceProfiler } from "@multiversx/sdk-nestjs-common";
import { LocalCacheService } from "./local.cache.service";
import { MetricsService } from "@multiversx/sdk-nestjs-common";
import { BatchUtils } from "@multiversx/sdk-nestjs-common";
import { CachingModuleOptions } from "./entities/caching.module.options";
import { OriginLogger } from "@multiversx/sdk-nestjs-common";

@Injectable()
export class CachingService {
  protected client = createClient(this.options.port, this.options.url, { auth_pass: this.options.password });
  private asyncSet = promisify(this.client.set).bind(this.client);
  private asyncGet = promisify(this.client.get).bind(this.client);
  private asyncIncr = promisify(this.client.incr).bind(this.client);
  private asyncExpire = promisify(this.client.expire).bind(this.client);
  private asyncFlushDb = promisify(this.client.flushdb).bind(this.client);
  private asyncMGet = promisify(this.client.mget).bind(this.client);
  private asyncZIncrBy = promisify(this.client.zincrby).bind(this.client);
  private asyncZRangeByScore = promisify(this.client.zrangebyscore).bind(this.client);
  private asyncSAdd = promisify(this.client.sadd).bind(this.client);
  private asyncSCard = promisify(this.client.scard).bind(this.client);
  private asyncMulti = (commands: any[]) => {
    const multi = this.client.multi(commands);
    return promisify(multi.exec).call(multi);
  };

  private asyncDel = promisify(this.client.del).bind(this.client);
  private asyncKeys = promisify(this.client.keys).bind(this.client);

  private readonly logger = new OriginLogger(CachingService.name);

  constructor(
    private readonly options: CachingModuleOptions,
    private readonly localCacheService: LocalCacheService,
    @Inject(forwardRef(() => MetricsService))
    private readonly metricsService: MetricsService,
  ) { }

  public async getKeys(key: string | undefined) {
    const profiler = new PerformanceProfiler();
    if (key) {
      try {
        return await this.asyncKeys(key);
      } finally {
        profiler.stop();
        this.metricsService.setRedisDuration('KEYS', profiler.duration);
      }
    }
  }

  public async incrementRemote(key: string): Promise<number> {
    return await this.asyncIncr(key);
  }

  public async setTtlRemote(key: string, ttl: number): Promise<void> {
    return await this.asyncExpire(key, ttl);
  }

  public async setCacheRemote<T>(key: string, value: T, ttl: number = this.getCacheTtl()): Promise<T> {
    if (value === undefined) {
      return value;
    }

    const profiler = new PerformanceProfiler();
    try {
      await this.asyncSet(key, JSON.stringify(value), 'EX', ttl ?? this.getCacheTtl());
    } finally {
      profiler.stop();
      this.metricsService.setRedisDuration('SET', profiler.duration);
    }

    return value;
  }

  pendingPromises: { [key: string]: Promise<any>; } = {};

  private async executeWithPendingPromise<T>(key: string, promise: () => Promise<T>): Promise<T> {
    let pendingGetRemote = this.pendingPromises[key];
    if (pendingGetRemote) {
      return await pendingGetRemote;
    } else {
      try {
        pendingGetRemote = promise();

        this.pendingPromises[key] = pendingGetRemote;

        return await pendingGetRemote;
      } finally {
        delete this.pendingPromises[key];
      }
    }
  }

  public async getCacheRemote<T>(key: string): Promise<T | undefined> {
    const profiler = new PerformanceProfiler();

    let response: string | undefined;
    try {
      response = await this.executeWithPendingPromise<string | undefined>(`caching:get:${key}`, async () => await this.asyncGet(key));
    } finally {
      profiler.stop();
      this.metricsService.setRedisDuration('GET', profiler.duration);
    }

    if (response === undefined) {
      return undefined;
    }

    return JSON.parse(response);
  }

  async setCacheLocal<T>(key: string, value: T, ttl: number = this.getCacheTtl()): Promise<T> {
    if (value === undefined) {
      return value;
    }

    return await this.localCacheService.setCacheValue<T>(key, value, ttl);
  }

  async getCacheLocal<T>(key: string): Promise<T | undefined> {
    return await this.localCacheService.getCacheValue<T>(key);
  }

  async refreshCacheLocal<T>(key: string, ttl: number = this.getCacheTtl()): Promise<T | undefined> {
    const value = await this.getCacheRemote<T>(key);
    if (value) {
      await this.setCacheLocal<T>(key, value, ttl);
    } else {
      this.logger.log(`Deleting local cache key '${key}'`);
      await this.deleteInCacheLocal(key);
    }

    return value;
  }

  public async getCache<T>(key: string): Promise<T | undefined> {
    const value = await this.getCacheLocal<T>(key);
    if (value) {
      return value;
    }

    return await this.getCacheRemote<T>(key);
  }

  public async setCache<T>(key: string, value: T, ttl: number = this.getCacheTtl()): Promise<T> {
    await this.setCacheLocal<T>(key, value, ttl);
    await this.setCacheRemote<T>(key, value, ttl);
    return value;
  }

  public async zIncrBy<T>(
    key: string,
    increment: number,
    member: string
  ): Promise<T | undefined> {
    return await this.asyncZIncrBy(key, increment, member);
  }

  public async zRangeByScore<T>(
    key: string,
    from: number | string,
    to: number | string,
  ): Promise<T> {
    return await this.asyncZRangeByScore(key, from, to);
  }

  async batchProcess<IN, OUT>(payload: IN[], cacheKeyFunction: (element: IN) => string, handler: (generator: IN) => Promise<OUT>, ttl: number = this.getCacheTtl(), skipCache: boolean = false): Promise<OUT[]> {
    const result: OUT[] = [];

    const chunks = BatchUtils.splitArrayIntoChunks(payload, 100);

    for (const [_, chunk] of chunks.entries()) {
      // this.logger.log(`Loading ${index + 1} / ${chunks.length} chunks`);

      let retries = 0;
      while (true) {
        try {
          const processedChunk = await this.batchProcessChunk(chunk, cacheKeyFunction, handler, ttl, skipCache);
          result.push(...processedChunk);
          break;
        } catch (error) {
          this.logger.error(error);
          this.logger.log(`Retries: ${retries}`);
          retries++;
          if (retries >= 3) {
            throw error;
          }
        }
      }
    }

    return result;
  }

  async batchProcessChunk<IN, OUT>(payload: IN[], cacheKeyFunction: (element: IN) => string, handler: (generator: IN) => Promise<OUT>, ttl: number = this.getCacheTtl(), skipCache: boolean = false): Promise<OUT[]> {
    const keys = payload.map(element => cacheKeyFunction(element));
    let cached: OUT[] = [];
    if (skipCache) {
      cached = new Array(keys.length).fill(null);
    } else {
      cached = await this.batchGetCacheRemote(keys);
    }

    const missing = cached
      .map((element, index) => (element === null ? index : false))
      .filter((element) => element !== false)
      .map(element => element as number);

    let values: OUT[] = [];

    if (missing.length) {
      values = await asyncPool(
        this.options.poolLimit,
        missing.map((index) => payload[index]),
        handler
      );

      const params = {
        keys: keys.filter((_, index) => missing.includes(index)),
        values,
        ttls: values.map((value) => (value ? ttl : Math.min(ttl, this.options.processTtl))),
      };

      await this.batchSetCache(params.keys, params.values, params.ttls);
    }

    return keys.map((_, index) =>
      missing.includes(index) ? values[missing.indexOf(index)] : cached[index]
    );
  }

  private spreadTtl(ttl: number): number {
    const threshold = 300; // seconds after which to start spreading ttls
    const spread = 10; // percent ttls spread

    if (ttl >= threshold) {
      const sign = Math.round(Math.random()) * 2 - 1;
      const amount = Math.floor(Math.random() * ((ttl * spread) / 100));

      ttl = ttl + sign * amount;
    }

    return ttl;
  }

  async batchSetCache(keys: string[], values: any[], ttls: number[], setLocalCache: boolean = true, spreadTtl: boolean = true) {
    if (!ttls) {
      ttls = new Array(keys.length).fill(this.getCacheTtl());
    }

    if (spreadTtl) {
      ttls = ttls.map(ttl => this.spreadTtl(ttl));
    }

    if (setLocalCache) {
      for (const [index, key] of keys.entries()) {
        const value = values[index];
        const ttl = ttls[index];

        await this.setCacheLocal(key, value, ttl);
      }
    }

    const chunks = BatchUtils.splitArrayIntoChunks(
      keys.map((key, index) => {
        const element: any = {};
        element[key] = index;
        return element;
      }),
      25,
    );

    const sets = [];

    for (const chunk of chunks) {
      const chunkKeys = chunk.map((element: any) => Object.keys(element)[0]);
      const chunkValues = chunk.map((element: any) => values[Object.values(element)[0] as number]);

      sets.push(
        ...chunkKeys.map((key: string, index: number) => {
          return ['set', key, JSON.stringify(chunkValues[index]), 'ex', ttls[index]];
        })
      );
    }

    const profiler = new PerformanceProfiler();
    try {
      await this.asyncMulti(sets);
    } finally {
      profiler.stop();
      this.metricsService.setRedisDuration('MSET', profiler.duration);
    }
  }

  async batchDelCache(keys: string[]) {
    for (const key of keys) {
      await this.deleteInCacheLocal(key);
    }

    const dels = keys.map(key => ['del', key]);

    const profiler = new PerformanceProfiler();
    try {
      await this.asyncMulti(dels);
    } finally {
      profiler.stop();
      this.metricsService.setRedisDuration('MDEL', profiler.duration);
    }
  }

  async setAdd(key: string, ...values: string[]): Promise<void> {
    const profiler = new PerformanceProfiler();

    try {
      await this.asyncSAdd(key, ...values);
    } finally {
      profiler.stop();
      this.metricsService.setRedisDuration('SADD', profiler.duration);
    }
  }

  async setCount(key: string): Promise<number> {
    const profiler = new PerformanceProfiler();

    try {
      return await this.asyncSCard(key);
    } finally {
      profiler.stop();
      this.metricsService.setRedisDuration('SCARD', profiler.duration);
    }
  }

  async batchGetCacheRemote<T>(keys: string[]): Promise<T[]> {
    const chunks = BatchUtils.splitArrayIntoChunks(keys, 100);

    const result = [];
    for (const chunkKeys of chunks) {
      let chunkValues: any;

      const profiler = new PerformanceProfiler();
      try {
        chunkValues = await this.asyncMGet(chunkKeys);
      } finally {
        profiler.stop();
        this.metricsService.setRedisDuration('MGET', profiler.duration);
      }

      chunkValues = chunkValues.map((value: any) => (value ? JSON.parse(value) : null));

      result.push(...chunkValues);
    }

    return result;
  }

  async batchApplyAll<TIN, TOUT>(
    elements: TIN[],
    cacheKeyFunc: (element: TIN) => string,
    getter: (element: TIN) => Promise<TOUT>,
    setter: (element: TIN, value: TOUT) => void,
    ttl: number,
    chunkSize: number = 100,
  ): Promise<void> {
    await this.batchApply(
      elements,
      cacheKeyFunc,
      elements => elements.toRecordAsync(element => cacheKeyFunc(element), element => getter(element)),
      setter,
      ttl,
      chunkSize,
    );
  }

  async batchApply<TIN, TOUT>(
    elements: TIN[],
    cacheKeyFunc: (element: TIN) => string,
    getter: (elements: TIN[]) => Promise<{ [key: string]: TOUT; }>,
    setter: (element: TIN, value: TOUT) => void,
    ttl: number,
    chunkSize: number = 100,
  ): Promise<void> {
    const batchGetResult = await this.batchGet(
      elements,
      cacheKeyFunc,
      getter,
      ttl,
      chunkSize,
    );

    const indexedElements: { [key: string]: TIN; } = {};
    for (const element of elements) {
      indexedElements[cacheKeyFunc(element)] = element;
    }

    for (const key of Object.keys(batchGetResult)) {
      const value = batchGetResult[key];
      if (value === undefined) {
        continue;
      }

      const element = indexedElements[key];
      if (element === undefined) {
        continue;
      }

      setter(element, value);
    }
  }

  async batchGetAll<TIN, TOUT>(
    elements: TIN[],
    cacheKeyFunc: (element: TIN) => string,
    getter: (element: TIN) => Promise<TOUT>,
    ttl: number,
    chunkSize: number = 100,
  ): Promise<{ [key: string]: TOUT; }> {
    return await this.batchGet(
      elements,
      cacheKeyFunc,
      elements => elements.toRecordAsync(element => cacheKeyFunc(element), element => getter(element)),
      ttl,
      chunkSize,
    );
  }

  async batchGet<TIN, TOUT>(
    elements: TIN[],
    cacheKeyFunc: (element: TIN) => string,
    getter: (elements: TIN[]) => Promise<{ [key: string]: TOUT; }>,
    ttl: number,
    chunkSize: number = 100,
  ): Promise<{ [key: string]: TOUT; }> {
    return await BatchUtils.batchGet<TIN, TOUT>(
      elements,
      cacheKeyFunc,
      [
        {
          getter: async elements => {
            const result: { [key: string]: TOUT; } = {};

            for (const element of elements) {
              const key = cacheKeyFunc(element);
              const value = await this.getCacheLocal<TOUT>(key);
              if (value !== undefined) {
                result[key] = value;
              }
            }

            return result;
          },
          setter: async elements => {
            for (const key of Object.keys(elements)) {
              await this.setCacheLocal(key, elements[key], ttl);
            }
          },
        },
        {
          getter: async elements => {
            const result: { [key: string]: TOUT; } = {};
            const keys = elements.map(element => cacheKeyFunc(element));

            const getResults = await this.batchGetCacheRemote<TOUT>(keys);

            for (const [index, element] of elements.entries()) {
              if (getResults[index] !== null) {
                result[cacheKeyFunc(element)] = getResults[index];
              }
            }

            return result;
          },
          setter: async elements => {
            const keys = Object.keys(elements);
            const values = Object.values(elements);
            const ttls = values.map(() => this.spreadTtl(ttl));

            await this.batchSetCache(keys, values, ttls);
          },
        },
        {
          getter,
        },
      ],
      chunkSize,
    );
  }

  async getOrSetCache<T>(key: string, promise: () => Promise<T>, remoteTtl: number = this.getCacheTtl(), localTtl: number | undefined = undefined, forceRefresh: boolean = false): Promise<T> {
    if (!localTtl) {
      localTtl = remoteTtl / 2;
    }

    const profiler = new PerformanceProfiler(`vmQuery:${key}`);

    if (!forceRefresh) {
      const cachedValue = await this.getCacheLocal<T>(key);
      if (cachedValue !== undefined) {
        profiler.stop(`Local Cache hit for key ${key}`);
        return cachedValue;
      }

      const cached = await this.getCacheRemote<T>(key);
      if (cached !== undefined && cached !== null) {
        profiler.stop(`Remote Cache hit for key ${key}`);

        // we only set ttl to half because we don't know what the real ttl of the item is and we want it to work good in most scenarios
        await this.setCacheLocal<T>(key, cached, localTtl);
        return cached;
      }
    }

    const value = await this.executeWithPendingPromise(`caching:set:${key}`, promise);
    profiler.stop(`Cache miss for key ${key}`);

    if (localTtl > 0) {
      await this.setCacheLocal<T>(key, value, localTtl);
    }

    if (remoteTtl > 0) {
      await this.setCacheRemote<T>(key, value, remoteTtl);
    }
    return value;
  }

  async deleteInCacheLocal(key: string) {
    await this.localCacheService.deleteCacheKey(key);
  }

  async deleteInCache(key: string): Promise<string[]> {
    const invalidatedKeys = [];

    if (key.includes('*')) {
      const allKeys = await this.getKeys(key);
      for (const key of allKeys) {
        this.localCacheService.deleteCacheKey(key);

        const profiler = new PerformanceProfiler();
        try {
          await this.asyncDel(key);
        } finally {
          profiler.stop();
          this.metricsService.setRedisDuration('DEL', profiler.duration);
        }

        invalidatedKeys.push(key);
      }
    } else {
      this.localCacheService.deleteCacheKey(key);

      const profiler = new PerformanceProfiler();
      try {
        await this.asyncDel(key);
      } finally {
        profiler.stop();
        this.metricsService.setRedisDuration('DEL', profiler.duration);
      }

      invalidatedKeys.push(key);
    }

    return invalidatedKeys;
  }

  async flushDb(): Promise<any> {
    await this.asyncFlushDb();
  }

  private getCacheTtl(): number {
    return 6;
  }
}
