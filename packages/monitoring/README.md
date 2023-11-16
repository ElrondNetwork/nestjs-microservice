<a href="https://www.npmjs.com/package/@multiversx/sdk-nestjs-monitoring" target="_blank"><img src="https://img.shields.io/npm/v/@multiversx/sdk-nestjs-monitoring.svg" alt="NPM Version" /></a>

# MultiversX NestJS Microservice Monitoring Utilities

This package contains a set of utilities commonly used for monitoring purposes in the MultiversX Microservice ecosystem. 
The package relies on prometheus to aggregate the metrics and it is using [prom-client](https://www.npmjs.com/package/prom-client) as a client for it.

## CHANGELOG

[CHANGELOG](CHANGELOG.md)

## Installation

`sdk-nestjs-monitoring` is delivered via **npm** and it can be installed as follows:

```
npm install @multiversx/sdk-nestjs-monitoring
```

## Utility
The package exports **performance profilers**, **interceptors** and **metrics**.

### Performance profiler
`PerformanceProfiler` is a class exported by the package which allows you to measure the execution time of parts of your code.

```typescript
import { PerformanceProfiler } from "@multiversx/monitoring";

const profiler = new PerformanceProfiler();
await doSomething();
const profilerDurationInMs = profiler.stop();

console.log(`doSomething() method exection time lasted ${profilerDurationInMs} ms`)
```

The `.stop()` method can receive two optional parameters:
- `description` - text used for default loggin. Default: `undefined`
- `log` - boolean to determine if log should be printed. If `log` is set to true, the logging class used will be `Logger` from `"@nestjs/common"`.` `Default: `false`


```typescript
import { PerformanceProfiler } from "@multiversx/monitoring";

const profiler = new PerformanceProfiler();
await doSomething();
profiler.stop(`doSomething() execution time`, true);
```
The output of the code above will be "`doSomething() execution time: 10ms`"

---

### Cpu Profiler
`CpuProfiler` is a class exported by the package which allows you to measure the CPU execution time of parts of your code. Javascript being single threaded you must be careful how much CPU you spend on some operations, but finding the pars of the code which consume CPU can be difficult without profilers. It has aslo a `PerformanceProfiler` built in.


```typescript
import { CpuProfiler } from "@multiversx/monitoring";

const profiler = new CpuProfiler();
await doHttpRequest()
const profilerDurationInMs = profiler.stop();

console.log(`doHttpRequest() method exection time lasted ${profilerDurationInMs} ms`)
```

The `.stop()` method can receive two optional parameters:
- `description` - text used for default loggin. When setting the description it will automatically print also the value of `PerformanceProfiler`. Default: `undefined`

```typescript
import { CpuProfiler } from "@multiversx/monitoring";

const httpReqCpuProfiler = new CpuProfiler();
await doHttpRequest();
httpReqCpuProfiler.stop(`doHttpRequest() execution time`);

const cpuProfiler = new CpuProfiler();
await doSomethingCpuIntensive();
cpuProfiler.stop(`doSomethingCpuIntensive() execution time`);
```
The output of the code above will be <br/>

`doHttpRequest() execution time: 100ms, CPU time: 1ms`
`doSomethingCpuIntensive() execution time: 20ms, CPU time 18ms`

*Note that a big execution time does not necessarly have impact on the CPU load of the application, that means that while waiting for an HTTP request for example, the Javascript thread can process things. That is not the case for CPU time. When a method consumes a lot of CPU time, Javascript will not be able to process other things meanwhile and it can freeze until the CPU consuming task is done.*

---

## Interceptors
The package provides a series of [Nestjs Interceptors](https://docs.nestjs.com/interceptors) which will automatically log and set the CPU duration and overall duration for each request in a prom histogram ready to be scrapped by Prometheus.

`LoggingInterceptor` interceptor is responsable for setting in a prometheus histogram the request execution time of each request. See [Performance Profiler](#performance-profiler).

`RequestCpuTimeInterceptor` interceptor is responsable for setting in a prometheus histogram the request CPU execution time of each request. See [Cpu Profiler](#cpu-profiler).

*Both interceptors expect as an argument an instance of `metricsService` class.*

```typescript
import { MetricsService, RequestCpuTimeInterceptor, LoggingInterceptor } from '@multiversx/sdk-nestjs-monitoring';

async function bootstrap() {
  // AppModule imports MetricsModule
  const publicApp = await NestFactory.create(AppModule);
  const metricsService = publicApp.get<MetricsService>(MetricsService);

  const globalInterceptors = [];
  globalInterceptors.push(new RequestCpuTimeInterceptor(metricsService));
  globalInterceptors.push(new LoggingInterceptor(metricsService));

  publicApp.useGlobalInterceptors(...globalInterceptors);
}
```

## MetricsModule and MetricsService

`MetricsModule` is a [Nestjs Module](https://docs.nestjs.com/modules) responsible for aggregating metrics data through `MetricsService` and exposing them for Prometheus. `MetricsService` is extensible, you can define and aggregate your own metrics and expose them. By default it exposes a set of metrics created by the interceptors defined [here](#interceptors). Most of the Multiversx packages expose metrics by default through this service like [@multiversx/sdk-nestjs-redis](https://www.npmjs.com/package/@multiversx/sdk-nestjs-redis) which automatically tracks the execution time of each redis query, overall redis health and much more, and expose them for Prometheus.

### How to instantiate the MetricsModule and expose metrics endpoints for Prometheus

In our example we will showcase request response time and response CPU time. Make sure you have the interceptors in place as shown [here](#interceptors). After the interceptors are in place, as requests comes through, the metrics are being populated and we just have to expose the output of the `.getMetrics()` method on `MetricsService` through a controller.

```typescript
import { Controller, Get } from '@nestjs/common';
import { MetricsService } from '@multiversx/sdk-nestjs-monitoring';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService
  ){}

  @Get()
  getMetrics(): string {
    return this.metricsService.getMetrics();
  }
}
```

### How to add custom metrics

Adding custom metrics is just a matter of creating another class which uses `MetricsService`.

We can create a new class called `ApiMetricsService` which will have a new custom metric `heartbeatsHistogram`.

```typescript
import { Injectable } from '@nestjs/common';
import { MetricsService } from '@multiversx/sdk-nestjs-monitoring';
import { register, Histogram } from 'prom-client';

@Injectable()
export class ApiMetricsService {
  private static heartbeatsHistogram: Histogram<string>;

  constructor(private readonly metricsService: MetricsService) {
    if (!ApiMetricsService.heartbeatsHistogram) {
      ApiMetricsService.heartbeatsHistogram = new Histogram({
        name: 'heartbeats',
        help: 'Heartbeats',
        labelNames: ['app'],
        buckets: [],
      });
    }
  }

  async getMetrics(): Promise<string> {
    const baseMetrics = await this.metricsService.getMetrics();
    const currentMetrics = await register.metrics();

    return baseMetrics + '\n' + currentMetrics;
  }

  setHearthbeatDuration(app: string, duration: number) {
    ApiMetricsService.heartbeatsHistogram.labels(app).observe(duration);
  }
}
```

The only change we have to do is that we need to instantiate this class and call `.getMetrics()` method on it to return to us both default and our new custom metric.

The `.setHearthbeatDuration()` method will be used in our business logic whenever we want to add a new value to that histogram.

