/** One browser container asking this desktop for access. It holds no
 *  credential: the answer here is the credential. */
export interface RemoteClientClaim {
  claimId: string;
  clientId: string;
  name: string;
  platform: string;
  browser: string;
  expiresAt: number;
}
