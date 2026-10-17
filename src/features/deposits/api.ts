import { ApiError, request } from '../../lib/api';

// Calls that place or release several sandbox holds in sequence take longer.
export const PAYPAL_TIMEOUT_MS = 60_000;

export const bookingUrl = (bookingId: string) => `/api/deposits/bookings/${encodeURIComponent(bookingId)}`;
export const diverUrl = (bookingId: string, diverId: string) =>
  `${bookingUrl(bookingId)}/divers/${encodeURIComponent(diverId)}`;

/** Join once; rejoining under a name that holds nothing yet resumes that diver. */
export async function joinGroup(bookingId: string, name: string): Promise<string> {
  const { diverId } = await request<{ diverId: string }>(`${bookingUrl(bookingId)}/divers`, { name });
  return diverId;
}

const CONFLICT_MESSAGE: Record<string, string> = {
  DEPOSIT_NAME_TAKEN: 'That name already belongs to a diver in this group. Pick another display name.',
  DEPOSIT_ALREADY_HELD: 'This diver already has a deposit hold.',
  DEPOSIT_HOLD_IN_FLIGHT: 'PayPal is still confirming a hold for this name. Refresh in a moment.',
  DEPOSIT_ATTEMPT_CLOSED: 'That checkout was replaced by a newer attempt, so no hold was placed from it.',
  DEPOSIT_WORKSPACE_FULL: 'A workspace holds at most 5 bookings. Reset it to start again.',
  PAYPAL_INSTRUMENT_DECLINED: 'The PayPal sandbox declined this card, so no hold was placed. Try again, or use the sandbox test card below.',
};

export function depositError(error: unknown): string {
  if (error instanceof ApiError) {
    if (CONFLICT_MESSAGE[error.code]) return CONFLICT_MESSAGE[error.code];
    if (error.status === 404) return 'This booking is not in your workspace. It may have been reset.';
    if (error.status === 409) return 'That step is no longer possible; the booking changed. The page has been refreshed.';
    if (error.status === 400) return 'Please check the input and try again.';
    if (error.status === 503) return 'The service or the PayPal sandbox is unavailable right now. Try again shortly.';
    return 'Something went wrong on our side. Try again; if it keeps failing, reset the workspace.';
  }
  return 'Connection lost. Try again.';
}
