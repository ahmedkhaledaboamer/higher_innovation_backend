import type { RequestHandler } from 'express';
import type { z } from 'zod';

interface RequestSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validates (and coerces) the request with Zod before the controller runs.
 *
 *   router.post('/', validate({ body: createLeadSchema }), controller.create)
 *
 * On failure Zod throws a ZodError, which the global error handler turns into a
 * 400 response listing every invalid field. On success the parsed values replace
 * the raw ones, so the controller sees trimmed strings, numbers instead of
 * numeric strings, defaults applied, and unknown fields stripped.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.params) {
      req.params = schemas.params.parse(req.params) as typeof req.params;
    }
    if (schemas.query) {
      // In Express 5 `req.query` is a read-only getter, so redefine it on this request.
      Object.defineProperty(req, 'query', {
        value: schemas.query.parse(req.query),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (schemas.body) {
      req.body = schemas.body.parse(req.body ?? {});
    }
    next();
  };
}
