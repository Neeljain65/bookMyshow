'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { api, formatInr, quoteTotals } from '@/lib/api';
import styles from './checkout.module.css';

function useCountdown(expiresAt) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      setLeft(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt]);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return { left, label: `${mm}:${ss}` };
}

export default function CheckoutPage() {
  const router = useRouter();
  const { getToken } = useAuth();
  const [checkout, setCheckout] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bookingInFlight = useRef(false);
  const { left, label } = useCountdown(checkout?.expiresAt);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('bms_checkout');
      if (!raw) {
        router.replace('/');
        return;
      }
      setCheckout(JSON.parse(raw));
    } catch {
      router.replace('/');
    }
  }, [router]);

  useEffect(() => {
    if (checkout && left === 0) {
      setError('Hold expired. Seats were released — pick again.');
    }
  }, [checkout, left]);

  const quote = useMemo(
    () => quoteTotals(checkout?.seats || []),
    [checkout],
  );

  async function onBack() {
    if (!checkout || bookingInFlight.current) return;
    setBusy(true);
    try {
      const token = await getToken();
      await api.cancelHold(token, checkout.holdId);
    } catch {
      // still leave checkout even if cancel races with expiry
    } finally {
      sessionStorage.removeItem('bms_checkout');
      setBusy(false);
      router.push(checkout.showId ? `/show/${checkout.showId}` : '/');
    }
  }

  async function onBook() {
    if (!checkout || left === 0) return;
    // Hard guard: ignore double-clicks even before React re-renders disabled state.
    if (bookingInFlight.current) return;
    bookingInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const token = await getToken();
      // Backend is idempotent on holdId — retries return the same bookingId.
      const booking = await api.book(token, checkout.holdId);
      sessionStorage.removeItem('bms_checkout');
      router.push(`/booking/${booking.bookingId}`);
    } catch (err) {
      setError(err.message || 'Booking failed');
      bookingInFlight.current = false;
      setBusy(false);
    }
  }

  if (!checkout) return <p>Loading checkout…</p>;

  return (
    <section className={styles.wrap}>
      <h1>Checkout</h1>
      <p>
        Seats are locked for you.{' '}
        <strong className={left < 60 ? styles.urgent : undefined}>Time left {label}</strong>
      </p>

      <div className={styles.panel}>
        <h2>Seats</h2>
        <p>
          {checkout.seats.map((s) => `${s.row_label}${s.seat_number}`).join(', ')}
        </p>

        <h2>Price breakdown</h2>
        <dl className={styles.dl}>
          <div>
            <dt>Tickets</dt>
            <dd>{formatInr(quote.subtotalPaise)}</dd>
          </div>
          <div>
            <dt>Convenience fee</dt>
            <dd>{formatInr(quote.conveniencePaise)}</dd>
          </div>
          <div>
            <dt>GST (18%)</dt>
            <dd>{formatInr(quote.gstPaise)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Total</dt>
            <dd>{formatInr(quote.totalPaise)}</dd>
          </div>
        </dl>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          Payment gateway skipped — Book confirms the seats and emails your ticket.
          Clicking Book more than once still creates only one booking.
        </p>
      </div>

      <div className={styles.actions}>
        <button type="button" className="btn btnSecondary" disabled={busy} onClick={onBack}>
          Back (release seats)
        </button>
        <button
          type="button"
          className="btn btnAccent"
          disabled={busy || left === 0}
          onClick={onBook}
        >
          {busy ? 'Booking…' : 'Book'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
