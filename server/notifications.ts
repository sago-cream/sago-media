import { config } from "./config";

export type AccessRequestNotification = {
  githubLogin: string;
  deviceName: string;
  reviewUrl: string;
};

type NotificationSettings = {
  url: string;
  secret: string;
};

const defaultSettings: NotificationSettings = {
  url: config.accessNotificationUrl,
  secret: config.accessNotificationSecret,
};

export async function notifyAccessRequest(
  notification: AccessRequestNotification,
  settings = defaultSettings,
  fetcher: typeof fetch = fetch,
) {
  if (!settings.url || !settings.secret) return false;

  try {
    const response = await fetcher(settings.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`.trim());
    }
    return true;
  } catch (error) {
    console.error("Could not send access request notification:", error);
    return false;
  }
}
