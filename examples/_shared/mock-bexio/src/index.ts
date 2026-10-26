/**
 * A mock of Bexio's OIDC identity provider (Keycloak) and the parts of the
 * Bexio API the library touches. For tests and the example apps only.
 *
 * Behaves like the real thing where it matters:
 * - authorization code flow with PKCE (S256), state, nonce, `iss` in the response;
 * - RS256-signed ID and access tokens with Bexio's claim split: the access
 *   token carries `company_id`, `company_user_id` and `login_id` but no
 *   company name, email or person name; the ID token and userinfo carry the
 *   profile (`given_name`/`family_name` but no `name`);
 * - rotating refresh tokens; reusing one revokes the whole session (Keycloak's
 *   refresh-token reuse detection);
 * - one token chain per user, company and client: every new authorization of
 *   a user and company starts a new session, and refresh tokens issued before
 *   it fail with `invalid_grant` ("Refresh token issued before the user
 *   session started"). Another company's chain is not affected. The mock
 *   serves a single client;
 * - token revocation: revoking any of a user's refresh tokens, even one from
 *   an older authorization or another company, ends all of the user's
 *   current chains, as Bexio does;
 * - userinfo, `GET /3.0/permissions`, `GET /2.0/company_profile`.
 *
 * Kept to a single file without relative imports so it runs directly with
 * Node's type stripping and type-checks from any importing project.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";

export interface MockCompany {
  companyId: string;
  companyName: string;
  companyUserId: number;
  admin?: boolean;
}

export interface MockUser {
  sub: string;
  email: string;
  givenName: string;
  familyName: string;
  loginId?: string;
  companies: MockCompany[];
}

export interface MockBexioOptions {
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** Advertise a revocation endpoint in discovery. Default true. */
  revocationEndpoint?: boolean;
  clientId?: string;
  clientSecret?: string;
  users?: MockUser[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

export interface MockStats {
  authorizationCodeGrants: number;
  refreshTokenGrants: number;
  rejectedRefreshes: number;
  revocations: number;
  userinfo: number;
  permissions: number;
}

export interface NextLogin {
  sub?: string;
  companyId?: string;
  /** Answer the next authorization request with this error, e.g. `access_denied`. */
  error?: string;
  /** Hand out a broken ID token for this login: wrong nonce, or signed with an unknown key. */
  tamperIdToken?: "nonce" | "signature" | "issuer";
}

export interface MockBexio {
  /** Base URL of the server, also the API base URL. */
  url: string;
  issuer: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  stats: MockStats;
  users: MockUser[];
  /** Selects who "logs in" on the next authorization request. */
  nextLogin(login: NextLogin): void;
  /** Revokes every session (or those of one user): their refresh tokens stop working. */
  revokeSessions(sub?: string): void;
  setAdmin(sub: string, companyId: string, admin: boolean): void;
  /** Signs a token like the mock would, for tests that need forged or foreign tokens. */
  signAccessToken(
    claims: Record<string, unknown>,
    options?: { issuer?: string; foreignKey?: boolean },
  ): Promise<string>;
  /**
   * Issues a token response directly, as if the user had logged in. Stands in
   * for an auth framework that ran the login itself (for `saveGrant` tests).
   */
  issueTokens(
    login?: { sub?: string; companyId?: string },
    options?: { idToken?: boolean },
  ): Promise<TokenResponse>;
  close(): Promise<void>;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
  scope: string;
}

export const DEFAULT_USERS: MockUser[] = [
  {
    sub: "8f1c2a8e-0001-4000-8000-000000000001",
    email: "ada@example.com",
    givenName: "Ada",
    familyName: "Lovelace",
    loginId: "login-ada",
    companies: [
      {
        companyId: "cmp-alpha",
        companyName: "Alpha AG",
        companyUserId: 1,
        admin: true,
      },
      {
        companyId: "cmp-beta",
        companyName: "Beta GmbH",
        companyUserId: 7,
        admin: false,
      },
    ],
  },
  {
    sub: "8f1c2a8e-0002-4000-8000-000000000002",
    email: "grace@example.com",
    givenName: "Grace",
    familyName: "Hopper",
    loginId: "login-grace",
    companies: [
      {
        companyId: "cmp-alpha",
        companyName: "Alpha AG",
        companyUserId: 2,
        admin: false,
      },
    ],
  },
  {
    sub: "8f1c2a8e-0003-4000-8000-000000000003",
    email: "katherine@example.com",
    givenName: "Katherine",
    familyName: "Johnson",
    loginId: "login-katherine",
    companies: [
      {
        companyId: "cmp-beta",
        companyName: "Beta GmbH",
        companyUserId: 3,
        admin: true,
      },
    ],
  },
];

interface Session {
  sid: string;
  sub: string;
  companyId: string;
  scope: string;
  revoked: boolean;
}

interface Code {
  session: Session;
  tamper: NextLogin["tamperIdToken"];
  redirectUri: string;
  challenge: string;
  nonce: string | null;
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const random = () => b64url(randomBytes(24));

export async function startMockBexio(
  options: MockBexioOptions = {},
): Promise<MockBexio> {
  const clientId = options.clientId ?? "test-client";
  const clientSecret = options.clientSecret ?? "test-secret";
  const users = structuredClone(options.users ?? DEFAULT_USERS);
  const accessTtl = options.accessTokenTtlSeconds ?? 300;
  const refreshTtl = options.refreshTokenTtlSeconds ?? 31_536_000;
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const kid = random();
  const foreign = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };

  const codes = new Map<string, Code>();
  const refreshTokens = new Map<string, { session: Session; used: boolean }>();
  const sessions = new Map<string, Session>();
  /** The session each user's latest authorization for a company started. */
  const currentSessions = new Map<string, Session>();
  const stats: MockStats = {
    authorizationCodeGrants: 0,
    refreshTokenGrants: 0,
    rejectedRefreshes: 0,
    revocations: 0,
    userinfo: 0,
    permissions: 0,
  };
  let pendingLogin: NextLogin | null = null;
  let base = "";
  let issuer = "";

  const findUser = (sub: string) => users.find((u) => u.sub === sub);
  const findCompany = (s: Session) =>
    findUser(s.sub)?.companies.find((c) => c.companyId === s.companyId);

  async function sign(
    claims: Record<string, unknown>,
    ttl: number,
    iss = issuer,
    key = privateKey,
  ) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(iss)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .setJti(randomUUID())
      .sign(key);
  }

  async function issueTokens(
    session: Session,
    nonce: string | null,
    withIdToken: boolean,
    tamper?: NextLogin["tamperIdToken"],
  ) {
    const user = findUser(session.sub)!;
    const company = findCompany(session)!;
    const refreshToken = random();
    refreshTokens.set(refreshToken, { session, used: false });
    const body: Record<string, unknown> = {
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_expires_in: refreshTtl,
      scope: session.scope,
      session_state: session.sid,
      refresh_token: refreshToken,
      access_token: await sign(
        {
          sub: user.sub,
          aud: "account",
          azp: clientId,
          typ: "Bearer",
          sid: session.sid,
          scope: session.scope,
          company_id: company.companyId,
          company_user_id: company.companyUserId,
          login_id: user.loginId ?? user.sub,
        },
        accessTtl,
      ),
    };
    if (withIdToken) {
      body.id_token = await sign(
        {
          sub: user.sub,
          aud: clientId,
          azp: clientId,
          typ: "ID",
          sid: session.sid,
          ...(nonce
            ? { nonce: tamper === "nonce" ? "wrong-nonce" : nonce }
            : {}),
          auth_time: Math.floor(Date.now() / 1000),
          ...profileClaims(user, company),
        },
        accessTtl,
        tamper === "issuer" ? "https://evil.example/realms/bexio" : issuer,
        tamper === "signature" ? foreign.privateKey : privateKey,
      );
    }
    return body;
  }

  function profileClaims(user: MockUser, company: MockCompany) {
    return {
      email: user.email,
      email_verified: true,
      given_name: user.givenName,
      family_name: user.familyName,
      preferred_username: user.email,
      company_id: company.companyId,
      company_name: company.companyName,
    };
  }

  async function bearerSession(req: IncomingMessage): Promise<Session | null> {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return null;
    try {
      const { payload } = await jwtVerify(header.slice(7), publicKey, {
        issuer,
      });
      const session = sessions.get(String(payload.sid));
      return session && !session.revoked ? session : null;
    } catch {
      return null;
    }
  }

  function clientAuthenticated(
    req: IncomingMessage,
    form: URLSearchParams,
  ): boolean {
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(header.slice(6), "base64")
        .toString()
        .split(":");
      return (
        decodeURIComponent(id ?? "") === clientId &&
        decodeURIComponent(secret ?? "") === clientSecret
      );
    }
    return (
      form.get("client_id") === clientId &&
      form.get("client_secret") === clientSecret
    );
  }

  function revokeSession(session: Session) {
    session.revoked = true;
  }

  const chainOf = (session: Session) =>
    `${session.sub}\u0000${session.companyId}`;

  /** A new authorization: earlier refresh tokens of the user and company stop working. */
  function startSession(session: Session) {
    sessions.set(session.sid, session);
    currentSessions.set(chainOf(session), session);
  }

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const oauthError = (
    res: ServerResponse,
    status: number,
    error: string,
    description?: string,
  ) =>
    send(res, status, {
      error,
      ...(description ? { error_description: description } : {}),
    });

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", base);
    const realm = "/realms/bexio";
    const oidcPath = `${realm}/protocol/openid-connect`;

    if (
      req.method === "GET" &&
      url.pathname === `${realm}/.well-known/openid-configuration`
    ) {
      return send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
        ...(options.revocationEndpoint === false
          ? {}
          : {
              revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`,
            }),
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
        ],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: [
          "openid",
          "profile",
          "email",
          "company_profile",
          "offline_access",
        ],
      });
    }

    if (req.method === "GET" && url.pathname === `${oidcPath}/certs`) {
      return send(res, 200, { keys: [publicJwk] });
    }

    if (req.method === "GET" && url.pathname === `${oidcPath}/auth`) {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri");
      if (q.get("client_id") !== clientId || !redirectUri) {
        return send(res, 400, {
          error: "invalid_request",
          error_description: "unknown client or missing redirect_uri",
        });
      }
      const target = new URL(redirectUri);
      const state = q.get("state");
      if (state) target.searchParams.set("state", state);
      target.searchParams.set("iss", issuer);
      const login = pendingLogin ?? {};
      pendingLogin = null;
      if (login.error) {
        target.searchParams.set("error", login.error);
      } else if (
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("code_challenge")
      ) {
        target.searchParams.set("error", "invalid_request");
      } else {
        const user = login.sub ? findUser(login.sub) : users[0];
        const company = user?.companies.find(
          (c) => !login.companyId || c.companyId === login.companyId,
        );
        if (!user || !company)
          return send(res, 400, { error: "unknown mock user or company" });
        const session: Session = {
          sid: randomUUID(),
          sub: user.sub,
          companyId: company.companyId,
          scope: q.get("scope") ?? "openid",
          revoked: false,
        };
        const code = random();
        codes.set(code, {
          session,
          redirectUri,
          challenge: q.get("code_challenge")!,
          nonce: q.get("nonce"),
          tamper: login.tamperIdToken,
          expiresAt: Date.now() + 60_000,
        });
        target.searchParams.set("code", code);
        target.searchParams.set("session_state", session.sid);
      }
      res.writeHead(302, { Location: target.href });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === `${oidcPath}/token`) {
      const form = new URLSearchParams(await readBody(req));
      if (!clientAuthenticated(req, form))
        return oauthError(res, 401, "invalid_client");
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!code || code.expiresAt < Date.now())
          return oauthError(res, 400, "invalid_grant", "code invalid or used");
        if (form.get("redirect_uri") !== code.redirectUri)
          return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
        const verifier = form.get("code_verifier") ?? "";
        if (
          b64url(createHash("sha256").update(verifier).digest()) !==
          code.challenge
        ) {
          return oauthError(
            res,
            400,
            "invalid_grant",
            "PKCE verification failed",
          );
        }
        stats.authorizationCodeGrants++;
        startSession(code.session);
        return send(
          res,
          200,
          await issueTokens(code.session, code.nonce, true, code.tamper),
        );
      }
      if (grantType === "refresh_token") {
        const entry = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!entry || entry.session.revoked) {
          stats.rejectedRefreshes++;
          return oauthError(res, 400, "invalid_grant", "Session not active");
        }
        if (currentSessions.get(chainOf(entry.session)) !== entry.session) {
          stats.rejectedRefreshes++;
          return oauthError(
            res,
            400,
            "invalid_grant",
            "Refresh token issued before the user session started",
          );
        }
        if (entry.used) {
          // Reuse detection: a rotated-out refresh token kills the session.
          revokeSession(entry.session);
          stats.rejectedRefreshes++;
          return oauthError(
            res,
            400,
            "invalid_grant",
            "Maximum allowed refresh token reuse exceeded",
          );
        }
        entry.used = true;
        stats.refreshTokenGrants++;
        return send(res, 200, await issueTokens(entry.session, null, false));
      }
      return oauthError(res, 400, "unsupported_grant_type");
    }

    if (req.method === "POST" && url.pathname === `${oidcPath}/revoke`) {
      const form = new URLSearchParams(await readBody(req));
      if (!clientAuthenticated(req, form))
        return oauthError(res, 401, "invalid_client");
      const entry = refreshTokens.get(form.get("token") ?? "");
      if (entry) {
        revokeSession(entry.session);
        for (const current of currentSessions.values())
          if (current.sub === entry.session.sub) revokeSession(current);
      }
      stats.revocations++;
      return send(res, 200, undefined);
    }

    if (req.method === "GET" && url.pathname === `${oidcPath}/userinfo`) {
      const session = await bearerSession(req);
      if (!session) return send(res, 401, { error: "invalid_token" });
      stats.userinfo++;
      return send(res, 200, {
        sub: session.sub,
        ...profileClaims(findUser(session.sub)!, findCompany(session)!),
      });
    }

    if (req.method === "GET" && url.pathname === "/3.0/permissions") {
      const session = await bearerSession(req);
      if (!session) return send(res, 401, { error: "invalid_token" });
      stats.permissions++;
      const admin = findCompany(session)?.admin ? "enabled" : "disabled";
      return send(res, 200, {
        components: [],
        permissions: { admin: { activation: admin } },
      });
    }

    if (req.method === "GET" && url.pathname === "/2.0/company_profile") {
      const session = await bearerSession(req);
      if (!session) return send(res, 401, { error: "invalid_token" });
      const company = findCompany(session)!;
      return send(res, 200, [{ id: 1, name: company.companyName }]);
    }

    // Test controls, for e2e suites that run the mock as a separate process.
    if (req.method === "POST" && url.pathname === "/__mock/next-login") {
      api.nextLogin(JSON.parse((await readBody(req)) || "{}") as NextLogin);
      return send(res, 204, undefined);
    }
    if (req.method === "POST" && url.pathname === "/__mock/revoke-sessions") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        sub?: string;
      };
      api.revokeSessions(body.sub);
      return send(res, 204, undefined);
    }
    if (req.method === "GET" && url.pathname === "/__mock/stats") {
      return send(res, 200, stats);
    }

    return send(res, 404, { error: "not_found" });
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      send(res, 500, {
        error: "server_error",
        error_description: String(error),
      });
    });
  };
  const server = createServer(listener);
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  base = `http://${options.host ?? "127.0.0.1"}:${port}`;
  issuer = `${base}/realms/bexio`;

  const api: MockBexio = {
    url: base,
    issuer,
    apiBaseUrl: base,
    clientId,
    clientSecret,
    stats,
    users,
    nextLogin(login) {
      pendingLogin = login;
    },
    revokeSessions(sub) {
      for (const session of sessions.values())
        if (!sub || session.sub === sub) revokeSession(session);
    },
    setAdmin(sub, companyId, admin) {
      const company = findUser(sub)?.companies.find(
        (c) => c.companyId === companyId,
      );
      if (company) company.admin = admin;
    },
    async issueTokens(login = {}, opts = {}) {
      const user = login.sub ? findUser(login.sub) : users[0];
      const company = user?.companies.find(
        (c) => !login.companyId || c.companyId === login.companyId,
      );
      if (!user || !company) throw new Error("unknown mock user or company");
      const session: Session = {
        sid: randomUUID(),
        sub: user.sub,
        companyId: company.companyId,
        scope: "openid profile email company_profile offline_access",
        revoked: false,
      };
      startSession(session);
      return (await issueTokens(
        session,
        null,
        opts.idToken ?? true,
      )) as unknown as TokenResponse;
    },
    async signAccessToken(claims, opts) {
      return sign(
        { aud: "account", azp: clientId, typ: "Bearer", ...claims },
        accessTtl,
        opts?.issuer ?? issuer,
        opts?.foreignKey ? foreign.privateKey : privateKey,
      );
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  return api;
}
