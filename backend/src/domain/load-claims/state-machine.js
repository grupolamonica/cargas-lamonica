import { LoadClaimServiceError } from "./errors.js";

export class InvalidTransitionError extends LoadClaimServiceError {
  constructor(from, event, to) {
    super(`Invalid transition: ${from} --[${event}]--> ${to ?? "?"}`);
    this.name = "InvalidTransitionError";
    this.code = "INVALID_TRANSITION";
    this.statusCode = 409;
    this.from = from;
    this.event = event;
    this.to = to;
  }
}

/**
 * Terminal claim states — no outbound transitions allowed.
 * Source: CLAIM_STATUS in constants.js + service.js transition analysis.
 */
export const TERMINAL_CLAIM_STATES = new Set([
  "CONFIRMED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED",
  "FAILED",
]);

/**
 * Explicit state transition table for load claims.
 *
 * Structure: { fromState: { eventName: toState } }
 *
 * Transitions derived from application/load-claims/service.js:
 *   PENDING     --[win_reservation]-->  WON_RESERVATION  (createClaim: load open, slot available)
 *   PENDING     --[waitlist]---------->  WAITLISTED       (createClaim: load reserved, goes to waitlist)
 *   PENDING     --[reject]------------>  REJECTED         (createClaim: driver ineligible)
 *   WON_RESERVATION --[confirm]------> CONFIRMED         (confirmClaim: driver confirms)
 *   WON_RESERVATION --[expire]-------> EXPIRED           (reservation TTL elapsed)
 *   WON_RESERVATION --[cancel]-------> CANCELLED         (cancelClaim)
 *   WAITLISTED  --[promote]----------> PROMOTED          (promoteNextEligibleClaim)
 *   WAITLISTED  --[reject]-----------> REJECTED          (load booked by another or ineligible)
 *   WAITLISTED  --[expire]-----------> EXPIRED           (expireCurrentReservationIfNeeded cascade)
 *   PROMOTED    --[confirm]----------> CONFIRMED         (confirmClaim after promotion)
 *   PROMOTED    --[cancel]-----------  CANCELLED         (cancelClaim after promotion)
 *   PROMOTED    --[expire]-----------> EXPIRED           (reservation TTL elapsed)
 */
export const TRANSITIONS = Object.freeze({
  PENDING: Object.freeze({
    win_reservation: "WON_RESERVATION",
    waitlist: "WAITLISTED",
    reject: "REJECTED",
  }),
  WON_RESERVATION: Object.freeze({
    confirm: "CONFIRMED",
    expire: "EXPIRED",
    cancel: "CANCELLED",
  }),
  WAITLISTED: Object.freeze({
    promote: "PROMOTED",
    reject: "REJECTED",
    expire: "EXPIRED",
  }),
  PROMOTED: Object.freeze({
    confirm: "CONFIRMED",
    cancel: "CANCELLED",
    expire: "EXPIRED",
  }),
  // Terminal states have no entries — any event on them is rejected.
});

/**
 * Compute next state or throw InvalidTransitionError.
 *
 * @param {string} currentState - Current CLAIM_STATUS value
 * @param {string} event - Transition event name (see TRANSITIONS keys)
 * @returns {string} Next state
 * @throws {InvalidTransitionError} if transition is not allowed
 */
export function transition(currentState, event) {
  if (!currentState) {
    throw new InvalidTransitionError(currentState, event, null);
  }
  if (TERMINAL_CLAIM_STATES.has(currentState)) {
    throw new InvalidTransitionError(currentState, event, null);
  }
  const stateTransitions = TRANSITIONS[currentState];
  if (!stateTransitions) {
    throw new InvalidTransitionError(currentState, event, null);
  }
  const nextState = stateTransitions[event];
  if (!nextState) {
    throw new InvalidTransitionError(currentState, event, null);
  }
  return nextState;
}

/**
 * Returns true if the given event is valid from currentState, false otherwise.
 * Never throws.
 */
export function canTransition(currentState, event) {
  try {
    transition(currentState, event);
    return true;
  } catch {
    return false;
  }
}
