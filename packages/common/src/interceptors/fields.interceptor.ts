import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from 'rxjs/operators';

@Injectable()
export class FieldsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const contextType: string = context.getType();

    if (!["http", "https"].includes(contextType)) {
      return next.handle();
    }

    const request = context.getArgByIndex(0);

    return next
      .handle()
      .pipe(
        // eslint-disable-next-line require-await
        tap(async (resultRef) => {
          const result = JSON.parse(JSON.stringify(resultRef));
          const fieldsArgument = request.query.fields;
          if (fieldsArgument) {
            const fields = Array.isArray(fieldsArgument) ? fieldsArgument : fieldsArgument.split(',');
            if (Array.isArray(result)) {
              for (const item of result) {
                this.transformItem(item, fields);
              }
            }
            else {
              this.transformItem(result, fields);
            }
          }

          return result;
        })
      );
  }

  private transformItem(item: any, fields: string[]) {
    for (const key of Object.keys(item)) {
      if (!fields.includes(key)) {
        delete item[key];
      }
    }
  }
}
