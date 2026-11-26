import http from 'node:http';
import { config } from './config.js';
import { connectRedis, redisReady } from './redis.js';
import {
  listCities,
  listMoviesByCity,
  listShows,
  listShowsForMovie,
  getMovie,
  getShowSeats,
  getBooking,
  listBookingsForUser,
} from './catalog.js';
import {
  holdSeats,
  confirmBooking,
  cancelHold,
  ConflictError,
  NotFoundError,
} from './inventory.js';
import { createRedisRateLimiter, RateLimitError } from './rateLimitRedis.js';
import { startExpireHoldsWorker } from './jobs/expireHoldsWorker.js';
import { startJobWorker } from './jobs/worker.js';
import { getJob } from './jobs/queue.js';
import { requireUser, AuthError } from './auth.js';
import { smtpConfigured } from './mail.js';

const holdLimiter = createRedisRateLimiter(config.rateLimit.hold);
const bookLimiter = createRedisRateLimiter(config.rateLimit.book);

function corsHeaders() {
  return {
    'access-control-allow-origin': config.corsOrigin,
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...corsHeaders(),
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function maybeRateLimit(limiter, key) {
  if (!config.rateLimit.enabled) return;
  await limiter.check(key);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, {
      ok: true,
      redis: redisReady(),
      rateLimit: config.rateLimit.enabled,
      authDisabled: config.authDisabled,
      clerkConfigured: Boolean(config.clerk.secretKey),
      smtpConfigured: smtpConfigured(),
    });
  }

  if (req.method === 'GET' && pathname === '/cities') {
    return send(res, 200, await listCities());
  }

  const cityMovies = pathname.match(/^\/cities\/(\d+)\/movies$/);
  if (req.method === 'GET' && cityMovies) {
    return send(res, 200, await listMoviesByCity(Number(cityMovies[1])));
  }

  const movieDetail = pathname.match(/^\/movies\/(\d+)$/);
  if (req.method === 'GET' && movieDetail) {
    return send(res, 200, await getMovie(Number(movieDetail[1])));
  }

  const movieShows = pathname.match(/^\/movies\/(\d+)\/shows$/);
  if (req.method === 'GET' && movieShows) {
    const cityId = url.searchParams.get('cityId');
    return send(
      res,
      200,
      await listShowsForMovie(Number(movieShows[1]), {
        cityId: cityId != null ? Number(cityId) : null,
      }),
    );
  }

  if (req.method === 'GET' && pathname === '/shows') {
    const cityId = url.searchParams.get('cityId');
    const movieId = url.searchParams.get('movieId');
    return send(
      res,
      200,
      await listShows({
        cityId: cityId != null ? Number(cityId) : null,
        movieId: movieId != null ? Number(movieId) : null,
      }),
    );
  }

  const seatsMatch = pathname.match(/^\/shows\/(\d+)\/seats$/);
  if (req.method === 'GET' && seatsMatch) {
    const data = await getShowSeats(Number(seatsMatch[1]));
    return send(res, 200, data);
  }

  if (req.method === 'GET' && pathname === '/me') {
    const user = await requireUser(req, {
      optionalUserId: url.searchParams.get('userId'),
    });
    return send(res, 200, { user });
  }

  if (req.method === 'GET' && pathname === '/me/bookings') {
    const user = await requireUser(req, {
      optionalUserId: url.searchParams.get('userId'),
    });
    return send(res, 200, await listBookingsForUser(user.id));
  }

  if (req.method === 'POST' && pathname === '/holds') {
    const body = await readJson(req);
    const user = await requireUser(req, { optionalUserId: body.userId });
    await maybeRateLimit(holdLimiter, `hold:user:${user.id}`);
    await maybeRateLimit(holdLimiter, `hold:ip:${clientIp(req)}`);
    const result = await holdSeats({
      showId: Number(body.showId),
      userId: Number(user.id),
      seatIds: body.seatIds,
    });
    return send(res, 201, result);
  }

  const cancelMatch = pathname.match(/^\/holds\/(\d+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const body = await readJson(req);
    const user = await requireUser(req, { optionalUserId: body.userId });
    const result = await cancelHold({
      holdId: Number(cancelMatch[1]),
      userId: Number(user.id),
    });
    return send(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/bookings') {
    const body = await readJson(req);
    const user = await requireUser(req, { optionalUserId: body.userId });
    await maybeRateLimit(bookLimiter, `book:user:${user.id}`);
    await maybeRateLimit(bookLimiter, `book:ip:${clientIp(req)}`);
    const result = await confirmBooking({
      holdId: Number(body.holdId),
      userId: Number(user.id),
    });
    // 200 = same booking returned again; 201 = newly created
    return send(res, result.idempotentReplay ? 200 : 201, result);
  }

  const bookingMatch = pathname.match(/^\/bookings\/(\d+)$/);
  if (req.method === 'GET' && bookingMatch) {
    const user = await requireUser(req, {
      optionalUserId: url.searchParams.get('userId'),
    });
    return send(res, 200, await getBooking(Number(bookingMatch[1]), { userId: user.id }));
  }

  const jobMatch = pathname.match(/^\/jobs\/(\d+)$/);
  if (req.method === 'GET' && jobMatch) {
    if (!config.authDisabled) {
      await requireUser(req);
    }
    const job = await getJob(Number(jobMatch[1]));
    if (!job) throw new NotFoundError('job not found');
    return send(res, 200, { job });
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof AuthError) {
      return send(res, err.statusCode || 401, { error: err.message });
    }
    if (err instanceof RateLimitError) {
      const retryAfterSec = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
      return send(
        res,
        429,
        {
          error: err.message,
          key: err.key,
          retryAfterMs: err.retryAfterMs,
        },
        { 'retry-after': String(retryAfterSec) },
      );
    }
    if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
    if (err instanceof ConflictError) {
      return send(res, 409, { error: err.message, ...err.details });
    }
    if (err.statusCode === 400) return send(res, 400, { error: err.message });
    console.error(err);
    return send(res, 500, { error: 'internal error', message: err.message });
  });
});

await connectRedis();

server.listen(config.port, () => {
  console.log(`bms_main listening on http://localhost:${config.port}`);
  console.log(
    config.authDisabled
      ? 'auth: DISABLED (dev) — pass userId in body/query'
      : config.clerk.secretKey
        ? 'auth: Clerk Bearer JWT required on hold/book/me'
        : 'auth: Clerk NOT configured — set CLERK_SECRET_KEY (or AUTH_DISABLED=1 for local benches)',
  );
  console.log(`smtp: ${smtpConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(
    config.rateLimit.enabled
      ? `rate limit: token bucket via ${redisReady() ? 'Redis' : 'memory-fallback'}`
      : 'rate limit: DISABLED',
  );
  startExpireHoldsWorker();
  startJobWorker();
});
