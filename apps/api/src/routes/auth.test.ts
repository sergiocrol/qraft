import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWT_ISSUER, JWT_EXPIRES_IN } from "../constants";

describe("admin JWT expiry", () => {
  it("issues a token that expires in ~24h (iat/exp in seconds)", () => {
    const token = jwt.sign({ role: "admin" }, "test-secret", {
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
    });
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    const nowSec = Math.floor(Date.now() / 1000);

    // iat must be seconds-scale, not milliseconds. The historical bug signed
    // `iat: Date.now()` (ms), which jsonwebtoken then treated as seconds when
    // computing exp = iat + expiresInSeconds, landing exp ~55,000 years out.
    expect(decoded.iat).toBeLessThan(1e12);
    expect(decoded.iat).toBeLessThanOrEqual(nowSec + 2);
    expect(decoded.exp - decoded.iat).toBe(86400); // exactly 24h, not 55,000 years
  });

  it("rejects tokens older than 24h when verified with maxAge (defense in depth)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Token issued 25h ago, deliberately without exp — maxAge alone must bound it,
    // mirroring the adminAuth middleware's verify options.
    const staleToken = jwt.sign(
      { role: "admin", iat: nowSec - 25 * 3600 },
      "test-secret",
      { issuer: JWT_ISSUER },
    );

    expect(() =>
      jwt.verify(staleToken, "test-secret", {
        issuer: JWT_ISSUER,
        maxAge: JWT_EXPIRES_IN,
      }),
    ).toThrow(jwt.TokenExpiredError);

    // Positive control: a fresh token passes the exact same verify options.
    const freshToken = jwt.sign({ role: "admin" }, "test-secret", {
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
    });
    expect(() =>
      jwt.verify(freshToken, "test-secret", {
        issuer: JWT_ISSUER,
        maxAge: JWT_EXPIRES_IN,
      }),
    ).not.toThrow();
  });
});
