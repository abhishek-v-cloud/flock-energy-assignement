import { Router } from 'express';
import { parseConsumptionQuery, parseHierarchyQuery, parseMeterListQuery } from './validation.js';

/** Express 5 forwards rejected promises to the error handler, so handlers stay plain async functions. */
export function apiRoutes(service) {
  const r = Router();

  r.get('/meters', async (req, res) => {
    const { filters, paging } = parseMeterListQuery(req.query);
    res.json(await service.listMeters(filters, paging));
  });

  r.get('/meters/:meterId', async (req, res) => {
    res.json(await service.getMeter(req.params.meterId));
  });

  r.get('/meters/:meterId/consumption', async (req, res) => {
    const opts = parseConsumptionQuery(req.query);
    res.json(await service.getConsumption(req.params.meterId, opts));
  });

  r.get('/hierarchy', async (req, res) => {
    res.json(await service.getHierarchy(parseHierarchyQuery(req.query)));
  });

  return r;
}
