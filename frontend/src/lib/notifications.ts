/**
 * Push Notifications & Price Alerts Library
 * 
 * Handles:
 * - Expo push notification registration
 * - Push token management with backend
 * - Price alert CRUD operations
 */

import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from './api';

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,  // Show as banner/alert when app is in foreground
    shouldShowList: true,     // Show in notification center/list
  }),
});

const EXPO_PUSH_TOKEN_CACHE_KEY = 'hypertrade_expo_push_token_cache';
const PUSH_ENABLED_CACHE_PREFIX = 'hypertrade_push_enabled_v1:';
const PUSH_TOKEN_RETRY_DELAYS_MS = [0, 1000, 2500];

/** In-memory Expo token for this session (Profile toggle + logout cleanup). */
let sessionPushToken: string | null = null;

export function setSessionPushToken(token: string | null): void {
  sessionPushToken = token;
}

export function getSessionPushToken(): string | null {
  return sessionPushToken;
}

export async function readCachedPushEnabled(userId: string): Promise<boolean | null> {
  try {
    const raw = await AsyncStorage.getItem(PUSH_ENABLED_CACHE_PREFIX + userId);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

export async function writeCachedPushEnabled(userId: string, enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(PUSH_ENABLED_CACHE_PREFIX + userId, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

/** Explicit boolean only — missing/undefined must not be treated as "on". */
export function readPushEnabledFlag(
  prefs: Pick<NotificationPreferences, 'push_enabled'> | null | undefined,
): boolean | null {
  return typeof prefs?.push_enabled === 'boolean' ? prefs.push_enabled : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientExpoTokenError = (error: any): boolean => {
  const msg = String(error?.message || '').toUpperCase();
  return (
    msg.includes('SERVICE_UNAVAILABLE') ||
    msg.includes('503') ||
    msg.includes('TIMEOUT') ||
    msg.includes('NETWORK REQUEST FAILED') ||
    msg.includes('FETCH FAILED')
  );
};

// Types
export interface PriceAlert {
  id: string;
  user_id: string;
  symbol: string;
  target_price: number;
  condition: 'above' | 'below';
  is_active: boolean;
  is_triggered: boolean;
  triggered_at?: string;
  triggered_price?: number;
  note?: string;
  created_at: string;
  updated_at: string;
}

export interface AlertHistory {
  id: string;
  user_id: string;
  symbol: string;
  target_price: number;
  triggered_price: number;
  condition: 'above' | 'below';
  note?: string;
  triggered_at: string;
}

export interface CreateAlertParams {
  symbol: string;
  target_price: number;
  condition: 'above' | 'below';
  note?: string;
}

export interface UpdateAlertParams {
  is_active?: boolean;
  target_price?: number;
  condition?: 'above' | 'below';
  note?: string;
}

export interface NotificationPreferences {
  user_id: string;
  /** Master Expo push (Profile toggle). Default on. */
  push_enabled?: boolean;
  system_alerts_enabled: boolean;
  /** UR banking push categories. These gate the push only — the in-app inbox
   * row is always recorded regardless. Default on. */
  ur_transaction_alerts_enabled?: boolean;
  ur_card_alerts_enabled?: boolean;
  ur_kyc_alerts_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

// ============================================================================
// Push Token Registration
// ============================================================================

/**
 * Request notification permissions and get the Expo push token.
 * Returns the push token string or null if not available.
 * 
 * Note: On Android, this requires Firebase Cloud Messaging (FCM) to be configured.
 * See: https://docs.expo.dev/push-notifications/fcm-credentials/
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Push notifications only work on physical devices
  if (!Device.isDevice) {
    if (__DEV__) console.log('[Notifications] Push notifications require a physical device');
    return null;
  }

  try {
    // Check existing permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    // Request permissions if not already granted
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      if (__DEV__) console.log('[Notifications] Permission not granted');
      return null;
    }

    // Get the Expo push token
    const projectId =
      Constants.easConfig?.projectId ||
      Constants.expoConfig?.extra?.eas?.projectId ||
      Constants.expoConfig?.extra?.expoClient?.extra?.eas?.projectId;
    if (!projectId) {
      if (__DEV__) {
        console.error('[Notifications] Missing EAS projectId; cannot fetch Expo push token.');
      }
      return null;
    }
    let pushToken: string | null = null;
    let lastError: any = null;

    for (let i = 0; i < PUSH_TOKEN_RETRY_DELAYS_MS.length; i++) {
      if (PUSH_TOKEN_RETRY_DELAYS_MS[i] > 0) {
        await sleep(PUSH_TOKEN_RETRY_DELAYS_MS[i]);
      }

      try {
        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        pushToken = tokenData.data;
        lastError = null;
        break;
      } catch (attemptError: any) {
        lastError = attemptError;
        const errorMessage = attemptError?.message || '';

        // FCM/Firebase misconfiguration is not transient; don't retry.
        if (errorMessage.includes('FirebaseApp') || errorMessage.includes('FCM')) {
          if (__DEV__) {
            console.log('[Notifications] FCM not configured. Push notifications disabled.');
            console.log('[Notifications] To enable, follow: https://docs.expo.dev/push-notifications/fcm-credentials/');
          }
          return null;
        }

        const hasMoreAttempts = i < PUSH_TOKEN_RETRY_DELAYS_MS.length - 1;
        if (__DEV__) {
          console.warn(
            `[Notifications] Push token fetch attempt ${i + 1}/${PUSH_TOKEN_RETRY_DELAYS_MS.length} failed`,
            attemptError
          );
        }
        if (!isTransientExpoTokenError(attemptError) || !hasMoreAttempts) {
          break;
        }
      }
    }

    // Expo can be temporarily unavailable (503). Fall back to last known token when available.
    if (!pushToken) {
      const cachedToken = await AsyncStorage.getItem(EXPO_PUSH_TOKEN_CACHE_KEY);
      if (cachedToken) {
        if (__DEV__) {
          console.warn('[Notifications] Using cached Expo push token due to transient token fetch failure.');
        }
        pushToken = cachedToken;
      }
    }

    if (!pushToken) {
      if (__DEV__ && lastError) {
        console.error('[Notifications] Failed to get push token:', lastError);
      }
      return null;
    }

    // Refresh cached token after successful fetch (or if unchanged from previous value).
    AsyncStorage.setItem(EXPO_PUSH_TOKEN_CACHE_KEY, pushToken).catch(() => {});

    if (__DEV__) console.log('[Notifications] Push token:', pushToken.substring(0, 30) + '...');

    // Configure Android notification channel
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('price-alerts', {
        name: 'Price Alerts',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FFD700',
        sound: 'default',
      });
    }

    return pushToken;
  } catch (error: any) {
    if (__DEV__) {
      console.error('[Notifications] Failed to get push token:', error);
    }
    return null;
  }
}

export async function getNotificationDeviceId(): Promise<string | null> {
  try {
    if (Platform.OS === 'android') {
      const id = await Application.getAndroidId();
      return id || null;
    }
    if (Platform.OS === 'ios') {
      const id = await Application.getIosIdForVendorAsync();
      return id || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Register the push token with the backend.
 */
export async function registerPushTokenWithBackend(
  pushToken: string,
  accessToken: string,
  deviceId?: string,
  walletAddress?: string
): Promise<boolean> {
  try {
    const payload: Record<string, string | undefined> = {
      push_token: pushToken,
      device_id: deviceId,
      platform: Platform.OS,
    };
    if (walletAddress) {
      payload.wallet_address = walletAddress;
    }
    const response = await fetch(`${API_BASE_URL}/push/register-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Notifications] Failed to register token with backend:', error);
      return false;
    }

    console.log('[Notifications] Token registered with backend');
    return true;
  } catch (error) {
    console.error('[Notifications] Failed to register token with backend:', error);
    return false;
  }
}

/**
 * Unregister the push token from the backend (e.g., on logout).
 */
export async function unregisterPushToken(
  pushToken: string,
  accessToken: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/push/unregister-token?push_token=${encodeURIComponent(pushToken)}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      console.error('[Notifications] Failed to unregister token');
      return false;
    }

    console.log('[Notifications] Token unregistered');
    return true;
  } catch (error) {
    console.error('[Notifications] Failed to unregister token:', error);
    return false;
  }
}

// ============================================================================
// Price Alerts API
// ============================================================================

/**
 * Create a new price alert.
 */
export async function createPriceAlert(
  params: CreateAlertParams,
  accessToken: string
): Promise<PriceAlert | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to create alert');
    }

    const data = await response.json();
    return data.alert;
  } catch (error) {
    if (__DEV__) {
      console.log('[Alerts] Failed to create alert:', error);
    }
    throw error;
  }
}

/**
 * Get all alerts for the current user.
 */
export async function getUserAlerts(
  accessToken: string,
  activeOnly: boolean = false
): Promise<PriceAlert[]> {
  try {
    const url = `${API_BASE_URL}/alerts${activeOnly ? '?active_only=true' : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch alerts');
    }

    const data = await response.json();
    return data.alerts || [];
  } catch (error) {
    console.error('[Alerts] Failed to fetch alerts:', error);
    return [];
  }
}

/**
 * Update an existing price alert.
 */
export async function updatePriceAlert(
  alertId: string,
  params: UpdateAlertParams,
  accessToken: string
): Promise<PriceAlert | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/alerts/${alertId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to update alert');
    }

    const data = await response.json();
    return data.alert;
  } catch (error) {
    console.error('[Alerts] Failed to update alert:', error);
    throw error;
  }
}

/**
 * Delete a price alert.
 */
export async function deletePriceAlert(
  alertId: string,
  accessToken: string
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/alerts/${alertId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to delete alert');
    }

    return true;
  } catch (error) {
    console.error('[Alerts] Failed to delete alert:', error);
    return false;
  }
}

/**
 * Get triggered alert history.
 */
export async function getAlertHistory(
  accessToken: string,
  limit: number = 50
): Promise<AlertHistory[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/alerts/history?limit=${limit}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch alert history');
    }

    const data = await response.json();
    return data.history || [];
  } catch (error) {
    console.error('[Alerts] Failed to fetch alert history:', error);
    return [];
  }
}

// ============================================================================
// Notification Preferences API
// ============================================================================

/**
 * Get user's notification preferences.
 */
export async function getNotificationPreferences(
  accessToken: string
): Promise<NotificationPreferences> {
  try {
    const response = await fetch(`${API_BASE_URL}/notifications/preferences`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch notification preferences');
    }

    const data = await response.json();
    return data.preferences;
  } catch (error) {
    console.error('[Notifications] Failed to fetch preferences:', error);
    throw error;
  }
}

/**
 * Update user's notification preferences.
 */
export async function updateNotificationPreferences(
  accessToken: string,
  preferences: {
    push_enabled?: boolean;
    system_alerts_enabled?: boolean;
    ur_transaction_alerts_enabled?: boolean;
    ur_card_alerts_enabled?: boolean;
    ur_kyc_alerts_enabled?: boolean;
  }
): Promise<NotificationPreferences | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/notifications/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(preferences),
    });

    if (!response.ok) {
      throw new Error('Failed to update notification preferences');
    }

    const data = await response.json();
    const prefs = (data.preferences ?? {}) as NotificationPreferences;
    if (typeof preferences.push_enabled === 'boolean') {
      prefs.push_enabled = preferences.push_enabled;
    }
    return prefs;
  } catch (error) {
    console.error('[Notifications] Failed to update preferences:', error);
    throw error;
  }
}

// ============================================================================
// Notification Listeners
// ============================================================================

/**
 * Add a listener for when a notification is received while the app is foregrounded.
 */
export function addNotificationReceivedListener(
  callback: (notification: Notifications.Notification) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationReceivedListener(callback);
}

/**
 * Add a listener for when the user interacts with a notification.
 */
export function addNotificationResponseListener(
  callback: (response: Notifications.NotificationResponse) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(callback);
}

/**
 * Get the last notification response (if app was opened via notification).
 */
export async function getLastNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return Notifications.getLastNotificationResponseAsync();
}

/**
 * Clear the app badge count.
 */
export async function clearBadgeCount(): Promise<void> {
  await Notifications.setBadgeCountAsync(0);
}

/**
 * Check if notifications are enabled.
 */
export async function areNotificationsEnabled(): Promise<boolean> {
  const settings = await Notifications.getPermissionsAsync();
  return settings.status === 'granted';
}
