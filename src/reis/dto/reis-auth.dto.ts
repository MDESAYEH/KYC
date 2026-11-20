/** POST {base}/xauth/authenticate/ body (confirmed). Never persist or log. */
export interface ReisAuthRequest {
  user_name: string;
  password: string;
}
