import { CanonicalKycCustomer, CanonicalRelatedPerson } from '../canonical';
import {
  ReisCorporateOnboardingRequest,
  ReisIndividualOnboardingRequest,
  ReisOnboardingRequest,
  ReisOnboardingResponse,
} from './dto';
import { ReisCallContext } from './transport/reis-http.transport';

/**
 * Obtains a FRESH token on every call (current working Postman behaviour). No caching.
 * The token must never be logged or persisted by callers.
 */
export interface IReisAuthClient {
  authenticate(context?: ReisCallContext): Promise<string>;
}
export const REIS_AUTH_CLIENT = Symbol('IReisAuthClient');

/**
 * Authenticates (fresh token), then POSTs the request (relations nested inside it) to searchOnboardCustomer using
 * `x-auth-token`. Throws a ReisClientError subtype on any failure; never retries.
 */
export interface IReisOnboardingClient {
  onboard(
    payload: ReisOnboardingRequest,
    context?: ReisCallContext,
  ): Promise<ReisOnboardingResponse>;
}
export const REIS_ONBOARDING_CLIENT = Symbol('IReisOnboardingClient');

/**
 * Canonical -> REIS onboarding envelope. Uses IReferenceMappingService; rejects unmapped values
 * and invalid input with typed errors, never guesses. `relations` defaults to none (the FLEXCUBE
 * source for corporate relations is TBD).
 */
export interface ICanonicalToReisTransformer {
  transform(
    customer: CanonicalKycCustomer,
    relations?: CanonicalRelatedPerson[],
  ): Promise<ReisIndividualOnboardingRequest | ReisCorporateOnboardingRequest>;
}
export const CANONICAL_TO_REIS_TRANSFORMER = Symbol('ICanonicalToReisTransformer');
