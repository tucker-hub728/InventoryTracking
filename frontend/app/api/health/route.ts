/**
 * GET /api/health — load balancer target health check.
 *
 * 200 → this instance can serve traffic.
 *
 * DELIBERATELY SHALLOW. It reports whether *this* Next.js process is up and
 * answering, and checks nothing downstream — not the backend, not the database.
 *
 * That is the point. A load balancer health check decides whether an instance
 * is removed from rotation, so a check that depends on a shared resource turns
 * a partial failure into a total outage: one slow database makes every instance
 * fail its check at the same moment, the ALB drains all of them, and a
 * degradation becomes a hard outage. A shallow check keeps the instances
 * serving whatever they still can.
 *
 * The backend is not left unchecked, it is checked in the right place:
 * docker-compose gates the frontend on `backend: condition: service_healthy`,
 * and the backend has its own `/v1/health` healthcheck. So the frontend cannot
 * even start until the backend behind it is healthy — which is a startup
 * ordering guarantee, not a runtime one, and that is the correct split.
 *
 * `force-dynamic` matters: without it Next would statically prerender this at
 * build time and the ALB would be health-checking a cached file rather than a
 * live process, which stays 200 long after the process stops working.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
