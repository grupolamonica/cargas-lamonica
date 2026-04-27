import { describe, it, expect } from "vitest";
import {
  transition,
  canTransition,
  TRANSITIONS,
  TERMINAL_CLAIM_STATES,
  InvalidTransitionError,
} from "./state-machine.js";

describe("state-machine: valid transitions", () => {
  it("PENDING --[win_reservation]--> WON_RESERVATION", () => {
    expect(transition("PENDING", "win_reservation")).toBe("WON_RESERVATION");
  });

  it("PENDING --[waitlist]--> WAITLISTED", () => {
    expect(transition("PENDING", "waitlist")).toBe("WAITLISTED");
  });

  it("PENDING --[reject]--> REJECTED", () => {
    expect(transition("PENDING", "reject")).toBe("REJECTED");
  });

  it("WON_RESERVATION --[confirm]--> CONFIRMED", () => {
    expect(transition("WON_RESERVATION", "confirm")).toBe("CONFIRMED");
  });

  it("WON_RESERVATION --[expire]--> EXPIRED", () => {
    expect(transition("WON_RESERVATION", "expire")).toBe("EXPIRED");
  });

  it("WON_RESERVATION --[cancel]--> CANCELLED", () => {
    expect(transition("WON_RESERVATION", "cancel")).toBe("CANCELLED");
  });

  it("WAITLISTED --[promote]--> PROMOTED", () => {
    expect(transition("WAITLISTED", "promote")).toBe("PROMOTED");
  });

  it("WAITLISTED --[reject]--> REJECTED", () => {
    expect(transition("WAITLISTED", "reject")).toBe("REJECTED");
  });

  it("WAITLISTED --[expire]--> EXPIRED", () => {
    expect(transition("WAITLISTED", "expire")).toBe("EXPIRED");
  });

  it("PROMOTED --[confirm]--> CONFIRMED", () => {
    expect(transition("PROMOTED", "confirm")).toBe("CONFIRMED");
  });

  it("PROMOTED --[cancel]--> CANCELLED", () => {
    expect(transition("PROMOTED", "cancel")).toBe("CANCELLED");
  });

  it("PROMOTED --[expire]--> EXPIRED", () => {
    expect(transition("PROMOTED", "expire")).toBe("EXPIRED");
  });
});

describe("state-machine: all TRANSITIONS entries produce valid output", () => {
  it("all (state, event) pairs in TRANSITIONS return the expected target state", () => {
    for (const [state, events] of Object.entries(TRANSITIONS)) {
      for (const [event, expectedNext] of Object.entries(events)) {
        expect(transition(state, event)).toBe(expectedNext);
      }
    }
  });
});

describe("state-machine: invalid events on non-terminal states", () => {
  it("PENDING rejects unknown events", () => {
    expect(() => transition("PENDING", "confirm")).toThrow(InvalidTransitionError);
    expect(() => transition("PENDING", "cancel")).toThrow(InvalidTransitionError);
    expect(() => transition("PENDING", "expire")).toThrow(InvalidTransitionError);
    expect(() => transition("PENDING", "promote")).toThrow(InvalidTransitionError);
    expect(() => transition("PENDING", "book")).toThrow(InvalidTransitionError);
  });

  it("WON_RESERVATION rejects unknown events", () => {
    expect(() => transition("WON_RESERVATION", "reject")).toThrow(InvalidTransitionError);
    expect(() => transition("WON_RESERVATION", "promote")).toThrow(InvalidTransitionError);
    expect(() => transition("WON_RESERVATION", "waitlist")).toThrow(InvalidTransitionError);
  });

  it("WAITLISTED rejects unknown events", () => {
    expect(() => transition("WAITLISTED", "confirm")).toThrow(InvalidTransitionError);
    expect(() => transition("WAITLISTED", "win_reservation")).toThrow(InvalidTransitionError);
  });

  it("WAITLISTED --[cancel]--> CANCELLED", () => {
    expect(transition("WAITLISTED", "cancel")).toBe("CANCELLED");
  });

  it("PROMOTED rejects unknown events", () => {
    expect(() => transition("PROMOTED", "reject")).toThrow(InvalidTransitionError);
    expect(() => transition("PROMOTED", "promote")).toThrow(InvalidTransitionError);
    expect(() => transition("PROMOTED", "waitlist")).toThrow(InvalidTransitionError);
  });
});

describe("state-machine: terminal states reject all events", () => {
  const sampleEvents = ["confirm", "cancel", "reject", "expire", "promote", "win_reservation", "waitlist", "fail", "complete"];

  for (const terminalState of TERMINAL_CLAIM_STATES) {
    it(`${terminalState} rejects all events`, () => {
      for (const event of sampleEvents) {
        expect(() => transition(terminalState, event)).toThrow(InvalidTransitionError);
      }
    });
  }
});

describe("state-machine: InvalidTransitionError properties", () => {
  it("has statusCode 409", () => {
    const err = new InvalidTransitionError("PENDING", "confirm", null);
    expect(err.statusCode).toBe(409);
  });

  it("has code INVALID_TRANSITION", () => {
    const err = new InvalidTransitionError("PENDING", "confirm", null);
    expect(err.code).toBe("INVALID_TRANSITION");
  });

  it("has name InvalidTransitionError", () => {
    const err = new InvalidTransitionError("PENDING", "confirm", null);
    expect(err.name).toBe("InvalidTransitionError");
  });

  it("carries from + event fields", () => {
    const err = new InvalidTransitionError("WAITLISTED", "win_reservation", null);
    expect(err.from).toBe("WAITLISTED");
    expect(err.event).toBe("win_reservation");
  });

  it("thrown by transition() carries correct from/event", () => {
    try {
      transition("PROMOTED", "reject");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect(err.from).toBe("PROMOTED");
      expect(err.event).toBe("reject");
    }
  });

  it("null/undefined currentState throws InvalidTransitionError", () => {
    expect(() => transition(null, "confirm")).toThrow(InvalidTransitionError);
    expect(() => transition(undefined, "confirm")).toThrow(InvalidTransitionError);
  });

  it("unknown currentState throws InvalidTransitionError", () => {
    expect(() => transition("NONEXISTENT", "confirm")).toThrow(InvalidTransitionError);
  });
});

describe("state-machine: canTransition", () => {
  it("returns true for valid transitions", () => {
    expect(canTransition("PENDING", "win_reservation")).toBe(true);
    expect(canTransition("PENDING", "waitlist")).toBe(true);
    expect(canTransition("WON_RESERVATION", "confirm")).toBe(true);
    expect(canTransition("PROMOTED", "expire")).toBe(true);
  });

  it("returns false for invalid transitions on non-terminal states", () => {
    expect(canTransition("PENDING", "confirm")).toBe(false);
    expect(canTransition("PENDING", "cancel")).toBe(false);
  });

  it("returns false for any event on terminal states", () => {
    for (const terminalState of TERMINAL_CLAIM_STATES) {
      expect(canTransition(terminalState, "confirm")).toBe(false);
      expect(canTransition(terminalState, "cancel")).toBe(false);
    }
  });

  it("returns false for null/undefined state", () => {
    expect(canTransition(null, "confirm")).toBe(false);
    expect(canTransition(undefined, "confirm")).toBe(false);
  });
});
