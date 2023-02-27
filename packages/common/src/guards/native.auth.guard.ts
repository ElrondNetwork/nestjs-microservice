import { Injectable, CanActivate, ExecutionContext, Optional, Inject } from '@nestjs/common';
import { ElrondCachingService } from '../common/caching/elrond-caching/elrond-caching.service';
import { NativeAuthError, NativeAuthServer } from '@multiversx/sdk-native-auth-server';
import { NoAuthOptions } from '../decorators';
import { DecoratorUtils } from '../utils/decorator.utils';
import { PerformanceProfiler } from '../utils/performance.profiler';
import { CachingService } from '../common/caching/caching.service';
import { ErdnestConfigService } from '../common/config/erdnest.config.service';
import { ERDNEST_CONFIG_SERVICE } from '../utils/erdnest.constants';
import { NativeAuthInvalidOriginError } from './errors/native.auth.invalid.origin.error';

/**
 * This Guard protects all routes that do not have the `@NoAuth` decorator and sets the `X-Native-Auth-*` HTTP headers.
 *
 * @return {boolean} `canActivate` returns true if the Authorization header is a valid Native-Auth token.
 */
@Injectable()
export class NativeAuthGuard implements CanActivate {
  private readonly authServer: NativeAuthServer;

  constructor(
    @Inject(ERDNEST_CONFIG_SERVICE) erdnestConfigService: ErdnestConfigService,
    @Optional() cachingService?: CachingService,
    @Optional() elrondCachingService?: ElrondCachingService,
  ) {
    this.authServer = new NativeAuthServer({
      apiUrl: erdnestConfigService.getApiUrl(),
      maxExpirySeconds: erdnestConfigService.getNativeAuthMaxExpirySeconds(),
      acceptedOrigins: erdnestConfigService.getNativeAuthAcceptedOrigins(),
      cache: {
        getValue: async function <T>(key: string): Promise<T | undefined> {
          if (key === 'block:timestamp:latest') {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            return new Date().getTime() / 1000;
          }

          if (elrondCachingService) {
            return await elrondCachingService.get<T>(key);
          }

          if (cachingService) {
            return await cachingService.getCache<T>(key);
          }

          throw new Error('CachingService or ElrondCachingService is not available in the context');
        },
        setValue: async function <T>(key: string, value: T, ttl: number): Promise<void> {
          if (elrondCachingService) {
            return await elrondCachingService.set<T>(key, value, ttl);
          }

          if (cachingService) {
            await cachingService.setCache<T>(key, value, ttl);
            return;
          }

          throw new Error('CachingService or ElrondCachingService is not available in the context');
        },
      },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const noAuthMetadata = DecoratorUtils.getMethodDecorator(NoAuthOptions, context.getHandler());
    if (noAuthMetadata) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    const origin = request.headers['origin'];

    const requestUrl = new URL(origin);
    const isLocalhostOrigin = requestUrl.hostname === 'localhost' && requestUrl.protocol === 'https:';

    const authorization: string = request.headers['authorization'];
    if (!authorization) {
      return false;
    }

    const jwt = authorization.replace('Bearer ', '');
    const profiler = new PerformanceProfiler();

    try {
      const userInfo = await this.authServer.validate(jwt);
      profiler.stop();

      if (!isLocalhostOrigin && origin !== userInfo.origin && origin !== 'https://' + userInfo.origin) {
        throw new NativeAuthInvalidOriginError(userInfo.origin, origin);
      }

      request.res.set('X-Native-Auth-Issued', userInfo.issued);
      request.res.set('X-Native-Auth-Expires', userInfo.expires);
      request.res.set('X-Native-Auth-Address', userInfo.address);
      request.res.set('X-Native-Auth-Timestamp', Math.round(new Date().getTime() / 1000));
      request.res.set('X-Native-Auth-Duration', profiler.duration);

      request.nativeAuth = userInfo;
      request.jwt = userInfo;
      return true;
    } catch (error) {
      if (error instanceof NativeAuthError) {
        // @ts-ignore
        const message = error?.message;
        if (message) {
          profiler.stop();
          request.res.set('X-Native-Auth-Error-Type', error.constructor.name);
          request.res.set('X-Native-Auth-Error-Message', message);
          request.res.set('X-Native-Auth-Duration', profiler.duration);
        }
      }

      return false;
    }
  }
}
