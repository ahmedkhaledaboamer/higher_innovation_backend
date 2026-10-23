import type { RequestHandler } from 'express';
import { ApiError } from '../utils/ApiError.js';

/** Runs after every router: nothing matched, so answer with a 404 in the standard error shape. */
export const notFound: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND'));
};
