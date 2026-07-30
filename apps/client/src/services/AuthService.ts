import { apiClient } from '@/lib/api/client';
import { getApiErrorMessage } from '@/lib/api/errors';
import type { ApiResponse } from '@repo/shared-types';
import crypto from 'crypto-js';

import {
  CLIENT_API_ROUTES,
  ADMIN_TOKEN_STORAGE_KEY,
} from '@/lib/constants';

interface ChallengeResponse {
  challengeId: string;
  challenge: string;
}

interface VerifyResponse {
  token: string;
  expiresIn: number;
}

class AuthService {
  private static instance: AuthService;

  private constructor() {}

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  async authenticate(password: string): Promise<string> {
    try {
      const challengeResponse = await apiClient
        .getClient()
        .post<ApiResponse<ChallengeResponse>>(CLIENT_API_ROUTES.AUTH_CHALLENGE);

      if (!challengeResponse.data.success || !challengeResponse.data.data) {
        throw new Error('Failed to get challenge');
      }

      const { challengeId, challenge } = challengeResponse?.data?.data;

      const signature = crypto.HmacSHA256(challenge, password).toString();

      const verifyResponse = await apiClient
        .getClient()
        .post<ApiResponse<VerifyResponse>>(CLIENT_API_ROUTES.AUTH_VERIFY, {
          challengeId,
          signature,
        });

      if (!verifyResponse.data.success || !verifyResponse.data.data) {
        throw new Error('Invalid credentials');
      }
      const { token } = verifyResponse.data.data;
      apiClient.setAuthToken(token);

      return token;
    } catch (error: any) {
      console.error('Authentication failed');

      if (apiClient.removeAuthToken) {
        apiClient.removeAuthToken();
      }

      if (error.response?.data) {
        throw new Error(getApiErrorMessage(error.response.data, 'Authentication failed'));
      }

      if (error.message) {
        throw error;
      }

      throw new Error('Authentication failed');
    }
  }

  logout(): void {
    if (apiClient.removeAuthToken) {
      apiClient.removeAuthToken();
    }

    if (typeof window !== 'undefined') {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  }

  validateToken(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;

      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(base64));

      if (payload.exp) {
        const now = Date.now() / 1000;
        return payload.exp > now;
      }

      if (payload.iat) {
        const now = Date.now() / 1000;
        const dayInSeconds = 86400;
        return payload.iat + dayInSeconds > now;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  restoreSession(): string | null {
    if (typeof window === 'undefined') return null;

    const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (token && this.validateToken(token)) {
      apiClient.setAuthToken(token);
      return token;
    }

    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return null;
  }
}

export const authService = AuthService.getInstance();
