import { createClerkClient, verifyToken } from '@clerk/backend';
import { pool } from './db/pool.js';
import { config } from './config.js';

export class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

const clerk = config.clerk.secretKey
  ? createClerkClient({ secretKey: config.clerk.secretKey })
  : null;

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const [type, token] = h.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Upsert local user from Clerk profile (by clerk_id, else by email).
 */
export async function syncLocalUserFromClerk(clerkUser) {
  const email =
    clerkUser.emailAddresses?.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ||
    clerkUser.emailAddresses?.[0]?.emailAddress;
  if (!email) throw new AuthError('Clerk user has no email', 400);

  const name =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ').trim() ||
    clerkUser.username ||
    null;

  const byClerk = await pool.query(
    `SELECT id, email, name, clerk_id, role FROM users WHERE clerk_id = $1`,
    [clerkUser.id],
  );
  if (byClerk.rowCount) {
    const { rows } = await pool.query(
      `UPDATE users SET email = $2, name = COALESCE($3, name)
       WHERE clerk_id = $1
       RETURNING id, email, name, clerk_id, role`,
      [clerkUser.id, email, name],
    );
    return rows[0];
  }

  const byEmail = await pool.query(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );
  if (byEmail.rowCount) {
    const { rows } = await pool.query(
      `UPDATE users SET clerk_id = $2, name = COALESCE($3, name)
       WHERE email = $1
       RETURNING id, email, name, clerk_id, role`,
      [email, clerkUser.id, name],
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO users (email, name, clerk_id, role)
     VALUES ($1, $2, $3, 'USER')
     RETURNING id, email, name, clerk_id, role`,
    [email, name, clerkUser.id],
  );
  return rows[0];
}

/**
 * Resolve authenticated local user.
 * - Normal: Authorization: Bearer <Clerk session JWT>
 * - Dev benches: AUTH_DISABLED=1 + optionalUserId (never in production)
 */
export async function requireUser(req, { optionalUserId } = {}) {
  if (config.authDisabled) {
    const userId = Number(optionalUserId);
    if (!userId) throw new AuthError('userId required when AUTH_DISABLED=1', 400);
    const { rows } = await pool.query(
      `SELECT id, email, name, clerk_id, role FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows.length) throw new AuthError('user not found', 404);
    return rows[0];
  }

  if (!config.clerk.secretKey || !clerk) {
    throw new AuthError('Clerk is not configured (set CLERK_SECRET_KEY)', 503);
  }

  const token = bearerToken(req);
  if (!token) throw new AuthError('missing Authorization Bearer token');

  let payload;
  try {
    payload = await verifyToken(token, { secretKey: config.clerk.secretKey });
  } catch {
    throw new AuthError('invalid or expired token');
  }

  const clerkUserId = payload.sub;
  if (!clerkUserId) throw new AuthError('invalid token subject');

  const existing = await pool.query(
    `SELECT id, email, name, clerk_id, role FROM users WHERE clerk_id = $1`,
    [clerkUserId],
  );
  if (existing.rowCount) return existing.rows[0];

  const clerkUser = await clerk.users.getUser(clerkUserId);
  return syncLocalUserFromClerk(clerkUser);
}
