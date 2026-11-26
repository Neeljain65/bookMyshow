const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3200';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/health'),
  cities: () => request('/cities'),
  moviesByCity: (cityId) => request(`/cities/${cityId}/movies`),
  movie: (movieId) => request(`/movies/${movieId}`),
  showsForMovie: (movieId, cityId) =>
    request(`/movies/${movieId}/shows${cityId ? `?cityId=${cityId}` : ''}`),
  showSeats: (showId) => request(`/shows/${showId}/seats`),
  hold: (token, { showId, seatIds }) =>
    request('/holds', { method: 'POST', token, body: { showId, seatIds } }),
  cancelHold: (token, holdId) =>
    request(`/holds/${holdId}/cancel`, { method: 'POST', token, body: {} }),
  book: (token, holdId) =>
    request('/bookings', { method: 'POST', token, body: { holdId } }),
  booking: (token, bookingId) => request(`/bookings/${bookingId}`, { token }),
  myBookings: (token) => request('/me/bookings', { token }),
};

export function formatInr(paise) {
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

/** Simple demo pricing: convenience fee + GST on (subtotal + fee). */
export function quoteTotals(seats) {
  const subtotalPaise = seats.reduce((sum, s) => sum + Number(s.amount_paise || 0), 0);
  const conveniencePaise = seats.length * 2000; // ₹20 / seat
  const taxable = subtotalPaise + conveniencePaise;
  const gstPaise = Math.round(taxable * 0.18);
  const totalPaise = taxable + gstPaise;
  return { subtotalPaise, conveniencePaise, gstPaise, totalPaise };
}
