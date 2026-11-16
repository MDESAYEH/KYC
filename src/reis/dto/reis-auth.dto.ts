/** POST {base}/xauth/authenticate/ body (confirmed). Never persist or log. */
export interface ReisAuthRequest {
  user_name: string;
  password: string;
}

/**
 * Auth response (confirmed by the working Postman collection, which reads
 * `pm.response.json().token`). The client may hold the value under any internal name; the
 * wire field is `token`. It is sent to onboarding as the `x-auth-token` header.
 */
export interface ReisAuthResponse {
  token: string;
}
