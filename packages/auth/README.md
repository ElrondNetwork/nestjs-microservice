<a href="https://www.npmjs.com/package/@multiversx/sdk-nestjs-auth" target="_blank"><img src="https://img.shields.io/npm/v/@multiversx/sdk-nestjs-auth.svg" alt="NPM Version" /></a>

# MultiversX NestJS Microservice Native Authentication Utilities

This package contains a set of utilities commonly used for authentication purposes in the MultiversX Microservice ecosystem.  
The package relies on [@multiversx/sdk-native-auth-server](https://www.npmjs.com/package/@multiversx/sdk-native-auth-server) for validating access tokens signed by MultiversX wallets.

## Installation

`sdk-nestjs-auth` is delivered via **npm** and it can be installed as follows:

```
npm install @multiversx/sdk-nestjs-auth
```

## Utility

The package provides a series of [NestJS Guards](https://docs.nestjs.com/guards) that can be used for easy authorization on endpoints in your application.  
It also provides some [NestJS Decorators](https://docs.nestjs.com/custom-decorators) that expose the decoded information found in the access token.

## Configuration

// TODO

## Using the Auth Guards

NestJS guards can be controller-scoped, method-scoped, or global-scoped. Setting up a guard from the package is done through the `@UseGuards` decorator from the `@nestjs/common` package.

### Native Auth Guard

`NativeAuthGuard` performs validation of the block hash, verifies its validity, as well as origin verification on the access token.

```typescript
import { NativeAuthGuard } from "@multiversx/sdk-nestjs-auth";

@Controller('projects')
@UseGuards(NativeAuthGuard)
export class ProjectsController {
  // your methods...
}
```
In the example above the `NativeAuthGuard` is controller-scoped. This means that all of the methods from `ProjectsController` will be protected by the guard.


```typescript
import { NativeAuthGuard } from "@multiversx/sdk-nestjs-auth";

@Controller('projects')
export class ProjectsController {
  @Get()
  async getAll() {
    return this.projectsService.getAll();
  }

  @Post()
  @UseGuards(NativeAuthGuard)
  async createProject(@Body() createProjectDto: CreateProjectDto) {
    return this.projectsService.create(createProjectDto);
  }
}
```

In this case, the guard is method-scoped. Only `createProject` benefits from the native auth checks.

### Native Auth Admin Guard

`NativeAuthAdminGuard` allows only specific addresses to be authenticated. The addresses are defined in the [config](#configuration) file and are passed to the guard via the ErdnestConfigService.

*This guard cannot be used by itself. It always has to be paired with a `NativeAuthGuard`*

```typescript
import { NativeAuthGuard, NativeAuthAdminGuard } from "@multiversx/sdk-nestjs-auth";

@Controller('admin')
@UseGuards(NativeAuthGuard, NativeAuthAdminGuard)
export class AdminController {
  // your methods...
}
```

### JWT Authenticate Guard

`JwtAuthenticateGuard` performs validation of a traditional [JSON web token](https://datatracker.ietf.org/doc/html/rfc7519). The usage is exactly the same as for the native auth guards.

```typescript
import { JwtAuthenticateGuard } from "@multiversx/sdk-nestjs-auth";

@Controller('users')
@UseGuards(JwtAuthenticateGuard)
export class UsersController {
  // your methods...
}
```

### JWT Admin Guard

`JwtAdminGuard` relies on the same mechanism, only specific addresses can be authenticated. The addresses are defined in the [config](#configuration) file and are passed to the guard via the ErdnestConfigService.

*There is one caveat: when creating the JWT, the client must include an `address` field in the payload, before signing it.*

```typescript
import { JwtAuthenticateGuard, JwtAdminGuard } from "@multiversx/sdk-nestjs-auth";

@Controller('admin')
@UseGuards(JwtAuthenticateGuard, JwtAdminGuard)
export class AdminController {
  // your methods...
}
```

### Jwt Or Native Auth Guard

`JwtOrNativeAuthGuard` guard will authorize requests containing either JWT or a native auth access token. The package will first look for a valid JWT. If that fails, it will look for a valid native auth access token.

## Using the Auth Decorators

The package exposes 3 decorators : `NativeAuth`, `Jwt` and `NoAuth`

### NativeAuth Decorator

The `NativeAuth` decorator accepts a single parameter. In can be one of the following values :  
- `issued` - block timestamp  
- `expires` - expiration time  
- `address` - address that signed the access token  
- `origin` - URL of the page that generated the token  
- `extraInfo` - optional arbitrary data  


Below is an example showing how to use the decorator to extract the signers address :

```typescript
import { NativeAuthGuard, NativeAuth } from "@multiversx/sdk-nestjs-auth";
import { Controller, Get, UseGuards } from "@nestjs/common";

@Controller()
export class AuthController {
  @Get("/auth")
  @UseGuards(NativeAuthGuard)
  authorize(@NativeAuth('address') address: string): string {
    console.log(`Access granted for address ${address}`);
    return address;
  }
}
```

### Jwt Decorator

The `Jwt` decorator works just like `NativeAuth`. The fields accessible inside it are dependent on the client that created the token, and are out of scope for this documentation.

### No Auth Decorator

The `NoAuth` decorator is used in applications where the Auth guards have been enabled globally. It allows you to exclude certain methods from the verification process.

```typescript
import { NoAuth } from "@multiversx/sdk-nestjs-auth";
import { Controller, Get, UseGuards } from "@nestjs/common";

@Controller()
export class PublicController {
  @NoAuth()
  @Get("/public-posts")
  listPosts() {
    // ....
  }
}
```