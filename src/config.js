import 'dotenv/config';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:neel@localhost:5432/bms',
  port: Number(process.env.PORT ?? 3200),
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 300),
  maxSeatsPerHold: Number(process.env.MAX_SEATS_PER_HOLD ?? 6),
  expireHoldsIntervalMs: Number(process.env.EXPIRE_HOLDS_INTERVAL_MS ?? 30_000),
  jobWorkerIntervalMs: Number(process.env.JOB_WORKER_INTERVAL_MS ?? 1000),
  jobWorkerBatchSize: Number(process.env.JOB_WORKER_BATCH_SIZE ?? 10),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  /** Dev-only: allow userId in body without Clerk. Never set in production. */
  authDisabled: process.env.AUTH_DISABLED === '1',
  clerk: {
    secretKey: process.env.CLERK_SECRET_KEY ?? '',
    publishableKey:
      process.env.CLERK_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
      '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: (process.env.SMTP_PASS ?? '').replace(/\s+/g, ''),
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER ?? 'BMS Bookings <noreply@localhost>',
  },
  redis: {
    enabled: process.env.REDIS_DISABLED !== '1',
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    verbose: process.env.REDIS_VERBOSE === '1',
  },
  cache: {
    catalogTtlSec: Number(process.env.CACHE_CATALOG_TTL_SEC ?? 60),
    ttlJitterSec: Number(process.env.CACHE_TTL_JITTER_SEC ?? 10),
  },
  rateLimit: {
    enabled: process.env.RATE_LIMIT_DISABLED !== '1',
    hold: {
      capacity: Number(process.env.RL_HOLD_CAPACITY ?? 10),
      refillPerSecond: Number(process.env.RL_HOLD_REFILL_PER_SEC ?? 1),
    },
    book: {
      capacity: Number(process.env.RL_BOOK_CAPACITY ?? 5),
      refillPerSecond: Number(process.env.RL_BOOK_REFILL_PER_SEC ?? 0.5),
    },
  },
};
